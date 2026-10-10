export interface Config {
  port: number
  /** Token mode: one token, one repo. Set when GITHUB_TOKEN is. */
  github?: GitHubConfig
  /** App mode: any repo the GitHub App is installed on. Set when GITHUB_APP_ID is. */
  app?: AppConfig
  /** Token mode only: page origins allowed to submit. `['*']` allows any. */
  allowedOrigins: string[]
  /** Reports per client IP per minute. 0 disables. */
  rateLimit: number
  /** Hard cap on the decoded screenshot. */
  maxImageBytes: number
  /** Public base URL of this server, for setup links. Derived from the request when unset. */
  publicUrl?: string
}

export interface GitHubConfig {
  token: string
  apiUrl: string
  webUrl: string
  /** owner/name the issues go to. */
  repo: string
  /** owner/name the screenshots are committed to. */
  assetRepo: string
  assetBranch: string
  labels: string[]
  assignees: string[]
}

export interface AppConfig {
  appId: string
  /** PEM private key generated on the app's settings page. */
  privateKey: string
  /** The app's URL name, as in github.com/apps/<slug>. */
  slug: string
  apiUrl: string
  webUrl: string
  /** Defaults for every repo; a repo's .github/report-button.yml can override labels. */
  assetBranch: string
  labels: string[]
}

const csv = (v: string | undefined, fallback: string[] = []): string[] =>
  v === undefined ? fallback : v.split(',').map((s) => s.trim()).filter(Boolean)

export const repoShape = /^[\w.-]+\/[\w.-]+$/

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
  const webUrl = (env.GITHUB_WEB_URL || 'https://github.com').replace(/\/+$/, '')
  const assetBranch = env.GITHUB_ASSET_BRANCH?.trim() || 'report-screenshots'
  const labels = csv(env.GITHUB_LABELS, ['user-report'])

  let github: GitHubConfig | undefined
  const token = env.GITHUB_TOKEN?.trim()
  if (token) {
    const repo = env.GITHUB_REPO?.trim().replace(/^\/+|\/+$/g, '')
    if (!repo) throw new Error('GITHUB_REPO is required with GITHUB_TOKEN (owner/name)')
    if (!repoShape.test(repo)) throw new Error(`GITHUB_REPO must look like owner/name, got "${repo}"`)
    const assetRepo = env.GITHUB_ASSET_REPO?.trim().replace(/^\/+|\/+$/g, '') || repo
    if (!repoShape.test(assetRepo)) {
      throw new Error(`GITHUB_ASSET_REPO must look like owner/name, got "${assetRepo}"`)
    }
    github = { token, apiUrl, webUrl, repo, assetRepo, assetBranch, labels, assignees: csv(env.GITHUB_ASSIGNEES) }
  }

  let app: AppConfig | undefined
  const appId = env.GITHUB_APP_ID?.trim()
  if (appId) {
    // Hosts that only take single-line values get the PEM with literal \n.
    const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n').trim()
    const slug = env.GITHUB_APP_SLUG?.trim()
    if (!privateKey) throw new Error('GITHUB_APP_PRIVATE_KEY is required with GITHUB_APP_ID')
    if (!slug) throw new Error('GITHUB_APP_SLUG is required with GITHUB_APP_ID (the name in github.com/apps/<slug>)')
    app = { appId, privateKey, slug, apiUrl, webUrl, assetBranch, labels }
  }

  if (!github && !app) {
    throw new Error('set GITHUB_TOKEN + GITHUB_REPO, or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_SLUG')
  }

  return {
    port: Number(env.PORT) || 8787,
    github,
    app,
    allowedOrigins: csv(env.ALLOWED_ORIGINS, ['*']),
    rateLimit: env.RATE_LIMIT === undefined ? 10 : Number(env.RATE_LIMIT) || 0,
    maxImageBytes: 20 * 1024 * 1024,
    publicUrl: env.PUBLIC_URL?.replace(/\/+$/, '') || undefined,
  }
}
