export interface Config {
  port: number
  github: GitHubConfig
  /** Page origins allowed to submit. `['*']` allows any. */
  allowedOrigins: string[]
  /** Reports per client IP per minute. 0 disables. */
  rateLimit: number
  /** Hard cap on the decoded screenshot. */
  maxImageBytes: number
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

const csv = (v: string | undefined, fallback: string[] = []): string[] =>
  v === undefined ? fallback : v.split(',').map((s) => s.trim()).filter(Boolean)

const repoShape = /^[\w.-]+\/[\w.-]+$/

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.GITHUB_TOKEN?.trim()
  const repo = env.GITHUB_REPO?.trim().replace(/^\/+|\/+$/g, '')
  if (!token) throw new Error('GITHUB_TOKEN is required')
  if (!repo) throw new Error('GITHUB_REPO is required (owner/name)')
  if (!repoShape.test(repo)) throw new Error(`GITHUB_REPO must look like owner/name, got "${repo}"`)
  const assetRepo = env.GITHUB_ASSET_REPO?.trim().replace(/^\/+|\/+$/g, '') || repo
  if (!repoShape.test(assetRepo)) {
    throw new Error(`GITHUB_ASSET_REPO must look like owner/name, got "${assetRepo}"`)
  }

  return {
    port: Number(env.PORT) || 8787,
    github: {
      token,
      apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
      webUrl: (env.GITHUB_WEB_URL || 'https://github.com').replace(/\/+$/, ''),
      repo,
      assetRepo,
      assetBranch: env.GITHUB_ASSET_BRANCH?.trim() || 'report-screenshots',
      labels: csv(env.GITHUB_LABELS, ['user-report']),
      assignees: csv(env.GITHUB_ASSIGNEES),
    },
    allowedOrigins: csv(env.ALLOWED_ORIGINS, ['*']),
    rateLimit: env.RATE_LIMIT === undefined ? 10 : Number(env.RATE_LIMIT) || 0,
    maxImageBytes: 20 * 1024 * 1024,
  }
}
