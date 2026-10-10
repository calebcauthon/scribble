import type { IssueFields } from '../shared/issue.ts'

export { buildIssue } from '../shared/issue.ts'

/** The validated, decoded report the HTTP layer hands to the rest of the server. */
export interface Report extends IssueFields {
  image: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp' }
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
