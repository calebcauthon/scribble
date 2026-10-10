import ReportButton from './Report.ts'
import type { Options } from './Report.ts'

export type { Options, ReportContext, ReportPayload, SubmitResult, Messages } from './Report.ts'
export { DEFAULT_MASK_SELECTORS } from './Screenshot.ts'
export { ReportButton }

/**
 * Mount the report button.
 *
 * ```js
 * import { init } from 'report-button'
 * const report = init({ repo: 'you/your-app' })
 * // later: report.open(), report.destroy()
 * ```
 */
export function init(options: Options = {}): ReportButton {
  return new ReportButton(options)
}

export default init
