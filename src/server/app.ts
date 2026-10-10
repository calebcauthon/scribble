import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { repoShape, type Config, type GitHubConfig } from './config.ts'
import { GitHubError, createIssue, uploadAsset } from './github.ts'
import { GitHubApp, originAllowed } from './githubApp.ts'
import { assetPath, buildIssue, type Report } from './issue.ts'
import { renderAppCreated, renderRegisterApp, renderSetup, type SetupState } from './setup.ts'

export interface AppOptions {
  config: Config
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Directory the built client bundle and demo page are read from. */
  staticDir?: URL
  log?: (line: string) => void
}

const MAX_BODY_BYTES = 30 * 1024 * 1024
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (declared > limit) return reject(new HttpError(413, 'payload too large'))
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, 'payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for']
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]
  return first?.trim() || req.socket.remoteAddress || 'unknown'
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** Turn the untrusted JSON body into a Report, or throw a 400. */
export function parseReport(raw: unknown, maxImageBytes: number): Report {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'body must be a JSON object')
  const b = raw as Record<string, unknown>

  const m = typeof b.image === 'string' ? DATA_URL.exec(b.image) : null
  if (!m) throw new HttpError(400, 'image must be a png, jpeg or webp data URL')
  const bytes = Buffer.from(m[2].replace(/\s/g, ''), 'base64')
  if (bytes.length === 0) throw new HttpError(400, 'image is empty')
  if (bytes.length > maxImageBytes) throw new HttpError(413, `image too large (max ${maxImageBytes} bytes)`)

  const reportId = str(b.reportId, 64).replace(/[^\w-]/g, '')
  const reportedAt = (() => {
    const d = new Date(str(b.reportedAt, 40))
    return Number.isNaN(d.getTime()) ? new Date() : d
  })()

  const context: Record<string, string> = {}
  if (b.context && typeof b.context === 'object') {
    for (const [k, v] of Object.entries(b.context as Record<string, unknown>).slice(0, 50)) {
      if (v === undefined || v === null) continue
      context[k.slice(0, 80)] = String(v).slice(0, 2000)
    }
  }

  const vp = b.viewport as Record<string, unknown> | undefined
  const viewport =
    vp && typeof vp === 'object' && Number.isFinite(Number(vp.width)) && Number.isFinite(Number(vp.height))
      ? { width: Math.round(Number(vp.width)), height: Math.round(Number(vp.height)), dpr: Number(vp.dpr) || 1 }
      : undefined

  return {
    reportId: reportId || crypto.randomUUID(),
    note: str(b.note, 5000),
    pageUrl: str(b.pageUrl, 2000),
    image: { bytes, mime: m[1] as Report['image']['mime'] },
    viewport,
    userAgent: str(b.userAgent, 500) || undefined,
    language: str(b.language, 20) || undefined,
    reportedAt: reportedAt.toISOString(),
    context,
  }
}

// ---------------------------------------------------------------------------
// Rate limiting: a sliding window per IP, in memory. Enough to stop one browser
// from spamming issues; put a real limiter in front for anything bigger.
// ---------------------------------------------------------------------------

class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number
  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit
    this.windowMs = windowMs
  }

  allow(key: string, now = Date.now()): boolean {
    if (this.limit <= 0) return true
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > 10_000) this.sweep(now)
    return true
  }

  private sweep(now: number) {
    for (const [k, ts] of this.hits) {
      if (ts.every((t) => now - t >= this.windowMs)) this.hits.delete(k)
    }
  }
}

// ---------------------------------------------------------------------------

export function createApp(opts: AppOptions): Server {
  const { config } = opts
  const fetchImpl = opts.fetchImpl ?? fetch
  const log = opts.log ?? ((line: string) => console.log(line))
  const staticDir = opts.staticDir ?? new URL('./', import.meta.url)
  const limiter = new RateLimiter(config.rateLimit)
  const allowAny = config.allowedOrigins.includes('*')
  const app = config.app ? new GitHubApp(config.app, fetchImpl) : null
  const webUrl = config.github?.webUrl ?? config.app?.webUrl ?? 'https://github.com'

  // Reports carry no credentials, so `*` is safe; which origins may file into which
  // repo is decided per request by resolveTarget().
  const cors = (res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Max-Age', '86400')
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const html = (res: ServerResponse, status: number, page: string) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(page)
  }

  const baseUrl = (req: IncomingMessage) => {
    if (config.publicUrl) return config.publicUrl
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || 'http'
    return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost'}`
  }

  const isTokenRepo = (repo: string | undefined) =>
    !!config.github && (!repo || repo.toLowerCase() === config.github.repo.toLowerCase())

  /**
   * Where a report for `repo` from `origin` goes. Token mode answers for its one repo
   * (and for reports that name no repo); app mode for any repo the app is installed on.
   */
  const resolveTarget = async (repo: string | undefined, origin: string | undefined): Promise<GitHubConfig> => {
    if (repo !== undefined && !repoShape.test(repo)) throw new HttpError(400, 'repo must look like owner/name')
    if (isTokenRepo(repo)) {
      if (origin && !allowAny && !config.allowedOrigins.includes(origin)) throw new HttpError(403, 'origin not allowed')
      return config.github!
    }
    if (!repo) throw new HttpError(400, 'repo is required')
    if (!app) throw new HttpError(404, `this server only files issues for ${config.github?.repo}`)
    const target = await app.target(repo)
    if (!target) throw new HttpError(404, `report-button is not installed on ${repo}`)
    if (!originAllowed(target.settings, origin)) throw new HttpError(403, `origin not allowed by ${repo}`)
    return target.github
  }

  /** What the setup page and /status report about a repo + origin. */
  const inspect = async (repo: string, origin: string | undefined): Promise<SetupState> => {
    const state: SetupState = { repo, origin, webUrl, appConfigured: !!app, tokenRepo: config.github?.repo }
    if (!repoShape.test(repo)) return state
    if (isTokenRepo(repo)) {
      state.connected = !origin || allowAny || config.allowedOrigins.includes(origin)
      return state
    }
    if (!app) return state
    state.installUrl = app.installUrl
    const token = await app.tokenFor(repo)
    state.installed = !!token
    if (!token) return state
    const settings = await app.settingsFor(repo, token)
    state.origins = settings.origins
    state.originAllowed = originAllowed(settings, origin)
    state.connected = state.originAllowed
    state.defaultBranch = await app.defaultBranch(repo, token).catch(() => 'main')
    return state
  }

  const serveFile = async (res: ServerResponse, name: string, type: string) => {
    try {
      const data = await readFile(new URL(name, staticDir))
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' })
      res.end(data)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end(`${name} not found; run \`npm run build\``)
    }
  }

  const handleReport = async (req: IncomingMessage, res: ServerResponse) => {
    const ip = clientIp(req)
    if (!limiter.allow(ip)) throw new HttpError(429, 'too many reports, try again in a minute')

    const body = await readBody(req, MAX_BODY_BYTES)
    let raw: unknown
    try {
      raw = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, 'body must be JSON')
    }
    const report = parseReport(raw, config.maxImageBytes)
    const repoField = (raw as Record<string, unknown>).repo
    const github = await resolveTarget(typeof repoField === 'string' && repoField ? repoField : undefined, req.headers.origin)

    const path = assetPath(report)
    const asset = await uploadAsset(
      github,
      path,
      report.image.bytes,
      `Screenshot for report ${report.reportId}`,
      fetchImpl,
    )
    const issue = await createIssue(github, buildIssue(report, asset.url), fetchImpl)
    log(`report ${report.reportId} from ${ip} -> ${issue.html_url}`)
    json(res, 201, { issueUrl: issue.html_url, issueNumber: issue.number, reportId: report.reportId })
  }

  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = `${req.method} ${url.pathname}`

    void (async () => {
      try {
        if (route === 'GET /health') return json(res, 200, { ok: true })
        if (route === 'GET /report-button.js') return serveFile(res, 'report-button.js', 'application/javascript; charset=utf-8')
        if (route === 'GET /demo' || route === 'GET /demo/') return serveFile(res, 'demo.html', 'text/html; charset=utf-8')
        if (route === 'GET /') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end('report-button server. POST /report, GET /status, GET /setup, GET /report-button.js, GET /demo, GET /health\n')
        }

        if (route === 'GET /setup') {
          const repo = url.searchParams.get('repo')?.trim() ?? ''
          const origin = url.searchParams.get('origin')?.trim() || undefined
          const state = repo ? await inspect(repo, origin) : { repo, origin, webUrl, appConfigured: !!app, tokenRepo: config.github?.repo }
          return html(res, 200, renderSetup({ ...state, installedJustNow: url.searchParams.get('setup_action') === 'install' }))
        }
        // One-time registration of the GitHub App via GitHub's manifest flow. Off once
        // the app is configured, since the callback page shows its private key.
        if (route === 'GET /setup/app' && !app) return html(res, 200, renderRegisterApp(baseUrl(req), webUrl))
        if (route === 'GET /setup/app/callback' && !app) {
          const code = url.searchParams.get('code') ?? ''
          if (!/^[\w-]+$/.test(code)) throw new HttpError(400, 'missing code')
          const apiUrl = config.github?.apiUrl ?? 'https://api.github.com'
          const created = await fetchImpl(`${apiUrl}/app-manifests/${code}/conversions`, {
            method: 'POST',
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'report-button' },
          })
          if (!created.ok) throw new HttpError(502, `GitHub answered ${created.status} converting the manifest code`)
          return html(res, 200, renderAppCreated((await created.json()) as { id: number; slug: string; pem: string; html_url: string }))
        }

        if (url.pathname === '/status') {
          cors(res)
          if (req.method === 'OPTIONS') {
            res.writeHead(204)
            return res.end()
          }
          if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
          const repo = url.searchParams.get('repo')?.trim() ?? ''
          const origin = req.headers.origin
          const state = await inspect(repo, origin)
          const setup = new URL('/setup', baseUrl(req))
          setup.searchParams.set('repo', repo)
          if (origin) setup.searchParams.set('origin', origin)
          return json(res, 200, { connected: !!state.connected, setupUrl: setup.href })
        }

        if (url.pathname === '/report') {
          cors(res)
          if (req.method === 'OPTIONS') {
            res.writeHead(204)
            return res.end()
          }
          if (req.method === 'POST') return await handleReport(req, res)
          throw new HttpError(405, 'method not allowed')
        }

        throw new HttpError(404, 'not found')
      } catch (e) {
        if (e instanceof HttpError) return json(res, e.status, { error: e.message })
        if (e instanceof GitHubError) {
          log(`github error: ${e.message}`)
          // Auth and permission problems are configuration, not the reporter's fault,
          // but say so plainly in the response so a 502 is debuggable from the browser.
          return json(res, 502, { error: `GitHub rejected the report: ${e.message}` })
        }
        log(`unhandled error: ${(e as Error)?.stack ?? e}`)
        return json(res, 500, { error: 'internal error' })
      }
    })()
  })
}
