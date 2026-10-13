/**
 * An in-memory stand-in for the slice of GitHub that report-button talks to.
 *
 * API side (what the server calls): git refs/blobs/trees/commits, issue creation, and
 * the GitHub App endpoints (installation lookup, installation tokens, file contents).
 * Web side (what a person opens): the `?raw=true` screenshot URLs the issue body links
 * to, a minimal issue page, and `/_fixture/*` endpoints to inspect or reset state.
 *
 * Both sides live on one port so GITHUB_API_URL and GITHUB_WEB_URL can point at it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, createVerify } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export interface StubCall {
  method: string
  path: string
  body: unknown
  /** The bearer token the caller sent. */
  auth?: string
}

export interface StubIssue {
  number: number
  title: string
  body: string
  labels: string[]
  assignees: string[]
  html_url: string
  created_at: string
}

export interface StubOptions {
  /** Pretend the asset branch already exists. Default false (first run creates it). */
  branchExists?: boolean
  /** Answer issue creation with 403, to exercise the failure path. */
  failIssue?: boolean
  /** App mode: the app's public key. App-level calls must carry a JWT it verifies. */
  appPublicKey?: string
  /** App mode: repos the app is installed on, `owner/name` -> installation id. */
  installations?: Record<string, number>
  /** Files readable through the contents API, keyed `owner/name:path`. */
  files?: Record<string, string>
}

export interface GitHubStub {
  server: Server
  calls: StubCall[]
  issues: StubIssue[]
  assets: Map<string, { bytes: Buffer; mime: string }>
  /** Base URL once listening. */
  url: string
  listen(port?: number, host?: string): Promise<string>
  close(): Promise<void>
  reset(): void
}

/** Check an RS256 JWT's signature and expiry, the way GitHub does for app calls. */
function verifyJwt(jwt: string, publicKey: string): boolean {
  const [head, body, sig] = jwt.split('.')
  if (!head || !body || !sig) return false
  const ok = createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, Buffer.from(sig, 'base64url'))
  const { exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp: number }
  return ok && exp > Date.now() / 1000
}

const sha = (s: string | Buffer) => createHash('sha1').update(s).digest('hex')

const mimeOf = (path: string) =>
  path.endsWith('.jpg') || path.endsWith('.jpeg') ? 'image/jpeg' : path.endsWith('.webp') ? 'image/webp' : 'image/png'

export function createGitHubStub(opts: StubOptions = {}): GitHubStub {
  const calls: StubCall[] = []
  const issues: StubIssue[] = []
  const assets = new Map<string, { bytes: Buffer; mime: string }>()
  const blobs = new Map<string, Buffer>()
  const branches = new Map<string, string>()
  let url = ''

  const reset = () => {
    calls.length = 0
    issues.length = 0
    assets.clear()
    blobs.clear()
    branches.clear()
    if (opts.branchExists) branches.set('report-screenshots', 'parent-sha')
  }
  reset()

  const handle = (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const method = req.method ?? 'GET'
    const u = new URL(req.url ?? '/', 'http://localhost')
    const path = u.pathname
    const body = raw ? JSON.parse(raw) : undefined
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    const html = (status: number, page: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page)
    }

    // ----- API --------------------------------------------------------------
    if (path.startsWith('/repos/') || path.startsWith('/app/')) {
      const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
      calls.push({ method, path: path + u.search, body, auth })
      let m: RegExpExecArray | null

      // GitHub App: calls made as the app itself need a JWT signed with its key.
      const asApp = /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path) || path.startsWith('/app/')
      if (asApp && !(auth && opts.appPublicKey && verifyJwt(auth, opts.appPublicKey))) {
        return json(401, { message: 'A JSON web token could not be decoded' })
      }
      if ((m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path))) {
        const id = opts.installations?.[m[1]]
        return id ? json(200, { id }) : json(404, { message: 'Not Found' })
      }
      if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)) && method === 'POST') {
        return json(201, { token: `ghs_installation_${m[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() })
      }
      if ((m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(path)) && method === 'GET') {
        const file = opts.files?.[`${m[1]}:${m[2]}`]
        return file === undefined ? json(404, { message: 'Not Found' }) : json(200, { content: Buffer.from(file).toString('base64'), encoding: 'base64' })
      }
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path) && method === 'GET') {
        return json(200, { default_branch: 'main' })
      }

      if ((m = /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/.exec(path))) {
        const head = branches.get(m[1])
        return head ? json(200, { object: { sha: head } }) : json(404, { message: 'Not Found' })
      }
      if ((m = /^\/repos\/[^/]+\/[^/]+\/git\/commits\/([^/]+)$/.exec(path)) && method === 'GET') {
        return json(200, { tree: { sha: `tree-of-${m[1]}` } })
      }
      if (path.endsWith('/git/blobs') && method === 'POST') {
        const bytes = Buffer.from(String(body.content), body.encoding === 'base64' ? 'base64' : 'utf8')
        const id = sha(bytes)
        blobs.set(id, bytes)
        return json(201, { sha: id })
      }
      if (path.endsWith('/git/trees') && method === 'POST') {
        for (const entry of body.tree as { path: string; sha: string }[]) {
          const bytes = blobs.get(entry.sha)
          if (bytes) assets.set(entry.path, { bytes, mime: mimeOf(entry.path) })
        }
        return json(201, { sha: sha(JSON.stringify(body)) })
      }
      if (path.endsWith('/git/commits') && method === 'POST') {
        return json(201, { sha: sha(JSON.stringify(body) + Date.now()) })
      }
      if (path.endsWith('/git/refs') && method === 'POST') {
        const name = String(body.ref).replace(/^refs\/heads\//, '')
        if (branches.has(name)) return json(422, { message: 'Reference already exists' })
        branches.set(name, body.sha)
        return json(201, { ref: body.ref })
      }
      if ((m = /\/git\/refs\/heads\/(.+)$/.exec(path)) && method === 'PATCH') {
        if (!branches.has(m[1])) return json(422, { message: 'Reference does not exist' })
        branches.set(m[1], body.sha)
        return json(200, { ref: `refs/heads/${m[1]}` })
      }
      if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(path)) && method === 'POST') {
        if (opts.failIssue) return json(403, { message: 'Resource not accessible by personal access token' })
        const issue: StubIssue = {
          number: issues.length + 1,
          title: String(body.title),
          body: String(body.body),
          labels: body.labels ?? [],
          assignees: body.assignees ?? [],
          html_url: `${url}/${m[1]}/issues/${issues.length + 1}`,
          created_at: new Date().toISOString(),
        }
        issues.push(issue)
        return json(201, issue)
      }
      return json(404, { message: `stub: unexpected ${method} ${path}` })
    }

    // ----- Fixture controls --------------------------------------------------
    if (path === '/_fixture/issues') return json(200, issues)
    if (path === '/_fixture/calls') return json(200, calls)
    if (path === '/_fixture/reset') {
      reset()
      return json(200, { ok: true })
    }

    // ----- Web ---------------------------------------------------------------
    let m: RegExpExecArray | null
    if ((m = /^\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/.exec(path))) {
      const asset = assets.get(decodeURIComponent(m[1]))
      if (!asset) return html(404, '<h1>404</h1><p>no such screenshot</p>')
      res.writeHead(200, { 'Content-Type': asset.mime, 'Content-Length': asset.bytes.length })
      return res.end(asset.bytes)
    }
    if ((m = /^\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path))) {
      const issue = issues[Number(m[1]) - 1]
      return issue ? html(200, renderIssue(issue)) : html(404, '<h1>404</h1><p>no such issue</p>')
    }
    if (path === '/' || path === '/issues') return html(200, renderIndex(issues))
    html(404, '<h1>404</h1>')
  }

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        handle(req, res, raw)
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: String(e) }))
      }
    })
  })

  return {
    server,
    calls,
    issues,
    assets,
    get url() {
      return url
    },
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${(server.address() as AddressInfo).port}`
      return url
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    reset,
  }
}

// ---------------------------------------------------------------------------
// Tiny issue renderer: enough markdown for what report-button emits.
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const STYLE = `<style>
  body{font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0;background:#f6f8fa;color:#1f2328}
  main{max-width:860px;margin:0 auto;padding:24px 16px}
  .issue{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:16px 20px;margin:12px 0}
  h1{font-size:24px;margin:0 0 4px} .meta{color:#656d76;font-size:13px}
  .label{display:inline-block;background:#ddf4ff;color:#0969da;border-radius:999px;padding:0 8px;font-size:12px;margin-right:4px}
  img{max-width:100%;border:1px solid #d0d7de;border-radius:6px}
  blockquote{border-left:3px solid #d0d7de;margin:12px 0;padding:0 12px;color:#656d76}
  table{border-collapse:collapse;margin:12px 0} td{border:1px solid #d0d7de;padding:4px 10px;vertical-align:top;overflow-wrap:anywhere} td:first-child{white-space:nowrap}
  a{color:#0969da} sub{color:#656d76}
</style>`

function mdToHtml(md: string): string {
  const out: string[] = []
  let table: string[] = []
  const flushTable = () => {
    if (table.length) out.push(`<table>${table.join('')}</table>`)
    table = []
  }
  for (const line of md.split('\n')) {
    let m: RegExpExecArray | null
    if ((m = /^!\[(.*?)\]\((.*?)\)$/.exec(line))) {
      flushTable()
      out.push(`<p><img alt="${esc(m[1])}" src="${esc(m[2])}"></p>`)
    } else if (line.startsWith('|')) {
      if (/^\|[-| ]+\|$/.test(line) || line.trim() === '| |') continue
      const cells = line.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
      table.push(`<tr>${cells.map((c) => `<td>${esc(c).replace(/^\*\*(.*)\*\*$/, '<b>$1</b>')}</td>`).join('')}</tr>`)
    } else if (line.startsWith('> ')) {
      flushTable()
      out.push(`<blockquote>${esc(line.slice(2))}</blockquote>`)
    } else if (line.startsWith('<sub>')) {
      flushTable()
      out.push(line)
    } else if (line.trim()) {
      flushTable()
      out.push(`<p>${esc(line)}</p>`)
    }
  }
  flushTable()
  return out.join('\n')
}

function renderIssue(issue: StubIssue): string {
  return `<!doctype html><meta charset="utf-8"><title>#${issue.number} ${esc(issue.title)}</title>${STYLE}
<main><p><a href="/">← all issues</a></p><div class="issue">
<h1>${esc(issue.title)} <span class="meta">#${issue.number}</span></h1>
<p class="meta">${issue.labels.map((l) => `<span class="label">${esc(l)}</span>`).join('')} opened ${esc(issue.created_at)}</p>
${mdToHtml(issue.body)}
</div></main>`
}

function renderIndex(issues: StubIssue[]): string {
  const rows = issues.length
    ? issues
        .map((i) => `<div class="issue"><a href="${esc(i.html_url)}"><b>${esc(i.title)}</b> #${i.number}</a><div class="meta">${esc(i.created_at)}</div></div>`)
        .reverse()
        .join('')
    : '<p class="meta">No issues yet. Open the demo page and send a report.</p>'
  return `<!doctype html><meta charset="utf-8"><title>fake GitHub</title>${STYLE}
<main><h1>fake GitHub</h1><p class="meta">In-memory stand-in for the GitHub API. <a href="/_fixture/issues">JSON</a> · <a href="/_fixture/calls">API calls</a> · <a href="/_fixture/reset">reset</a></p>${rows}</main>`
}
