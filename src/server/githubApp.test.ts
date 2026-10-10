import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import { configFromEnv } from './config.ts'
import { appJwt, parseSettings } from './githubApp.ts'
import { createGitHubStub, type StubOptions } from '../../fixture/github-stub.ts'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

const cleanups: (() => void)[] = []
after(() => cleanups.forEach((c) => c()))

/** App mode only, or app + token mode when `token` is set. */
async function boot(stubOpts: Omit<StubOptions, 'appPublicKey'>, token = false) {
  const gh = createGitHubStub({ appPublicKey: publicKey, branchExists: true, ...stubOpts })
  const apiUrl = await gh.listen()
  const config = configFromEnv({
    GITHUB_APP_ID: '7',
    GITHUB_APP_SLUG: 'report-button',
    // As a single-line env var, the way most hosts store it.
    GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
    GITHUB_API_URL: apiUrl,
    RATE_LIMIT: '0',
    ...(token ? { GITHUB_TOKEN: 'pat', GITHUB_REPO: 'acme/app' } : {}),
  })
  const app = createApp({ config, log: () => {} })
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
  cleanups.push(() => {
    app.close()
    void gh.close()
  })
  return { gh, base }
}

const report = (repo: string | undefined, origin = 'https://site.example.com', base = '') =>
  fetch(`${base}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ repo, note: 'Broken', image: PNG, reportId: 'r1', reportedAt: '2026-10-09T10:00:00.000Z' }),
  })

const status = async (base: string, repo: string, origin = 'https://site.example.com') =>
  (await (await fetch(`${base}/status?repo=${repo}`, { headers: { Origin: origin } })).json()) as {
    connected: boolean
    setupUrl: string
  }

// ---------------------------------------------------------------------------

test('parseSettings reads the keys report-button uses', () => {
  const s = parseSettings(
    ['# comment', 'origins:', '  - https://a.example.com/  # trailing', "  - 'https://b.example.com'", 'labels: [bug, "user-report"]', 'assignees: octocat, hubot'].join('\n'),
  )
  assert.deepEqual(s, {
    origins: ['https://a.example.com', 'https://b.example.com'],
    labels: ['bug', 'user-report'],
    assignees: ['octocat', 'hubot'],
  })
  assert.deepEqual(parseSettings(''), { origins: [], labels: undefined, assignees: [] })
})

test('appJwt is an RS256 token GitHub will accept for ten minutes at most', () => {
  const [head, body] = appJwt({ appId: '7', privateKey }, 1_000_000_000_000).split('.')
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' })
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString())
  assert.equal(claims.iss, '7')
  assert.ok(claims.exp - claims.iat <= 600)
})

test('files into a repo the app is installed on, with the installation token', async () => {
  const { gh, base } = await boot({ installations: { 'acme/site': 42 } })
  const res = await report('acme/site', undefined, base)
  assert.equal(res.status, 201)
  const issueCall = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/acme/site/issues')
  assert.ok(issueCall)
  assert.equal(issueCall.auth, 'ghs_installation_42')
  assert.ok(gh.calls.some((c) => c.method === 'POST' && c.path === '/repos/acme/site/git/blobs'))
  assert.deepEqual(gh.issues[0].labels, ['user-report'])

  // The installation token is reused rather than minted per report.
  await report('acme/site', undefined, base)
  assert.equal(gh.calls.filter((c) => c.path.endsWith('/access_tokens')).length, 1)
})

test('refuses repos the app is not installed on, and says so in /status', async () => {
  const { gh, base } = await boot({ installations: {} })
  const res = await report('acme/other', undefined, base)
  assert.equal(res.status, 404)
  assert.match(((await res.json()) as { error: string }).error, /not installed on acme\/other/)
  assert.equal(gh.issues.length, 0)

  const s = await status(base, 'acme/other')
  assert.equal(s.connected, false)
  const setup = new URL(s.setupUrl)
  assert.equal(setup.pathname, '/setup')
  assert.equal(setup.searchParams.get('repo'), 'acme/other')
  assert.equal(setup.searchParams.get('origin'), 'https://site.example.com')

  const page = await (await fetch(s.setupUrl)).text()
  assert.match(page, /https:\/\/github\.com\/apps\/report-button\/installations\/new/)
})

test('.github/report-button.yml locks a repo to its origins and sets labels', async () => {
  const { gh, base } = await boot({
    installations: { 'acme/site': 42 },
    files: { 'acme/site:.github/report-button.yml': 'origins:\n  - https://site.example.com\nlabels: [bug]\nassignees: octocat\n' },
  })
  assert.equal((await report('acme/site', 'https://evil.example.com', base)).status, 403)
  assert.equal((await status(base, 'acme/site', 'https://evil.example.com')).connected, false)
  assert.equal((await status(base, 'acme/site')).connected, true)

  assert.equal((await report('acme/site', 'https://site.example.com', base)).status, 201)
  assert.deepEqual(gh.issues[0].labels, ['bug'])
  assert.deepEqual(gh.issues[0].assignees, ['octocat'])
})

test('token mode and app mode side by side: the token repo, then installed repos', async () => {
  const { gh, base } = await boot({ installations: { 'acme/site': 42 } }, true)
  assert.equal((await report(undefined, undefined, base)).status, 201)
  assert.equal((await report('acme/app', undefined, base)).status, 201)
  assert.equal((await report('acme/site', undefined, base)).status, 201)
  assert.deepEqual(
    gh.calls.filter((c) => c.path.endsWith('/issues')).map((c) => `${c.path} ${c.auth}`),
    ['/repos/acme/app/issues pat', '/repos/acme/app/issues pat', '/repos/acme/site/issues ghs_installation_42'],
  )
  assert.equal((await status(base, 'acme/app')).connected, true)
})

test('rejects calls signed with the wrong key', async () => {
  const gh = createGitHubStub({ appPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(), installations: { 'a/b': 1 } })
  const apiUrl = await gh.listen()
  cleanups.push(() => void gh.close())
  const res = await fetch(`${apiUrl}/repos/a/b/installation`, { headers: { Authorization: `Bearer ${appJwt({ appId: '7', privateKey })}` } })
  assert.equal(res.status, 401)
})
