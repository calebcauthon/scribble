import type { GitHubConfig } from './config.ts'

export class GitHubError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
  }
}

/** Thin fetch wrapper over the REST API that turns non-2xx into GitHubError. */
async function request<T>(
  cfg: GitHubConfig,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(`${cfg.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'report-button',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'message' in data
        ? String((data as { message: unknown }).message)
        : text.slice(0, 300)
    throw new GitHubError(`GitHub ${method} ${path} -> ${res.status}: ${msg}`, res.status)
  }
  return data as T
}

export interface UploadedAsset {
  /** Path inside the asset repo. */
  path: string
  /** URL that renders inline in an issue body for anyone who can see the repo. */
  url: string
}

/**
 * Commit a file onto the asset branch and return a URL that renders inline in an
 * issue. Uses the Git Data API rather than the Contents API so the branch can be
 * created as an orphan on first use: the screenshots then never touch the code
 * history, and the branch can be deleted at any time to purge them.
 *
 * Two reports landing at once race on the branch ref (the second update is not a
 * fast-forward and GitHub answers 422), so the whole sequence is retried.
 */
export async function uploadAsset(
  cfg: GitHubConfig,
  path: string,
  bytes: Uint8Array,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadedAsset> {
  const repo = `/repos/${cfg.assetRepo}`
  const branch = cfg.assetBranch
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let parent: string | null = null
      let baseTree: string | undefined
      try {
        const ref = await request<{ object: { sha: string } }>(cfg, 'GET', `${repo}/git/ref/heads/${branch}`, undefined, fetchImpl)
        parent = ref.object.sha
        const commit = await request<{ tree: { sha: string } }>(cfg, 'GET', `${repo}/git/commits/${parent}`, undefined, fetchImpl)
        baseTree = commit.tree.sha
      } catch (e) {
        if (!(e instanceof GitHubError) || e.status !== 404) throw e
      }

      const blob = await request<{ sha: string }>(
        cfg,
        'POST',
        `${repo}/git/blobs`,
        { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' },
        fetchImpl,
      )
      const tree = await request<{ sha: string }>(
        cfg,
        'POST',
        `${repo}/git/trees`,
        {
          ...(baseTree ? { base_tree: baseTree } : {}),
          tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }],
        },
        fetchImpl,
      )
      const commit = await request<{ sha: string }>(
        cfg,
        'POST',
        `${repo}/git/commits`,
        { message, tree: tree.sha, parents: parent ? [parent] : [] },
        fetchImpl,
      )
      if (parent) {
        await request(cfg, 'PATCH', `${repo}/git/refs/heads/${branch}`, { sha: commit.sha }, fetchImpl)
      } else {
        await request(cfg, 'POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha }, fetchImpl)
      }
      return {
        path,
        // `?raw=true` on a blob URL renders in issues for private repos too, where a
        // raw.githubusercontent.com link would not resolve for the viewer.
        url: `${cfg.webUrl}/${cfg.assetRepo}/blob/${branch}/${path}?raw=true`,
      }
    } catch (e) {
      lastError = e
      const retryable = e instanceof GitHubError && (e.status === 422 || e.status === 409 || e.status >= 500)
      if (!retryable) throw e
    }
  }
  throw lastError
}

export interface CreatedIssue {
  number: number
  html_url: string
}

export async function createIssue(
  cfg: GitHubConfig,
  issue: { title: string; body: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedIssue> {
  const payload: Record<string, unknown> = { title: issue.title, body: issue.body, labels: cfg.labels }
  if (cfg.assignees.length) payload.assignees = cfg.assignees
  const created = await request<CreatedIssue>(cfg, 'POST', `/repos/${cfg.repo}/issues`, payload, fetchImpl)
  if (typeof created?.number !== 'number' || typeof created?.html_url !== 'string') {
    throw new GitHubError('GitHub answered without an issue number', 502)
  }
  return { number: created.number, html_url: created.html_url }
}
