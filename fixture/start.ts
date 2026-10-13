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
 * A busy port moves to the next free one, unless PORT / FIXTURE_GITHUB_PORT name it
 * explicitly (as the Playwright config does), in which case it fails instead.
 *
 * Playwright's e2e tests use this as their web server.
 */
import { generateKeyPairSync } from 'node:crypto'
import type { Server } from 'node:http'
import { createGitHubStub } from './github-stub.ts'
import { createApp } from '../src/server/app.ts'
import { configFromEnv } from '../src/server/config.ts'

/** Listen on `port`, or the next free one above it when `strict` is false. */
async function listenFrom(listen: (port: number) => Promise<unknown>, port: number, strict: boolean): Promise<number> {
  for (let p = port; p < port + 50; p++) {
    try {
      await listen(p)
      if (p !== port) console.log(`port ${port} is taken, using ${p}`)
      return p
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || strict) throw e
    }
  }
  throw new Error(`no free port in ${port}-${port + 49}`)
}

const listenServer = (server: Server, host?: string) => (port: number) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const stub = createGitHubStub({
  appPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  installations: { 'acme/connected': 42 },
})
await listenFrom((p) => stub.listen(p, '0.0.0.0'), Number(process.env.FIXTURE_GITHUB_PORT) || 8790, !!process.env.FIXTURE_GITHUB_PORT)
const stubUrl = stub.url

const config = configFromEnv({
  GITHUB_TOKEN: 'fixture-token',
  GITHUB_REPO: 'acme/app',
  GITHUB_APP_ID: '1',
  GITHUB_APP_SLUG: 'report-button-fixture',
  GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  GITHUB_API_URL: stubUrl,
  GITHUB_WEB_URL: stubUrl,
  RATE_LIMIT: '0',
})

const app = createApp({
  config,
  staticDir: new URL('../dist/', import.meta.url),
  log: (line) => console.log(`[app] ${line}`),
})
const appPort = await listenFrom(listenServer(app), Number(process.env.PORT) || 8787, !!process.env.PORT)
console.log(`demo page   http://localhost:${appPort}/demo`)
console.log(`CDN test    http://localhost:${appPort}/demo/cdn`)
console.log(`fake GitHub ${stubUrl}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close()
    void stub.close().then(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
