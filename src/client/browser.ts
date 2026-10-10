/**
 * Entry point for the `<script>` build. Exposes `window.ReportButton` and, when
 * loaded via a plain script tag, mounts itself from the tag's data attributes:
 *
 * ```html
 * <script src="https://cdn.jsdelivr.net/npm/report-button@0" data-repo="you/your-app"></script>
 * ```
 *
 * - `data-repo` names the GitHub repo. Reports go through the relay when it is
 *   connected to that repo, and open as prefilled GitHub issues otherwise.
 * - `data-relay` picks the relay. Loaded from a CDN it defaults to the hosted one;
 *   served by your own report-button server, to that server.
 * - No `data-repo`: from a CDN the button shows a setup panel; from your own server
 *   it POSTs to that server's `/report`, as `data-endpoint` would.
 *
 * Add `data-manual` to skip auto-mounting and call `ReportButton.init({...})`
 * yourself (for example to pass a `context()` function).
 */
import { init, ReportButton } from './index.ts'
import type { Options } from './Report.ts'
import { HOSTED_RELAY } from './relay.ts'
import { DEFAULT_MASK_SELECTORS } from './Screenshot.ts'

declare global {
  interface Window {
    ReportButton: {
      init: typeof init
      instance: ReportButton | null
    }
  }
}

window.ReportButton = { init, instance: null }

const CDN = /(^|\.)(jsdelivr\.net|unpkg\.com)$/

const script = document.currentScript as HTMLScriptElement | null
if (script && !('manual' in script.dataset)) {
  const d = script.dataset
  const src = script.src ? new URL(script.src, location.href) : null
  const fromCdn = !!src && CDN.test(src.hostname)
  const options: Options = {}
  if (d.endpoint) options.endpoint = d.endpoint
  else if (d.repo) {
    options.repo = d.repo.trim()
    options.relay = d.relay ?? (fromCdn || !src ? HOSTED_RELAY : src.origin)
  } else if (src && !fromCdn) options.endpoint = new URL('/report', src).href
  else if (d.relay !== undefined) options.relay = d.relay
  if (d.github) options.githubUrl = d.github
  if (d.label) options.buttonLabel = d.label
  if (d.position) options.buttonPosition = d.position as Options['buttonPosition']
  if (d.accent) options.accentColor = d.accent
  if (d.pen) options.penColor = d.pen
  if (d.placeholder) options.notePlaceholder = d.placeholder
  // Added to the defaults, so naming one selector never unmasks password fields.
  if (d.mask) options.maskSelectors = [...DEFAULT_MASK_SELECTORS, ...d.mask.split(',').map((s) => s.trim()).filter(Boolean)]
  if ('linkToIssue' in d) options.linkToIssue = true
  // The setup panel hands back this same tag with the repo filled in.
  const tagSrc = src?.href ?? 'https://cdn.jsdelivr.net/npm/report-button@0'
  options.installSnippet = (repo) => `<script src="${tagSrc}" data-repo="${repo}"></script>`
  try {
    window.ReportButton.instance = init(options)
  } catch (e) {
    console.error('report-button: failed to mount', e)
  }
}
