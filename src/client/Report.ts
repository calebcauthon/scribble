import AnnotationCanvas from './AnnotationCanvas.ts'
import { DEFAULT_MASK_SELECTORS, captureScreenshot } from './Screenshot.ts'
import { Z_TOP, hide } from './dom.ts'

/** Extra key/value pairs that end up as rows in the issue body. */
export type ReportContext = Record<string, string | number | boolean | null | undefined>

/** What the server answers once the issue exists. */
export interface SubmitResult {
  issueUrl: string
  issueNumber: number
}

/** What the client POSTs to the server. */
export interface ReportPayload {
  reportId: string
  note: string
  pageUrl: string
  /** PNG as a data URL. */
  image: string
  viewport: { width: number; height: number; dpr: number }
  userAgent: string
  language: string
  /** ISO 8601, the moment the user pressed send. */
  reportedAt: string
  context: ReportContext
}

export interface Options {
  /**
   * URL the report is POSTed to, i.e. the `/report` route of the server in this
   * repo. Required.
   */
  endpoint: string
  /** Text on the floating button. Default "Report a problem". */
  buttonLabel?: string
  /** Corner the floating button is anchored to. Default "bottom-right". */
  buttonPosition?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
  /**
   * Render the floating button at all. Set false to trigger the flow from your
   * own UI via `open()` instead. Default true.
   */
  showButton?: boolean
  /** Accent colour for the button, active tool and submit button. */
  accentColor?: string
  /** Colour selected when the annotation overlay opens. */
  penColor?: string
  /** Colour swatches offered in the toolbar. */
  colors?: string[]
  /** Placeholder for the note field. */
  notePlaceholder?: string
  /**
   * CSS selectors for content to black out before the screenshot is taken.
   * Defaults to password fields and anything marked `data-report-mask`.
   */
  maskSelectors?: string[]
  /**
   * Extra details to include in the issue, gathered at send time. Return a flat
   * object; each entry becomes a row in the issue body. Use it for the current
   * user, build version, session replay link, etc.
   */
  context?: () => ReportContext | Promise<ReportContext>
  /**
   * Show a "View issue" link in the confirmation toast. Off by default, since
   * end users of a public site usually should not be sent to your tracker.
   */
  linkToIssue?: boolean
  /** Called once the issue has been filed. */
  onSubmitted?: (result: SubmitResult) => void
  /** Called when capture, encoding or sending fails. */
  onError?: (error: Error) => void
  /** Toast copy. */
  messages?: Partial<Messages>
}

export interface Messages {
  sent: string
  failed: string
  viewIssue: string
}

const defaultMessages: Messages = {
  sent: 'Thanks, your report was sent.',
  failed: "Sorry, your report couldn't be sent.",
  viewIssue: 'View issue',
}

export default class ReportButton {
  private readonly options: Required<Pick<Options, 'endpoint' | 'buttonLabel' | 'buttonPosition' | 'showButton' | 'accentColor' | 'penColor' | 'maskSelectors' | 'linkToIssue'>> &
    Options
  private readonly messages: Messages
  private button: HTMLButtonElement | null = null
  private annotation: AnnotationCanvas | null = null
  private toast: HTMLDivElement | null = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private opening = false

  constructor(opts: Options) {
    if (!opts || !opts.endpoint) {
      throw new Error('report-button: `endpoint` is required')
    }
    this.options = {
      buttonLabel: 'Report a problem',
      buttonPosition: 'bottom-right',
      showButton: true,
      accentColor: '#394EFF',
      penColor: '#E53935',
      maskSelectors: DEFAULT_MASK_SELECTORS,
      linkToIssue: false,
      ...opts,
    }
    this.messages = { ...defaultMessages, ...(opts.messages ?? {}) }
    if (this.options.showButton) this.mountButton()
  }

  // ---------------------------------------------------------------------------
  // Trigger button
  // ---------------------------------------------------------------------------

  private mountButton() {
    const btn = hide(document.createElement('button'))
    btn.type = 'button'
    btn.textContent = this.options.buttonLabel

    const pos = this.options.buttonPosition
    const vertical = pos.startsWith('top') ? { top: '16px' } : { bottom: '16px' }
    const horizontal = pos.endsWith('left') ? { left: '16px' } : { right: '16px' }

    Object.assign(
      btn.style,
      {
        position: 'fixed',
        padding: '10px 16px',
        border: 'none',
        borderRadius: '8px',
        background: this.options.accentColor,
        color: '#fff',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '14px',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        zIndex: String(Z_TOP - 4),
      },
      vertical,
      horizontal,
    )

    btn.addEventListener('click', () => {
      void this.open()
    })

    const mount = () => document.body.appendChild(btn)
    if (document.body) mount()
    else document.addEventListener('DOMContentLoaded', mount, { once: true })
    this.button = btn
  }

  // ---------------------------------------------------------------------------
  // Report flow
  // ---------------------------------------------------------------------------

  /** Capture the viewport and open the annotation overlay. */
  async open(): Promise<void> {
    if (this.annotation || this.opening) return
    this.opening = true

    const reportId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `report-${Date.now()}-${Math.random().toString(36).slice(2)}`

    // Hide our own button and any toast while capturing so they aren't in the shot.
    if (this.button) this.button.style.display = 'none'
    this.dismissToast()

    let screenshot: HTMLCanvasElement
    try {
      screenshot = await captureScreenshot(this.options.maskSelectors)
    } catch (e) {
      this.opening = false
      if (this.button) this.button.style.display = ''
      this.fail(e, 'screenshot failed')
      return
    }

    const annotation = new AnnotationCanvas({
      penColor: this.options.penColor,
      colors: this.options.colors,
      accentColor: this.options.accentColor,
      notePlaceholder: this.options.notePlaceholder,
    })
    this.annotation = annotation
    this.opening = false
    annotation.mount({
      screenshot,
      onSubmit: () => {
        void this.submit(reportId)
      },
      onCancel: () => this.teardownOverlay(),
    })
  }

  private teardownOverlay() {
    this.annotation?.remove()
    this.annotation = null
    if (this.button) this.button.style.display = ''
  }

  private async submit(reportId: string) {
    const annotation = this.annotation
    if (!annotation) return
    annotation.setBusy(true)

    try {
      const payload = await this.buildPayload(reportId, annotation)
      const result = await this.send(payload)
      this.teardownOverlay()
      this.showToast(this.messages.sent, this.options.linkToIssue ? result.issueUrl : undefined)
      this.options.onSubmitted?.(result)
    } catch (e) {
      // Keep the overlay up so the user's drawing isn't lost: they can retry or cancel.
      annotation.setBusy(false)
      this.showToast(this.messages.failed)
      this.fail(e, 'send failed')
    }
  }

  private async buildPayload(reportId: string, annotation: AnnotationCanvas): Promise<ReportPayload> {
    const blob = await annotation.toBlob()
    const image = await blobToDataURL(blob)

    let context: ReportContext = {}
    if (this.options.context) {
      try {
        context = (await this.options.context()) ?? {}
      } catch (e) {
        console.warn('report-button: context() threw, sending without it', e)
      }
    }

    return {
      reportId,
      note: annotation.getNote(),
      pageUrl: location.href,
      image,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      },
      userAgent: navigator.userAgent,
      language: navigator.language,
      reportedAt: new Date().toISOString(),
      context,
    }
  }

  private async send(payload: ReportPayload): Promise<SubmitResult> {
    const res = await fetch(this.options.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`report-button: server answered ${res.status} ${text}`.trim())
    }
    const data = (await res.json()) as Partial<SubmitResult>
    if (!data || typeof data.issueUrl !== 'string') {
      throw new Error('report-button: server answered without an issue URL')
    }
    return { issueUrl: data.issueUrl, issueNumber: Number(data.issueNumber) }
  }

  private fail(e: unknown, what: string) {
    const error = e instanceof Error ? e : new Error(String(e))
    console.error(`report-button: ${what}`, error)
    this.options.onError?.(error)
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  private showToast(text: string, link?: string) {
    this.dismissToast()
    const toast = hide(document.createElement('div'))
    Object.assign(toast.style, {
      position: 'fixed',
      left: '50%',
      bottom: '20px',
      transform: 'translateX(-50%)',
      padding: '10px 16px',
      borderRadius: '8px',
      background: '#222',
      color: '#fff',
      font: '14px system-ui, -apple-system, sans-serif',
      boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
      zIndex: String(Z_TOP - 1),
      maxWidth: 'calc(100vw - 32px)',
      boxSizing: 'border-box',
    })
    toast.textContent = text
    if (link) {
      const a = hide(document.createElement('a'))
      a.href = link
      a.target = '_blank'
      a.rel = 'noopener'
      a.textContent = this.messages.viewIssue
      Object.assign(a.style, { color: '#9db1ff', marginLeft: '10px' })
      toast.appendChild(a)
    }
    document.body.appendChild(toast)
    this.toast = toast
    this.toastTimer = setTimeout(() => this.dismissToast(), link ? 10000 : 5000)
  }

  private dismissToast() {
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = null
    this.toast?.parentNode?.removeChild(this.toast)
    this.toast = null
  }

  // ---------------------------------------------------------------------------

  /** Remove everything the library added to the page. */
  destroy() {
    this.teardownOverlay()
    this.dismissToast()
    this.button?.parentNode?.removeChild(this.button)
    this.button = null
  }
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('report-button: could not read blob'))
    reader.readAsDataURL(blob)
  })
}
