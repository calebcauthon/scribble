import AnnotationCanvas from './AnnotationCanvas.ts'
import SetupPanel from './SetupPanel.ts'
import { DEFAULT_MASK_SELECTORS, captureScreenshot } from './Screenshot.ts'
import { Z_TOP, hide } from './dom.ts'
import { HOSTED_RELAY } from './relay.ts'
import { buildIssue } from '../shared/issue.ts'

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
  /** Which repo to file into, when the server serves more than one. */
  repo?: string
}

export interface Options {
  /**
   * The GitHub repo reports go to, `owner/name`. If the relay is connected to it,
   * reports are filed directly; otherwise they open as a prefilled GitHub issue
   * with the screenshot on the clipboard. Without `repo` or `endpoint`, the button
   * shows a setup panel instead.
   */
  repo?: string
  /**
   * Base URL of the report-button server that files issues for `repo`. Defaults to
   * the hosted relay; `''` skips it and always opens GitHub.
   */
  relay?: string
  /**
   * Skip the repo/relay handshake and POST every report here (the `/report` route
   * of your own server, which files into its configured repo).
   */
  endpoint?: string
  /** GitHub's web URL, for GitHub Enterprise. Default https://github.com. */
  githubUrl?: string
  /** The install line the setup panel offers. The script-tag build sets this. */
  installSnippet?: (repo: string) => string
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
  /** GitHub mode: the issue page opened and the screenshot is on the clipboard. */
  pasteScreenshot: string
  /** GitHub mode: the clipboard was refused, so the screenshot was downloaded. */
  dropScreenshot: string
  /** GitHub mode: the popup was blocked; shown with a link. */
  openIssue: string
}

const defaultMessages: Messages = {
  sent: 'Thanks, your report was sent.',
  failed: "Sorry, your report couldn't be sent.",
  viewIssue: 'View issue',
  pasteScreenshot: 'Screenshot copied. Paste it into the GitHub issue (Cmd+V / Ctrl+V).',
  dropScreenshot: 'Screenshot downloaded. Drag it into the GitHub issue.',
  openIssue: 'Open the GitHub issue',
}

const REPO = /^[\w.-]+\/[\w.-]+$/

/**
 * How a report leaves the page. `direct`: POST to `endpoint`. `relay`: POST to a
 * server connected to `repo`. `github`: open a prefilled issue on github.com.
 */
type Route = 'direct' | 'relay' | 'github'

export default class ReportButton {
  private readonly options: Required<Pick<Options, 'buttonLabel' | 'buttonPosition' | 'showButton' | 'accentColor' | 'penColor' | 'maskSelectors' | 'linkToIssue' | 'relay' | 'githubUrl'>> &
    Options
  private readonly messages: Messages
  private button: HTMLButtonElement | null = null
  private annotation: AnnotationCanvas | null = null
  private setup: SetupPanel | null = null
  private toast: HTMLDivElement | null = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private opening = false
  /** Once the relay says it is connected, it stays that way for this page. */
  private relayConnected = false
  private setupUrl: string | null = null
  private hinted = false

  constructor(opts: Options = {}) {
    this.options = {
      relay: HOSTED_RELAY,
      githubUrl: 'https://github.com',
      buttonLabel: 'Report a problem',
      buttonPosition: 'bottom-right',
      showButton: true,
      accentColor: '#394EFF',
      penColor: '#E53935',
      maskSelectors: DEFAULT_MASK_SELECTORS,
      linkToIssue: false,
      ...opts,
    }
    this.options.relay = this.options.relay.replace(/\/+$/, '')
    this.options.githubUrl = this.options.githubUrl.replace(/\/+$/, '')
    this.messages = { ...defaultMessages, ...(opts.messages ?? {}) }
    if (this.options.showButton) this.mountButton()
  }

  // ---------------------------------------------------------------------------
  // Trigger button
  // ---------------------------------------------------------------------------

  private mountButton() {
    const btn = hide(document.createElement('button'), 'button')
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

  /** True when the button knows where to send reports; false shows the setup panel. */
  get configured(): boolean {
    return !!this.options.endpoint || REPO.test(this.options.repo ?? '')
  }

  /** Capture the viewport and open the annotation overlay. */
  async open(): Promise<void> {
    if (this.annotation || this.opening) return
    if (!this.configured) return this.openSetup()
    this.opening = true
    // Ask the relay while the screenshot renders; the answer picks the submit label.
    const route = this.route()

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

    const via = await route
    const annotation = new AnnotationCanvas({
      penColor: this.options.penColor,
      colors: this.options.colors,
      accentColor: this.options.accentColor,
      notePlaceholder: this.options.notePlaceholder,
      submitLabel: via === 'github' ? 'Open in GitHub' : undefined,
    })
    this.annotation = annotation
    this.opening = false
    annotation.mount({
      screenshot,
      onSubmit: () => {
        if (via === 'github') this.openInGitHub(reportId)
        else void this.submit(reportId, via)
      },
      onCancel: () => this.teardownOverlay(),
    })
  }

  private teardownOverlay() {
    this.annotation?.remove()
    this.annotation = null
    if (this.button) this.button.style.display = ''
  }

  /** Where this report goes: decided per open, so finishing setup needs no reload. */
  private async route(): Promise<Route> {
    if (this.options.endpoint) return 'direct'
    if (this.relayConnected) return 'relay'
    if (!this.options.relay) return 'github'
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    try {
      const res = await fetch(`${this.options.relay}/status?repo=${encodeURIComponent(this.options.repo!)}`, { signal: ctrl.signal })
      const data = (await res.json()) as { connected?: boolean; setupUrl?: string }
      if (typeof data.setupUrl === 'string') this.setupUrl = data.setupUrl
      this.relayConnected = res.ok && data.connected === true
    } catch {
      this.relayConnected = false
    } finally {
      clearTimeout(timer)
    }
    if (!this.relayConnected && !this.hinted) {
      this.hinted = true
      console.info(
        `report-button: reports open as GitHub issues on ${this.options.repo}, so reporters need access to it.` +
          (this.setupUrl ? ` To let anyone report, connect the GitHub App: ${this.setupUrl}` : ''),
      )
    }
    return this.relayConnected ? 'relay' : 'github'
  }

  private async submit(reportId: string, via: Exclude<Route, 'github'>) {
    const annotation = this.annotation
    if (!annotation) return
    annotation.setBusy(true)

    try {
      const payload = await this.buildPayload(reportId, annotation)
      if (via === 'relay') payload.repo = this.options.repo
      const result = await this.send(payload, via === 'relay' ? `${this.options.relay}/report` : this.options.endpoint!)
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

  /**
   * GitHub mode: put the screenshot on the clipboard and open a prefilled new-issue
   * page for the reporter to paste it into. Runs synchronously up to the clipboard
   * write so it happens inside the click that triggered it, which browsers require.
   */
  private openInGitHub(reportId: string) {
    const annotation = this.annotation
    if (!annotation) return
    annotation.setBusy(true, 'Opening…')
    const blob = annotation.toBlob()
    const copied = (async () => {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false
      // A promised blob keeps the write inside the user gesture (Safari needs this).
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return true
    })().catch(() => false)

    void (async () => {
      try {
        const [png, onClipboard, context] = await Promise.all([blob, copied, this.gatherContext()])
        if (!onClipboard) downloadBlob(png, `report-${reportId.slice(0, 8)}.png`)
        const url = this.newIssueUrl(reportId, annotation.getNote(), context)
        window.open(url, '_blank', 'noopener')
        this.teardownOverlay()
        // window.open with noopener returns null whether or not a popup blocker
        // stepped in, so the toast always carries the link too.
        this.showToast(onClipboard ? this.messages.pasteScreenshot : this.messages.dropScreenshot, url, this.messages.openIssue)
      } catch (e) {
        annotation.setBusy(false)
        this.showToast(this.messages.failed)
        this.fail(e, 'could not open GitHub')
      }
    })()
  }

  private newIssueUrl(reportId: string, note: string, context: ReportContext): string {
    const fields = {
      reportId,
      note,
      pageUrl: location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      userAgent: navigator.userAgent,
      language: navigator.language,
      reportedAt: new Date().toISOString(),
      context: stringifyContext(context),
    }
    const make = (f: typeof fields) => {
      const { title, body } = buildIssue(f, null)
      const q = new URLSearchParams({ title, body, labels: 'user-report' })
      return `${this.options.githubUrl}/${this.options.repo}/issues/new?${q}`
    }
    // GitHub refuses very long URLs; drop the extras before the note.
    let url = make(fields)
    if (url.length > 7500) url = make({ ...fields, context: {}, userAgent: '' })
    if (url.length > 7500) url = make({ ...fields, context: {}, userAgent: '', note: note.slice(0, 2000) })
    return url
  }

  private async gatherContext(): Promise<ReportContext> {
    if (!this.options.context) return {}
    try {
      return (await this.options.context()) ?? {}
    } catch (e) {
      console.warn('report-button: context() threw, sending without it', e)
      return {}
    }
  }

  private openSetup() {
    if (this.setup) return
    const relay = this.options.relay
    this.setup = new SetupPanel({
      accentColor: this.options.accentColor,
      snippet: this.options.installSnippet ?? ((repo) => `ReportButton.init({ repo: '${repo}' })`),
      setupUrl: relay
        ? (repo) => `${relay}/setup?repo=${encodeURIComponent(repo)}&origin=${encodeURIComponent(location.origin)}`
        : undefined,
      onClose: () => {
        this.setup?.remove()
        this.setup = null
        if (this.button) this.button.style.display = ''
      },
    })
    if (this.button) this.button.style.display = 'none'
    this.setup.mount()
  }

  private async buildPayload(reportId: string, annotation: AnnotationCanvas): Promise<ReportPayload> {
    const blob = await annotation.toBlob()
    const image = await blobToDataURL(blob)
    const context = await this.gatherContext()

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

  private async send(payload: ReportPayload, endpoint: string): Promise<SubmitResult> {
    const res = await fetch(endpoint, {
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

  private showToast(text: string, link?: string, linkText = this.messages.viewIssue) {
    this.dismissToast()
    const toast = hide(document.createElement('div'), 'toast')
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
      a.textContent = linkText
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
    this.setup?.remove()
    this.setup = null
    this.button?.parentNode?.removeChild(this.button)
    this.button = null
  }
}

function stringifyContext(context: ReportContext): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(context)) if (v !== undefined && v !== null) out[k] = String(v)
  return out
}

function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('report-button: could not read blob'))
    reader.readAsDataURL(blob)
  })
}
