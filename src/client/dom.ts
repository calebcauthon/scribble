/**
 * Attribute that marks every element this library injects (button, overlay,
 * toolbar, mask overlays). The screenshot capture skips these so the UI never
 * ends up inside the image.
 */
export const HIDDEN_ATTR = 'data-report-hidden'

/**
 * Mark an element as library chrome. Also sets `data-openreplay-hidden` so that,
 * when OpenReplay's tracker is on the page, the overlay is kept out of the
 * session replay as well. Harmless when it is not.
 */
export function hide<T extends HTMLElement>(el: T, role?: string): T {
  el.setAttribute(HIDDEN_ATTR, '1')
  el.setAttribute('data-openreplay-hidden', '1')
  // Stable hook for tests and host-page CSS, e.g. `[data-report-role="button"]`.
  if (role) el.setAttribute('data-report-role', role)
  return el
}

export const Z_TOP = 2147483647
