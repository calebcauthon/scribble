/**
 * The issue title and body, shared by the server (which embeds the committed
 * screenshot) and the browser's GitHub mode (which prefills a new-issue page and
 * leaves a spot for the reporter to paste the screenshot).
 */

/** Everything about a report except the image bytes. */
export interface IssueFields {
  reportId: string
  note: string
  pageUrl: string
  viewport?: { width: number; height: number; dpr: number }
  userAgent?: string
  language?: string
  reportedAt: string
  context: Record<string, string>
}

/** Shown in place of the image when the reporter pastes the screenshot themselves. */
export const PASTE_HINT = '<!-- Paste the screenshot here: it is on your clipboard (Cmd+V / Ctrl+V) -->'

/** A markdown table cell: pipes and newlines would break the row. */
const cell = (v: string) => v.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

/**
 * Render the issue title and markdown body. Pure, so it is easy to test and tweak.
 * `imageUrl` null leaves a paste hint where the screenshot goes.
 */
export function buildIssue(report: IssueFields, imageUrl: string | null): { title: string; body: string } {
  const note = report.note.trim()
  const firstLine = note.split(/\r?\n/)[0]?.trim() ?? ''
  const title = firstLine
    ? firstLine.slice(0, 120)
    : report.pageUrl
      ? `Report from ${pathOf(report.pageUrl)}`.slice(0, 120)
      : `User report ${report.reportId.slice(0, 8)}`

  const lines: string[] = [imageUrl ? `![Annotated screenshot](${imageUrl})` : PASTE_HINT, '']
  if (note) {
    lines.push(...note.split(/\r?\n/).map((l) => `> ${l}`), '')
  }

  const rows: [string, string][] = []
  if (report.pageUrl) rows.push(['Page', report.pageUrl])
  rows.push(['Reported', report.reportedAt])
  if (report.viewport) {
    const { width, height, dpr } = report.viewport
    // Not "@2x": GitHub would read that as a mention of the user "2x".
    rows.push(['Viewport', `${width}×${height}${dpr !== 1 ? `, ${dpr}x pixel ratio` : ''}`])
  }
  if (report.userAgent) rows.push(['Browser', report.userAgent])
  if (report.language) rows.push(['Language', report.language])
  for (const [k, v] of Object.entries(report.context)) rows.push([k, v])
  rows.push(['Report id', report.reportId])

  lines.push('| | |', '|---|---|')
  for (const [k, v] of rows) lines.push(`| **${cell(k)}** | ${cell(v)} |`)
  lines.push('', '<sub>Filed with report-button.</sub>')

  return { title, body: lines.join('\n') }
}
