/**
 * Boot the whole thing locally with no GitHub token: the fake GitHub on one port,
 * the real report-button server pointed at it on another, in both modes at once:
 *
 *   acme/app        token mode
 *   acme/connected  GitHub App installed
 *   anything else   not connected, so the button falls back to opening GitHub
 *
 *   npm run fixture
 *   open http://localhost:8787/demo      # the page with the button
 *   open http://localhost:8790           # the fake GitHub, to see what got filed
 *
 * Playwright's e2e tests use this as their web server.
 */
import { generateKeyPairSync } from 'node:crypto'
import { createGitHubStub } from './github-stub.ts'
import { createApp } from '../src/server/app.ts'
import { configFromEnv } from '../src/server/config.ts'

const appPort = Number(process.env.PORT) || 8787
const stubPort = Number(process.env.FIXTURE_GITHUB_PORT) || 8790

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const stub = createGitHubStub({
  appPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  installations: { 'acme/connected': 42 },
})
const stubUrl = await stub.listen(stubPort, '0.0.0.0')

const config = configFromEnv({
  GITHUB_TOKEN: 'fixture-token',
  GITHUB_REPO: 'acme/app',
  GITHUB_APP_ID: '1',
  GITHUB_APP_SLUG: 'report-button-fixture',
  GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  GITHUB_API_URL: stubUrl,
  GITHUB_WEB_URL: stubUrl,
  RATE_LIMIT: '0',
  PORT: String(appPort),
})

const app = createApp({
  config,
  staticDir: new URL('../dist/', import.meta.url),
  log: (line) => console.log(`[app] ${line}`),
})
app.listen(appPort, () => {
  console.log(`demo page   http://localhost:${appPort}/demo`)
  console.log(`fake GitHub ${stubUrl}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close()
    void stub.close().then(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
