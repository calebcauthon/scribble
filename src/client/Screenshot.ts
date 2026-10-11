import { HIDDEN_ATTR, Z_TOP, hide } from './dom.ts'

/**
 * Selectors for content that must never leave the browser inside a screenshot.
 * Password fields and anything the host app marks with `data-report-mask`, plus
 * OpenReplay's masking attributes so a page already annotated for replay privacy
 * gets the same treatment here for free.
 */
export const DEFAULT_MASK_SELECTORS = [
  '[data-report-mask]',
  '[data-openreplay-masked]',
  '[data-openreplay-obscured]',
  'input[type=password]',
]

const MASK_ATTR = 'data-report-mask-overlay'

interface MaskRecord {
  overlay: HTMLElement
}

/**
 * Cover every sensitive node with an opaque overlay positioned over it and return
 * what is needed to undo it. Overlays are used rather than mutating the target's
 * own styles so layout is never disturbed and nothing is lost.
 */
function maskSensitiveNodes(selectors: string[]): MaskRecord[] {
  const records: MaskRecord[] = []
  if (selectors.length === 0) return records
  const nodes = document.querySelectorAll<HTMLElement>(selectors.join(','))

  nodes.forEach((el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return
    const overlay = hide(document.createElement('div'))
    // Hidden from our own capture filter by default, but explicitly flagged as a
    // mask so html2canvas still paints it: it *is* the masking.
    overlay.setAttribute(MASK_ATTR, '1')
    Object.assign(overlay.style, {
      // Document-space, not viewport-space: a fixed overlay would land in the wrong
      // place if html2canvas rasterises the whole document rather than the viewport.
      position: 'absolute',
      left: `${rect.left + window.scrollX}px`,
      top: `${rect.top + window.scrollY}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      background: '#000',
      zIndex: String(Z_TOP - 3),
      pointerEvents: 'none',
    })
    document.body.appendChild(overlay)
    records.push({ overlay })
  })

  return records
}

function restore(records: MaskRecord[]) {
  for (const { overlay } of records) {
    overlay.parentNode?.removeChild(overlay)
  }
}

/**
 * Capture the current viewport to a canvas with masking applied.
 *
 * html2canvas is loaded on demand: it is ~200 kB and only needed once someone
 * actually clicks the button. Sensitive nodes are masked first and always
 * restored, even on failure.
 */
export async function captureScreenshot(
  maskSelectors: string[] = DEFAULT_MASK_SELECTORS,
): Promise<HTMLCanvasElement> {
  const { default: html2canvas } = await import('html2canvas-pro')

  const records = maskSensitiveNodes(maskSelectors)
  const scale = window.devicePixelRatio || 1
  const scrollX = window.scrollX
  const scrollY = window.scrollY
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  try {
    const raw = await html2canvas(document.documentElement, {
      logging: false,
      useCORS: true,
      // Skip our own UI, but keep the mask overlays: those must be rasterised.
      ignoreElements: (el) =>
        el.getAttribute?.(HIDDEN_ATTR) === '1' && el.getAttribute?.(MASK_ATTR) !== '1',
      scale,
    })

    // Crop the visible region ourselves rather than via html2canvas's x/y options,
    // which produced a capture offset from the viewport. html2canvas may hand back
    // the whole document or just the viewport depending on version and page, so
    // measure what came back and crop from there. The annotation overlay works in
    // viewport coordinates, so the result must be exactly the viewport.
    const looksLikeFullDocument = raw.height / scale > viewportHeight + 1
    const maxSourceX = Math.max(0, raw.width - viewportWidth * scale)
    const maxSourceY = Math.max(0, raw.height - viewportHeight * scale)
    const sourceX = looksLikeFullDocument ? Math.min(Math.round(scrollX * scale), maxSourceX) : 0
    const sourceY = looksLikeFullDocument ? Math.min(Math.round(scrollY * scale), maxSourceY) : 0

    const out = document.createElement('canvas')
    out.width = Math.round(viewportWidth * scale)
    out.height = Math.round(viewportHeight * scale)
    const ctx = out.getContext('2d')
    if (!ctx) return raw
    ctx.drawImage(raw, sourceX, sourceY, out.width, out.height, 0, 0, out.width, out.height)
    return out
  } finally {
    restore(records)
  }
}
