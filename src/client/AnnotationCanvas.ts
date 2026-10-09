import { Z_TOP, hide } from './dom.ts'

export interface AnnotationCanvasOptions {
  /** Colour selected when the overlay opens. */
  penColor: string
  /** Swatches offered in the toolbar. */
  colors?: string[]
  /** Freehand stroke width in CSS pixels. */
  penWidth?: number
  /** Accent colour for the active tool, selection outline and submit button. */
  accentColor?: string
  /** Placeholder for the note field. */
  notePlaceholder?: string
  /** Label on the submit button. */
  submitLabel?: string
}

type Tool = 'select' | 'pen' | 'box' | 'text'

type Base = { id: number }
type PenShape = Base & { kind: 'pen'; color: string; width: number; points: [number, number][] }
type BoxShape = Base & {
  kind: 'box'
  color: string
  width: number
  x: number
  y: number
  w: number
  h: number
}
type TextShape = Base & {
  kind: 'text'
  color: string
  size: number
  x: number
  y: number
  text: string
}

type Shape = PenShape | BoxShape | TextShape
/** Text is committed straight from its input, so it never exists as an in-progress draft. */
type DraftShape = PenShape | BoxShape

interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

const DEFAULT_COLORS = ['#E53935', '#FB8C00', '#1E88E5', '#43A047', '#000000']
const TEXT_SIZE = 20
const BOX_WIDTH = 3
const HIT_TOLERANCE = 8
const HISTORY_LIMIT = 50
const FONT = 'system-ui, -apple-system, sans-serif'

const clone = (s: Shape): Shape =>
  s.kind === 'pen' ? { ...s, points: s.points.map((p) => [p[0], p[1]] as [number, number]) } : { ...s }

/** Distance from a point to a line segment; used to hit-test freehand strokes. */
function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * Markup overlay for a report: select/move, freehand pen, rectangles and text, in a
 * handful of colours, with undo and delete, plus a one-line note.
 *
 * Shapes are *retained* rather than painted straight onto the canvas. Immediate-mode
 * drawing can't rubber-band a rectangle while it's dragged, can't undo, and can't move
 * anything after the fact, since a committed stroke is only pixels. Keeping the list and
 * repainting gives all three; the canvas is still flattened to pixels at export time.
 */
export default class AnnotationCanvas {
  private readonly canvas: HTMLCanvasElement
  private readonly toolbar: HTMLDivElement
  private ctx: CanvasRenderingContext2D | null = null

  private readonly colors: string[]
  private readonly penWidth: number
  private readonly accent: string
  private color: string
  private tool: Tool = 'pen'

  private shapes: Shape[] = []
  private draft: DraftShape | null = null
  private drawing = false
  private nextId = 1

  private selectedId: number | null = null
  private drag: { id: number; lastX: number; lastY: number; moved: boolean } | null = null

  /** Snapshots taken before each mutation. A plain pop() would be wrong once shapes can
   *  be moved or deleted, since "undo" would no longer mean "remove the newest shape". */
  private history: Shape[][] = []

  /** The frozen capture the user annotates, shown as an opaque backdrop. */
  private screenshot: HTMLCanvasElement | null = null
  private textInput: HTMLInputElement | null = null
  private noteInput: HTMLInputElement | null = null
  private undoButton: HTMLButtonElement | null = null
  private deleteButton: HTMLButtonElement | null = null
  private submitButton: HTMLButtonElement | null = null
  private cancelButton: HTMLButtonElement | null = null
  private readonly submitLabel: string
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>()
  private readonly colorButtons = new Map<string, HTMLButtonElement>()

  private onSubmit: (() => void) | null = null
  private onCancel: (() => void) | null = null

  constructor(opts: AnnotationCanvasOptions) {
    this.colors = opts.colors?.length ? opts.colors : DEFAULT_COLORS
    this.color = opts.penColor || this.colors[0]
    this.penWidth = opts.penWidth ?? 6
    this.accent = opts.accentColor ?? '#394EFF'
    this.submitLabel = opts.submitLabel ?? 'Send report'

    this.canvas = hide(document.createElement('canvas'))
    Object.assign(this.canvas.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      // touch-action:none stops touch drags from scrolling the page underneath.
      touchAction: 'none',
      cursor: 'crosshair',
      zIndex: String(Z_TOP - 2),
    })

    this.toolbar = this.buildToolbar(opts.notePlaceholder ?? 'What went wrong? (optional)')
  }

  // ---------------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------------

  private button(label: string, title: string): HTMLButtonElement {
    const b = hide(document.createElement('button'))
    b.type = 'button'
    b.textContent = label
    b.title = title
    Object.assign(b.style, {
      padding: '6px 10px',
      border: '1px solid transparent',
      borderRadius: '6px',
      background: 'transparent',
      color: '#333',
      font: `500 13px ${FONT}`,
      cursor: 'pointer',
      lineHeight: '1',
      whiteSpace: 'nowrap',
    })
    return b
  }

  private separator(): HTMLDivElement {
    const s = hide(document.createElement('div'))
    Object.assign(s.style, {
      width: '1px',
      alignSelf: 'stretch',
      background: '#e0e0e0',
      margin: '0 2px',
    })
    return s
  }

  private buildToolbar(notePlaceholder: string): HTMLDivElement {
    const bar = hide(document.createElement('div'))
    Object.assign(bar.style, {
      position: 'fixed',
      left: '50%',
      bottom: '20px',
      transform: 'translateX(-50%)',
      display: 'flex',
      flexWrap: 'wrap',
      justifyContent: 'center',
      alignItems: 'center',
      gap: '4px',
      padding: '6px',
      maxWidth: 'calc(100vw - 32px)',
      boxSizing: 'border-box',
      borderRadius: '10px',
      background: '#fff',
      boxShadow: '0 4px 16px rgba(0,0,0,0.22)',
      zIndex: String(Z_TOP - 1),
      fontFamily: FONT,
    })

    const tools: [Tool, string, string][] = [
      ['select', 'Select', 'Select and move annotations (Delete removes)'],
      ['pen', 'Pen', 'Draw freehand'],
      ['box', 'Box', 'Draw a rectangle'],
      ['text', 'Text', 'Click to add text'],
    ]
    for (const [tool, label, title] of tools) {
      const b = this.button(label, title)
      b.addEventListener('click', () => this.setTool(tool))
      this.toolButtons.set(tool, b)
      bar.appendChild(b)
    }

    bar.appendChild(this.separator())

    for (const c of this.colors) {
      const b = hide(document.createElement('button'))
      b.type = 'button'
      b.title = c
      Object.assign(b.style, {
        width: '20px',
        height: '20px',
        padding: '0',
        borderRadius: '50%',
        background: c,
        border: '2px solid transparent',
        cursor: 'pointer',
        flexShrink: '0',
      })
      b.addEventListener('click', () => this.setColor(c))
      this.colorButtons.set(c, b)
      bar.appendChild(b)
    }

    bar.appendChild(this.separator())

    const del = this.button('Delete', 'Delete the selected annotation')
    del.addEventListener('click', () => this.deleteSelected())
    this.deleteButton = del
    bar.appendChild(del)

    const undo = this.button('Undo', 'Undo the last change')
    undo.addEventListener('click', () => this.undo())
    this.undoButton = undo
    bar.appendChild(undo)

    bar.appendChild(this.separator())

    const note = hide(document.createElement('input'))
    note.type = 'text'
    note.placeholder = notePlaceholder
    note.maxLength = 500
    Object.assign(note.style, {
      flex: '1 1 220px',
      minWidth: '160px',
      padding: '6px 8px',
      border: '1px solid #ccc',
      borderRadius: '6px',
      font: `13px ${FONT}`,
      color: '#222',
      background: '#fff',
      outline: 'none',
    })
    // Keep the canvas's Delete/Backspace shortcut from firing while typing a note.
    note.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        this.submit()
      }
    })
    this.noteInput = note
    bar.appendChild(note)

    const cancel = this.button('Cancel', 'Discard this report')
    cancel.style.border = '1px solid #ccc'
    cancel.addEventListener('click', () => {
      this.discardTextInput()
      this.onCancel?.()
    })
    this.cancelButton = cancel
    bar.appendChild(cancel)

    const submit = this.button(this.submitLabel, 'Send this report')
    Object.assign(submit.style, {
      background: this.accent,
      color: '#fff',
      padding: '6px 14px',
    })
    submit.addEventListener('click', () => this.submit())
    this.submitButton = submit
    bar.appendChild(submit)

    return bar
  }

  private submit() {
    // Commit anything still being typed so it isn't silently dropped.
    this.commitTextInput()
    this.onSubmit?.()
  }

  private setTool(tool: Tool) {
    this.commitTextInput()
    this.tool = tool
    if (tool !== 'select') this.selectedId = null
    this.canvas.style.cursor = tool === 'text' ? 'text' : tool === 'select' ? 'default' : 'crosshair'
    this.redraw()
    this.syncToolbar()
  }

  private setColor(color: string) {
    this.color = color
    if (this.textInput) this.textInput.style.color = color
    // Recolour the current selection, so the palette works on existing shapes too.
    const selected = this.selected()
    if (selected) {
      this.pushHistory()
      selected.color = color
      this.redraw()
    }
    this.syncToolbar()
  }

  private syncToolbar() {
    this.toolButtons.forEach((b, tool) => {
      const active = tool === this.tool
      b.style.background = active ? '#EEF1FF' : 'transparent'
      b.style.borderColor = active ? this.accent : 'transparent'
      b.style.color = active ? this.accent : '#333'
    })
    this.colorButtons.forEach((b, color) => {
      b.style.borderColor = color === this.color ? '#333' : 'transparent'
    })
    const setEnabled = (b: HTMLButtonElement | null, enabled: boolean) => {
      if (!b) return
      b.disabled = !enabled
      b.style.opacity = enabled ? '1' : '0.4'
      b.style.cursor = enabled ? 'pointer' : 'default'
    }
    setEnabled(this.undoButton, this.history.length > 0)
    setEnabled(this.deleteButton, this.selectedId !== null)
  }

  /** The note typed into the toolbar, trimmed. */
  getNote(): string {
    return this.noteInput?.value.trim() ?? ''
  }

  /**
   * Lock the toolbar while the report is in flight so a double-click cannot file
   * two issues, and show progress on the submit button.
   */
  setBusy(busy: boolean, label = 'Sending…') {
    const controls = [
      ...this.toolButtons.values(),
      ...this.colorButtons.values(),
      this.undoButton,
      this.deleteButton,
      this.cancelButton,
      this.submitButton,
      this.noteInput,
    ]
    for (const c of controls) {
      if (c) c.disabled = busy
    }
    if (this.submitButton) {
      this.submitButton.textContent = busy ? label : this.submitLabel
      this.submitButton.style.opacity = busy ? '0.7' : '1'
    }
    this.canvas.style.pointerEvents = busy ? 'none' : ''
    if (!busy) this.syncToolbar()
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  private pushHistory() {
    this.history.push(this.shapes.map(clone))
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
  }

  undo() {
    const previous = this.history.pop()
    if (!previous) return
    this.shapes = previous
    // The selected shape may not exist in the restored state.
    if (!this.shapes.some((s) => s.id === this.selectedId)) this.selectedId = null
    this.redraw()
    this.syncToolbar()
  }

  private selected(): Shape | undefined {
    return this.shapes.find((s) => s.id === this.selectedId)
  }

  private deleteSelected() {
    if (this.selectedId === null) return
    this.pushHistory()
    this.shapes = this.shapes.filter((s) => s.id !== this.selectedId)
    this.selectedId = null
    this.redraw()
    this.syncToolbar()
  }

  // ---------------------------------------------------------------------------
  // Hit testing
  // ---------------------------------------------------------------------------

  private boundsOf(s: Shape): Bounds {
    if (s.kind === 'pen') {
      const xs = s.points.map((p) => p[0])
      const ys = s.points.map((p) => p[1])
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
    }
    if (s.kind === 'box') {
      return {
        x: Math.min(s.x, s.x + s.w),
        y: Math.min(s.y, s.y + s.h),
        w: Math.abs(s.w),
        h: Math.abs(s.h),
      }
    }
    let width = s.text.length * s.size * 0.55
    if (this.ctx) {
      this.ctx.font = `600 ${s.size}px ${FONT}`
      width = this.ctx.measureText(s.text).width
    }
    return { x: s.x, y: s.y, w: width, h: s.size * 1.2 }
  }

  private hits(s: Shape, x: number, y: number): boolean {
    if (s.kind === 'pen') {
      const tolerance = Math.max(HIT_TOLERANCE, s.width)
      for (let i = 1; i < s.points.length; i++) {
        const [x1, y1] = s.points[i - 1]
        const [x2, y2] = s.points[i]
        if (distanceToSegment(x, y, x1, y1, x2, y2) <= tolerance) return true
      }
      return false
    }

    const b = this.boundsOf(s)
    if (s.kind === 'text') {
      return x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4
    }

    // A box is hollow, so hit-test its edges rather than its interior. Otherwise a
    // rectangle drawn around other annotations would swallow every click inside it.
    const nearX = x >= b.x - HIT_TOLERANCE && x <= b.x + b.w + HIT_TOLERANCE
    const nearY = y >= b.y - HIT_TOLERANCE && y <= b.y + b.h + HIT_TOLERANCE
    const onVertical = Math.abs(x - b.x) <= HIT_TOLERANCE || Math.abs(x - (b.x + b.w)) <= HIT_TOLERANCE
    const onHorizontal = Math.abs(y - b.y) <= HIT_TOLERANCE || Math.abs(y - (b.y + b.h)) <= HIT_TOLERANCE
    return (onVertical && nearY) || (onHorizontal && nearX)
  }

  /** Topmost shape under the point, matching what the user sees painted last. */
  private hitTest(x: number, y: number): Shape | null {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      if (this.hits(this.shapes[i], x, y)) return this.shapes[i]
    }
    return null
  }

  private translate(s: Shape, dx: number, dy: number) {
    if (s.kind === 'pen') {
      for (const p of s.points) {
        p[0] += dx
        p[1] += dy
      }
    } else {
      s.x += dx
      s.y += dy
    }
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  /**
   * Size the drawing surface to the frozen capture, once.
   *
   * The coordinate space is deliberately *not* re-derived from the live window: the
   * screenshot is frozen at capture time, so the space the annotations live in has to
   * be frozen with it. Backing store in device pixels, CSS box in viewport pixels, so
   * the capture composites 1:1 and pointer events need no conversion.
   */
  private sizeCanvas(cssWidth: number, cssHeight: number, dpr: number) {
    this.canvas.style.width = `${cssWidth}px`
    this.canvas.style.height = `${cssHeight}px`
    this.canvas.width = Math.round(cssWidth * dpr)
    this.canvas.height = Math.round(cssHeight * dpr)
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.redraw()
  }

  /** Stop wheel/touch scrolling from moving the live page out from under the overlay. */
  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault()
  }

  private drawShape(ctx: CanvasRenderingContext2D, s: Shape) {
    ctx.globalAlpha = 1
    ctx.strokeStyle = s.color
    ctx.fillStyle = s.color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.setLineDash([])

    if (s.kind === 'pen') {
      if (s.points.length < 2) return
      ctx.lineWidth = s.width
      ctx.beginPath()
      ctx.moveTo(s.points[0][0], s.points[0][1])
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i][0], s.points[i][1])
      ctx.stroke()
      return
    }

    if (s.kind === 'box') {
      ctx.lineWidth = s.width
      ctx.strokeRect(s.x, s.y, s.w, s.h)
      return
    }

    ctx.font = `600 ${s.size}px ${FONT}`
    ctx.textBaseline = 'top'
    // Outline first so the text stays legible over dark or busy screenshots.
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.strokeText(s.text, s.x, s.y)
    ctx.fillText(s.text, s.x, s.y)
  }

  private drawSelection(ctx: CanvasRenderingContext2D, s: Shape) {
    const b = this.boundsOf(s)
    const pad = 6
    ctx.save()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2)
    ctx.restore()
  }

  private redraw() {
    const ctx = this.ctx
    if (!ctx) return
    // Clear the whole backing store, ignoring the device-pixel transform.
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.restore()
    for (const s of this.shapes) this.drawShape(ctx, s)
    if (this.draft) this.drawShape(ctx, this.draft)
    const selected = this.selected()
    if (selected) this.drawSelection(ctx, selected)
  }

  // ---------------------------------------------------------------------------
  // Text entry
  // ---------------------------------------------------------------------------

  /**
   * Text is typed into a real input positioned over the click point, rather than
   * synthesised from keydown events on the canvas: that gets caret movement, IME,
   * selection and mobile keyboards for free.
   */
  private openTextInput(x: number, y: number) {
    this.commitTextInput()

    const input = hide(document.createElement('input'))
    input.type = 'text'
    input.placeholder = 'Type, then press Enter'
    Object.assign(input.style, {
      position: 'fixed',
      left: `${x}px`,
      top: `${y}px`,
      zIndex: String(Z_TOP - 1),
      font: `600 ${TEXT_SIZE}px ${FONT}`,
      color: this.color,
      background: 'rgba(255,255,255,0.92)',
      border: `1px dashed ${this.accent}`,
      borderRadius: '4px',
      padding: '2px 4px',
      outline: 'none',
      minWidth: '160px',
    })
    input.dataset.x = String(x)
    input.dataset.y = String(y)

    input.addEventListener('keydown', (e) => {
      // Also keeps Backspace here from reaching the canvas delete shortcut.
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        this.commitTextInput()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.discardTextInput()
      }
    })
    // Clicking elsewhere commits rather than discards, but only once the field has
    // actually held focus. Focusing mid-pointerdown otherwise blurs the moment the
    // browser finishes the click, tearing the field down before anything is typed.
    input.addEventListener('focus', () => input.addEventListener('blur', () => this.commitTextInput()), {
      once: true,
    })

    document.body.appendChild(input)
    this.textInput = input
    // Deferred so the in-flight pointer sequence can't pull focus straight back.
    requestAnimationFrame(() => input.focus())
  }

  private commitTextInput() {
    const input = this.textInput
    if (!input) return
    // Cleared first so the blur handler can't re-enter this.
    this.textInput = null
    const text = input.value.trim()
    const x = Number(input.dataset.x ?? 0)
    const y = Number(input.dataset.y ?? 0)
    input.parentNode?.removeChild(input)
    if (text) {
      this.pushHistory()
      // Offset by the input's border+padding so the committed text lands where the
      // caret was, rather than jumping a few pixels up and left.
      this.shapes.push({
        id: this.nextId++,
        kind: 'text',
        color: this.color,
        size: TEXT_SIZE,
        x: x + 5,
        y: y + 3,
        text,
      })
      this.redraw()
      this.syncToolbar()
    }
  }

  private discardTextInput() {
    const input = this.textInput
    if (!input) return
    this.textInput = null
    input.parentNode?.removeChild(input)
  }

  // ---------------------------------------------------------------------------
  // Pointer handling
  // ---------------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent) => {
    if (this.tool === 'text') {
      // Suppress the compatibility mouse events that would move focus off the field
      // we are about to create.
      e.preventDefault()
      this.openTextInput(e.clientX, e.clientY)
      return
    }

    // An open text box commits when the user starts doing something else.
    this.commitTextInput()

    if (this.tool === 'select') {
      const hit = this.hitTest(e.clientX, e.clientY)
      this.selectedId = hit ? hit.id : null
      this.drag = hit ? { id: hit.id, lastX: e.clientX, lastY: e.clientY, moved: false } : null
      if (hit) this.canvas.setPointerCapture?.(e.pointerId)
      this.redraw()
      this.syncToolbar()
      return
    }

    this.canvas.setPointerCapture?.(e.pointerId)
    this.drawing = true
    this.draft =
      this.tool === 'pen'
        ? { id: this.nextId++, kind: 'pen', color: this.color, width: this.penWidth, points: [[e.clientX, e.clientY]] }
        : { id: this.nextId++, kind: 'box', color: this.color, width: BOX_WIDTH, x: e.clientX, y: e.clientY, w: 0, h: 0 }
  }

  private readonly onPointerMove = (e: PointerEvent) => {
    if (this.tool === 'select') {
      if (this.drag) {
        const shape = this.shapes.find((s) => s.id === this.drag!.id)
        if (shape) {
          // Snapshot once per drag, before the first movement, so undo steps back over
          // the whole gesture rather than each pointermove.
          if (!this.drag.moved) {
            this.pushHistory()
            this.drag.moved = true
            this.syncToolbar()
          }
          this.translate(shape, e.clientX - this.drag.lastX, e.clientY - this.drag.lastY)
          this.drag.lastX = e.clientX
          this.drag.lastY = e.clientY
          this.redraw()
        }
      } else {
        // Hover feedback so it's discoverable that things can be grabbed.
        this.canvas.style.cursor = this.hitTest(e.clientX, e.clientY) ? 'move' : 'default'
      }
      return
    }

    if (!this.drawing || !this.draft) return
    if (this.draft.kind === 'pen') {
      this.draft.points.push([e.clientX, e.clientY])
    } else {
      this.draft.w = e.clientX - this.draft.x
      this.draft.h = e.clientY - this.draft.y
    }
    this.redraw()
  }

  private readonly onPointerUp = () => {
    if (this.drag) {
      this.drag = null
      return
    }
    if (!this.drawing) return
    this.drawing = false
    const draft = this.draft
    this.draft = null
    if (draft) {
      // Drop degenerate shapes from a stray click so undo isn't full of no-ops.
      const meaningful =
        draft.kind === 'pen' ? draft.points.length > 1 : Math.abs(draft.w) > 4 && Math.abs(draft.h) > 4
      if (meaningful) {
        this.pushHistory()
        this.shapes.push(draft)
      }
    }
    this.redraw()
    this.syncToolbar()
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    // Typing in the text or note fields stops propagation, so this never sees it.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedId === null) return
      // Backspace would otherwise navigate back in some browsers.
      e.preventDefault()
      this.deleteSelected()
    } else if (e.key === 'Escape') {
      if (this.selectedId === null) return
      e.preventDefault()
      this.selectedId = null
      this.redraw()
      this.syncToolbar()
    }
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  /** Draw the screenshot into a fresh canvas, then the annotations over it. */
  composite(): HTMLCanvasElement {
    const screenshot = this.screenshot
    if (!screenshot) throw new Error('report-button: composite() before mount()')
    this.commitTextInput()
    // The selection outline is editing chrome, not annotation. Repaint without it so
    // it can't end up baked into the uploaded image.
    const previouslySelected = this.selectedId
    this.selectedId = null
    this.redraw()

    const out = document.createElement('canvas')
    out.width = screenshot.width
    out.height = screenshot.height
    const octx = out.getContext('2d')
    if (!octx) {
      this.selectedId = previouslySelected
      this.redraw()
      return screenshot
    }
    octx.drawImage(screenshot, 0, 0, out.width, out.height)
    octx.drawImage(this.canvas, 0, 0, out.width, out.height)

    this.selectedId = previouslySelected
    this.redraw()
    return out
  }

  /** Composite + encode the annotated screenshot as a PNG blob. */
  toBlob(): Promise<Blob> {
    const composed = this.composite()
    return new Promise((resolve, reject) => {
      composed.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('report-button: failed to encode annotation blob'))
      }, 'image/png')
    })
  }

  // ---------------------------------------------------------------------------

  mount(handlers: { screenshot: HTMLCanvasElement; onSubmit: () => void; onCancel: () => void }) {
    this.onSubmit = handlers.onSubmit
    this.onCancel = handlers.onCancel
    this.screenshot = handlers.screenshot

    const dpr = window.devicePixelRatio || 1
    const cssWidth = handlers.screenshot.width / dpr
    const cssHeight = handlers.screenshot.height / dpr

    // Show the capture itself as an opaque backdrop, so the user annotates exactly the
    // image that gets sent. Annotating the live page instead meant any scroll between
    // two marks desynchronised them from the frozen screenshot, and it hid the privacy
    // masking, so people never saw which fields had been blacked out.
    const backdrop = hide(handlers.screenshot)
    Object.assign(backdrop.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${cssWidth}px`,
      height: `${cssHeight}px`,
      zIndex: String(Z_TOP - 3),
    })
    document.body.appendChild(backdrop)

    document.body.appendChild(this.canvas)
    document.body.appendChild(this.toolbar)
    this.ctx = this.canvas.getContext('2d')
    this.sizeCanvas(cssWidth, cssHeight, dpr)
    this.syncToolbar()

    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('keydown', this.onKeyDown)
  }

  remove() {
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('keydown', this.onKeyDown)

    this.discardTextInput()
    this.screenshot?.parentNode?.removeChild(this.screenshot)
    this.canvas.parentNode?.removeChild(this.canvas)
    this.toolbar.parentNode?.removeChild(this.toolbar)
  }
}
