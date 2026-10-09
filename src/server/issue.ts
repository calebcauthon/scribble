/** The validated, decoded report the HTTP layer hands to the rest of the server. */
export interface Report {
  reportId: string
  note: string
  pageUrl: string
  image: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp' }
  viewport?: { width: number; height: number; dpr: number }
  userAgent?: string
  language?: string
  reportedAt: string
  context: Record<string, string>
}

const EXT: Record<Report['image']['mime'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** Where the screenshot lives on the asset branch: one folder per day keeps it browsable. */
export function assetPath(report: Report): string {
  const day = report.reportedAt.slice(0, 10)
  return `${day}/${report.reportId}.${EXT[report.image.mime]}`
}

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

/** Render the issue title and markdown body. Pure, so it is easy to test and tweak. */
export function buildIssue(report: Report, imageUrl: string): { title: string; body: string } {
  const note = report.note.trim()
  const firstLine = note.split(/\r?\n/)[0]?.trim() ?? ''
  const title = firstLine
    ? firstLine.slice(0, 120)
    : report.pageUrl
      ? `Report from ${pathOf(report.pageUrl)}`.slice(0, 120)
      : `User report ${report.reportId.slice(0, 8)}`

  const lines: string[] = [`![Annotated screenshot](${imageUrl})`, '']
  if (note) {
    lines.push(...note.split(/\r?\n/).map((l) => `> ${l}`), '')
  }

  const rows: [string, string][] = []
  if (report.pageUrl) rows.push(['Page', report.pageUrl])
  rows.push(['Reported', report.reportedAt])
  if (report.viewport) {
    const { width, height, dpr } = report.viewport
    rows.push(['Viewport', `${width}×${height}${dpr !== 1 ? ` @${dpr}x` : ''}`])
  }
  if (report.userAgent) rows.push(['Browser', report.userAgent])
  if (report.language) rows.push(['Language', report.language])
  for (const [k, v] of Object.entries(report.context)) rows.push([k, v])
  rows.push(['Report id', report.reportId])

  lines.push('| | |', '|---|---|')
  for (const [k, v] of rows) lines.push(`| **${cell(k)}** | ${cell(v)} |`)
  lines.push('', '<sub>Filed automatically by report-button from a user-submitted report.</sub>')

  return { title, body: lines.join('\n') }
}
