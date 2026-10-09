import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { createApp, parseReport } from './app.ts'
import type { Config } from './config.ts'

// A 1x1 PNG, enough to exercise the image path end to end.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// ---------------------------------------------------------------------------
// A stub of the slice of GitHub's API the server talks to.
// ---------------------------------------------------------------------------

interface Call {
  method: string
  path: string
  body: unknown
}

function stubGitHub(opts: { branchExists: boolean; failIssue?: boolean }) {
  const calls: Call[] = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      const body = data ? JSON.parse(data) : undefined
      const path = req.url ?? ''
      calls.push({ method: req.method ?? '', path, body })
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (path.endsWith('/git/ref/heads/report-screenshots')) {
        return opts.branchExists ? reply(200, { object: { sha: 'parent-sha' } }) : reply(404, { message: 'Not Found' })
      }
      if (path.includes('/git/commits/parent-sha')) return reply(200, { tree: { sha: 'base-tree' } })
      if (path.endsWith('/git/blobs')) return reply(201, { sha: 'blob-sha' })
      if (path.endsWith('/git/trees')) return reply(201, { sha: 'tree-sha' })
      if (path.endsWith('/git/commits')) return reply(201, { sha: 'new-commit' })
      if (path.endsWith('/git/refs') || path.includes('/git/refs/heads/')) return reply(201, { ref: 'ok' })
      if (path.endsWith('/issues')) {
        if (opts.failIssue) return reply(403, { message: 'Resource not accessible by personal access token' })
        return reply(201, { number: 7, html_url: 'https://github.com/acme/app/issues/7' })
      }
      reply(404, { message: `unexpected ${path}` })
    })
  })
  return { server, calls }
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

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

const servers: ReturnType<typeof createServer>[] = []
after(() => servers.forEach((s) => s.close()))

async function boot(gh: ReturnType<typeof stubGitHub>, extra: Partial<Config> = {}) {
  const apiUrl = await listen(gh.server)
  const app = createApp({ config: configFor(apiUrl, extra), log: () => {} })
  const base = await listen(app)
  servers.push(gh.server, app)
  return base
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
  const gh = stubGitHub({ branchExists: true })
  const base = await boot(gh)

  const res = await fetch(`${base}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.example.com' },
    body: JSON.stringify(payload()),
  })
  assert.equal(res.status, 201)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await res.json(), {
    issueUrl: 'https://github.com/acme/app/issues/7',
    issueNumber: 7,
    reportId: 'abc-123',
  })

  const methods = gh.calls.map((c) => `${c.method} ${c.path}`)
  assert.deepEqual(methods, [
    'GET /repos/acme/app/git/ref/heads/report-screenshots',
    'GET /repos/acme/app/git/commits/parent-sha',
    'POST /repos/acme/app/git/blobs',
    'POST /repos/acme/app/git/trees',
    'POST /repos/acme/app/git/commits',
    'PATCH /repos/acme/app/git/refs/heads/report-screenshots',
    'POST /repos/acme/app/issues',
  ])
  const tree = gh.calls[3].body as { base_tree: string; tree: { path: string }[] }
  assert.equal(tree.base_tree, 'base-tree')
  assert.equal(tree.tree[0].path, '2026-10-09/abc-123.png')
  const commit = gh.calls[4].body as { parents: string[] }
  assert.deepEqual(commit.parents, ['parent-sha'])

  const issue = gh.calls[6].body as { title: string; body: string; labels: string[] }
  assert.equal(issue.title, 'Button is dead')
  assert.deepEqual(issue.labels, ['user-report'])
  assert.match(issue.body, /!\[Annotated screenshot\]\(https:\/\/github\.com\/acme\/app\/blob\/report-screenshots\/2026-10-09\/abc-123\.png\?raw=true\)/)
  assert.match(issue.body, /\| \*\*User\*\* \| u1 \|/)
})

test('creates the asset branch as an orphan when it does not exist yet', async () => {
  const gh = stubGitHub({ branchExists: false })
  const base = await boot(gh)
  const res = await fetch(`${base}/report`, { method: 'POST', body: JSON.stringify(payload()) })
  assert.equal(res.status, 201)
  const methods = gh.calls.map((c) => `${c.method} ${c.path}`)
  assert.ok(!methods.includes('GET /repos/acme/app/git/commits/parent-sha'))
  const tree = gh.calls.find((c) => c.path.endsWith('/git/trees'))!.body as Record<string, unknown>
  assert.equal('base_tree' in tree, false)
  const commit = gh.calls.find((c) => c.path.endsWith('/git/commits'))!.body as { parents: string[] }
  assert.deepEqual(commit.parents, [])
  assert.ok(methods.includes('POST /repos/acme/app/git/refs'))
})

test('rejects bad payloads with 400 and a reason', async () => {
  const base = await boot(stubGitHub({ branchExists: true }))
  const post = (body: string) => fetch(`${base}/report`, { method: 'POST', body })
  assert.equal((await post('not json')).status, 400)
  const noImage = await post(JSON.stringify(payload({ image: 'data:text/plain;base64,aGk=' })))
  assert.equal(noImage.status, 400)
  assert.match(((await noImage.json()) as { error: string }).error, /png, jpeg or webp/)
})

test('refuses origins that are not allowed', async () => {
  const base = await boot(stubGitHub({ branchExists: true }), { allowedOrigins: ['https://ok.example.com'] })
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
  const base = await boot(stubGitHub({ branchExists: true }), { rateLimit: 2 })
  const send = () => fetch(`${base}/report`, { method: 'POST', body: JSON.stringify(payload()) })
  assert.equal((await send()).status, 201)
  assert.equal((await send()).status, 201)
  assert.equal((await send()).status, 429)
})

test('surfaces GitHub failures as 502 with the message', async () => {
  const base = await boot(stubGitHub({ branchExists: true, failIssue: true }))
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
