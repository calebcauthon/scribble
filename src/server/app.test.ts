import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createApp, parseReport } from './app.ts'
import type { Config } from './config.ts'
import { createGitHubStub, type StubOptions } from '../../fixture/github-stub.ts'

// A 1x1 PNG, enough to exercise the image path end to end.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function configFor(apiUrl: string, extra: Partial<Config> = {}): Config {
  return {
    port: 0,
    github: {
      token: 't',
      apiUrl,
      webUrl: 'https://github.com',
      repo: 'acme/app',
      assetRepo: 'acme/app',
      assetBranch: 'report-screenshots',
      labels: ['user-report'],
      assignees: [],
    },
    allowedOrigins: ['*'],
    rateLimit: 0,
    maxImageBytes: 1024 * 1024,
    ...extra,
  }
}

const cleanups: (() => void)[] = []
after(() => cleanups.forEach((c) => c()))

async function boot(stubOpts: StubOptions, extra: Partial<Config> = {}) {
  const gh = createGitHubStub(stubOpts)
  const apiUrl = await gh.listen()
  const app = createApp({ config: configFor(apiUrl, extra), log: () => {} })
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
  cleanups.push(() => {
    app.close()
    void gh.close()
  })
  return { gh, base }
}

const payload = (over: Record<string, unknown> = {}) => ({
  reportId: 'abc-123',
  note: 'Button is dead',
  pageUrl: 'https://app.example.com/x',
  image: PNG,
  viewport: { width: 800, height: 600, dpr: 1 },
  userAgent: 'UA',
  language: 'en',
  reportedAt: '2026-10-09T10:00:00.000Z',
  context: { User: 'u1' },
  ...over,
})

// ---------------------------------------------------------------------------

test('files an issue with the screenshot committed to the asset branch', async () => {
  const { gh, base } = await boot({ branchExists: true })

  const res = await fetch(`${base}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.example.com' },
    body: JSON.stringify(payload()),
  })
  assert.equal(res.status, 201)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await res.json(), {
    issueUrl: `${gh.url}/acme/app/issues/1`,
    issueNumber: 1,
    reportId: 'abc-123',
  })

  assert.deepEqual(
    gh.calls.map((c) => `${c.method} ${c.path}`),
    [
      'GET /repos/acme/app/git/ref/heads/report-screenshots',
      'GET /repos/acme/app/git/commits/parent-sha',
      'POST /repos/acme/app/git/blobs',
      'POST /repos/acme/app/git/trees',
      'POST /repos/acme/app/git/commits',
      'PATCH /repos/acme/app/git/refs/heads/report-screenshots',
      'POST /repos/acme/app/issues',
    ],
  )
  const tree = gh.calls[3].body as { base_tree: string; tree: { path: string }[] }
  assert.equal(tree.base_tree, 'tree-of-parent-sha')
  assert.equal(tree.tree[0].path, '2026-10-09/abc-123.png')
  const commit = gh.calls[4].body as { parents: string[] }
  assert.deepEqual(commit.parents, ['parent-sha'])

  // The bytes that landed on the branch are the decoded data URL.
  const asset = gh.assets.get('2026-10-09/abc-123.png')
  assert.ok(asset)
  assert.equal(asset.bytes.toString('base64'), PNG.split(',')[1])

  const issue = gh.issues[0]
  assert.equal(issue.title, 'Button is dead')
  assert.deepEqual(issue.labels, ['user-report'])
  assert.match(
    issue.body,
    /!\[Annotated screenshot\]\(https:\/\/github\.com\/acme\/app\/blob\/report-screenshots\/2026-10-09\/abc-123\.png\?raw=true\)/,
  )
  assert.match(issue.body, /\| \*\*User\*\* \| u1 \|/)
})

test('creates the asset branch as an orphan when it does not exist yet', async () => {
  const { gh, base } = await boot({ branchExists: false })
  const res = await fetch(`${base}/report`, { method: 'POST', body: JSON.stringify(payload()) })
  assert.equal(res.status, 201)
  const methods = gh.calls.map((c) => `${c.method} ${c.path}`)
  assert.ok(!methods.some((m) => m.includes('/git/commits/parent-sha')))
  const tree = gh.calls.find((c) => c.path.endsWith('/git/trees'))!.body as Record<string, unknown>
  assert.equal('base_tree' in tree, false)
  const commit = gh.calls.find((c) => c.path.endsWith('/git/commits'))!.body as { parents: string[] }
  assert.deepEqual(commit.parents, [])
  assert.ok(methods.includes('POST /repos/acme/app/git/refs'))

  // A second report then fast-forwards the branch instead of recreating it.
  gh.calls.length = 0
  await fetch(`${base}/report`, { method: 'POST', body: JSON.stringify(payload({ reportId: 'def-456' })) })
  assert.ok(gh.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/git/refs/heads/report-screenshots')))
  assert.equal(gh.issues.length, 2)
})

test('rejects bad payloads with 400 and a reason', async () => {
  const { base } = await boot({ branchExists: true })
  const post = (body: string) => fetch(`${base}/report`, { method: 'POST', body })
  assert.equal((await post('not json')).status, 400)
  const noImage = await post(JSON.stringify(payload({ image: 'data:text/plain;base64,aGk=' })))
  assert.equal(noImage.status, 400)
  assert.match(((await noImage.json()) as { error: string }).error, /png, jpeg or webp/)
})

test('refuses origins that are not allowed', async () => {
  const { base } = await boot({ branchExists: true }, { allowedOrigins: ['https://ok.example.com'] })
  const bad = await fetch(`${base}/report`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example.com' },
    body: JSON.stringify(payload()),
  })
  assert.equal(bad.status, 403)
  const preflight = await fetch(`${base}/report`, { method: 'OPTIONS', headers: { Origin: 'https://ok.example.com' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://ok.example.com')
})

test('rate limits per client ip', async () => {
  const { base } = await boot({ branchExists: true }, { rateLimit: 2 })
  const send = () => fetch(`${base}/report`, { method: 'POST', body: JSON.stringify(payload()) })
  assert.equal((await send()).status, 201)
  assert.equal((await send()).status, 201)
  assert.equal((await send()).status, 429)
})

test('surfaces GitHub failures as 502 with the message', async () => {
  const { base } = await boot({ branchExists: true, failIssue: true })
  const res = await fetch(`${base}/report`, { method: 'POST', body: JSON.stringify(payload()) })
  assert.equal(res.status, 502)
  assert.match(((await res.json()) as { error: string }).error, /Resource not accessible/)
})

test('parseReport bounds and sanitises fields', () => {
  const r = parseReport(
    payload({ reportId: '../etc/passwd', note: 'x'.repeat(9000), context: { a: null, b: 1, c: true } }),
    1024 * 1024,
  )
  assert.equal(r.reportId, 'etcpasswd')
  assert.equal(r.note.length, 5000)
  assert.deepEqual(r.context, { b: '1', c: 'true' })
  assert.equal(r.image.mime, 'image/png')
  assert.throws(() => parseReport(payload(), 10), /too large/)
})
