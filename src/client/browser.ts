/**
 * Entry point for the `<script>` build. Exposes `window.ReportButton` and, when
 * loaded via a plain script tag, mounts itself from the tag's data attributes:
 *
 * ```html
 * <script src="https://reports.example.com/report-button.js"
 *         data-endpoint="https://reports.example.com/report"
 *         data-label="Report a problem"
 *         data-position="bottom-right"></script>
 * ```
 *
 * `data-endpoint` defaults to `/report` on the host the script was loaded from.
 * Add `data-manual` to skip auto-mounting and call `ReportButton.init({...})`
 * yourself (for example to pass a `context()` function).
 */
import { init, ReportButton } from './index.ts'
import type { Options } from './Report.ts'

declare global {
  interface Window {
    ReportButton: {
      init: typeof init
      instance: ReportButton | null
    }
  }
}

window.ReportButton = { init, instance: null }

const script = document.currentScript as HTMLScriptElement | null
if (script && !('manual' in script.dataset)) {
  const d = script.dataset
  const endpoint = d.endpoint || (script.src ? new URL('/report', script.src).href : '')
  const options: Options = { endpoint }
  if (d.label) options.buttonLabel = d.label
  if (d.position) options.buttonPosition = d.position as Options['buttonPosition']
  if (d.accent) options.accentColor = d.accent
  if (d.pen) options.penColor = d.pen
  if (d.placeholder) options.notePlaceholder = d.placeholder
  if (d.mask) options.maskSelectors = d.mask.split(',').map((s) => s.trim()).filter(Boolean)
  if ('linkToIssue' in d) options.linkToIssue = true
  try {
    window.ReportButton.instance = init(options)
  } catch (e) {
    console.error('report-button: failed to mount', e)
  }
}
