import { createSign } from 'node:crypto'
import type { AppConfig, GitHubConfig } from './config.ts'
import { GitHubError, request } from './github.ts'

/**
 * Per-repo settings, read from `.github/report-button.yml` in the target repo so the
 * relay needs no database. Every key is optional:
 *
 * ```yaml
 * origins:            # pages allowed to file; omit to allow any
 *   - https://app.example.com
 * labels: [user-report, bug]
 * assignees: octocat
 * ```
 */
export interface RepoSettings {
  /** Empty means any origin. */
  origins: string[]
  labels?: string[]
  assignees: string[]
}

export const SETTINGS_PATH = '.github/report-button.yml'

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2')

/**
 * Enough YAML for the settings file: `key: value`, `key: [a, b]`, `key: a, b` and
 * `key:` followed by `- item` lines. Anything else is ignored.
 */
export function parseSettings(text: string): RepoSettings {
  const lists: Record<string, string[]> = {}
  let current: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trimEnd()
    if (!line.trim()) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && current) {
      lists[current].push(unquote(item[1]))
      continue
    }
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    current = kv[1]
    const value = kv[2].trim().replace(/^\[(.*)\]$/, '$1')
    lists[current] = value ? value.split(',').map(unquote).filter(Boolean) : []
  }
  return {
    origins: (lists.origins ?? []).map((o) => o.replace(/\/+$/, '')),
    labels: lists.labels,
    assignees: lists.assignees ?? [],
  }
}

export function originAllowed(settings: RepoSettings, origin: string | undefined): boolean {
  if (!settings.origins.length || settings.origins.includes('*')) return true
  return !!origin && settings.origins.includes(origin)
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url')

/** The short-lived JWT a GitHub App signs to act as itself. */
export function appJwt(app: Pick<AppConfig, 'appId' | 'privateKey'>, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60 // GitHub allows for clock drift this way
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: app.appId }))
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(app.privateKey)
  return `${head}.${body}.${b64url(sig)}`
}

interface Cached<T> {
  value: T
  until: number
}

const MISS_TTL = 30_000
const HIT_TTL = 10 * 60_000
const SETTINGS_TTL = 60_000

/**
 * Acts for whichever repos the app is installed on: finds the installation, mints and
 * caches its token, and reads the repo's settings file.
 */
export class GitHubApp {
  readonly cfg: AppConfig
  private readonly fetchImpl: typeof fetch
  private readonly installations = new Map<string, Cached<number | null>>()
  private readonly tokens = new Map<number, Cached<string>>()
  private readonly settings = new Map<string, Cached<RepoSettings>>()

  constructor(cfg: AppConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg
    this.fetchImpl = fetchImpl
  }

  get installUrl(): string {
    return `${this.cfg.webUrl}/apps/${this.cfg.slug}/installations/new`
  }

  private asApp() {
    return { apiUrl: this.cfg.apiUrl, token: appJwt(this.cfg) }
  }

  /** The installation covering `repo`, or null when the app is not installed there. */
  async installationFor(repo: string, now = Date.now()): Promise<number | null> {
    const key = repo.toLowerCase()
    const hit = this.installations.get(key)
    if (hit && hit.until > now) return hit.value
    let id: number | null = null
    try {
      const inst = await request<{ id: number }>(this.asApp(), 'GET', `/repos/${repo}/installation`, undefined, this.fetchImpl)
      id = inst.id
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e
    }
    this.installations.set(key, { value: id, until: now + (id ? HIT_TTL : MISS_TTL) })
    return id
  }

  /** An installation token for `repo`, or null when the app is not installed there. */
  async tokenFor(repo: string, now = Date.now()): Promise<string | null> {
    const id = await this.installationFor(repo, now)
    if (!id) return null
    const hit = this.tokens.get(id)
    if (hit && hit.until > now) return hit.value
    const t = await request<{ token: string; expires_at: string }>(
      this.asApp(),
      'POST',
      `/app/installations/${id}/access_tokens`,
      {},
      this.fetchImpl,
    )
    // Tokens last an hour; refresh with five minutes to spare.
    const expires = Date.parse(t.expires_at) || now + 60 * 60_000
    this.tokens.set(id, { value: t.token, until: expires - 5 * 60_000 })
    return t.token
  }

  /** The repo's settings file, or defaults when it has none. */
  async settingsFor(repo: string, token: string, now = Date.now()): Promise<RepoSettings> {
    const key = repo.toLowerCase()
    const hit = this.settings.get(key)
    if (hit && hit.until > now) return hit.value
    let value: RepoSettings = { origins: [], assignees: [] }
    try {
      const file = await request<{ content?: string }>(
        { apiUrl: this.cfg.apiUrl, token },
        'GET',
        `/repos/${repo}/contents/${SETTINGS_PATH}`,
        undefined,
        this.fetchImpl,
      )
      if (file?.content) value = parseSettings(Buffer.from(file.content, 'base64').toString('utf8'))
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e
    }
    this.settings.set(key, { value, until: now + SETTINGS_TTL })
    return value
  }

  async defaultBranch(repo: string, token: string): Promise<string> {
    const r = await request<{ default_branch?: string }>({ apiUrl: this.cfg.apiUrl, token }, 'GET', `/repos/${repo}`, undefined, this.fetchImpl)
    return r?.default_branch || 'main'
  }

  /** Everything needed to file into `repo`, or null when the app is not installed there. */
  async target(repo: string): Promise<{ github: GitHubConfig; settings: RepoSettings } | null> {
    const token = await this.tokenFor(repo)
    if (!token) return null
    const settings = await this.settingsFor(repo, token)
    return {
      settings,
      github: {
        token,
        apiUrl: this.cfg.apiUrl,
        webUrl: this.cfg.webUrl,
        repo,
        assetRepo: repo,
        assetBranch: this.cfg.assetBranch,
        labels: settings.labels ?? this.cfg.labels,
        assignees: settings.assignees,
      },
    }
  }
}
