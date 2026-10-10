import { Z_TOP, hide } from './dom.ts'

const FONT = 'system-ui, -apple-system, sans-serif'
const REPO = /^[\w.-]+\/[\w.-]+$/

export interface SetupPanelOptions {
  accentColor: string
  /** The line to paste once the repo is known. */
  snippet: (repo: string) => string
  /** The relay's setup page for a repo, when there is a relay. */
  setupUrl?: (repo: string) => string
  onClose: () => void
}

/**
 * Shown instead of the report flow when the button does not know which repo to file
 * into yet: asks for it and hands back the tag to paste.
 */
export default class SetupPanel {
  private readonly root: HTMLDivElement

  constructor(opts: SetupPanelOptions) {
    const root = hide(document.createElement('div'), 'setup')
    Object.assign(root.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      width: '420px',
      maxWidth: 'calc(100vw - 32px)',
      boxSizing: 'border-box',
      padding: '18px 20px',
      borderRadius: '12px',
      background: '#fff',
      color: '#222',
      boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
      font: `14px/1.5 ${FONT}`,
      zIndex: String(Z_TOP - 1),
    })

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration> = {}, text = '') => {
      const e = hide(document.createElement(tag))
      Object.assign(e.style, style)
      if (text) e.textContent = text
      return e
    }

    const title = el('div', { font: `600 16px ${FONT}`, marginBottom: '4px' }, 'Connect report-button')
    const intro = el('p', { margin: '0 0 10px', color: '#555' }, 'Which GitHub repo should reports go to?')

    const input = hide(el('input', {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      border: '1px solid #ccc',
      borderRadius: '8px',
      font: `14px ${FONT}`,
      color: '#222',
      background: '#fff',
    }), 'setup-repo')
    input.placeholder = 'owner/repo'
    input.setAttribute('aria-label', 'GitHub repository')

    const step = el('p', { margin: '12px 0 6px', color: '#555' }, 'Then replace your script tag with this one:')
    const code = hide(el('pre', {
      margin: '0',
      padding: '10px 12px',
      background: '#f3f4f6',
      borderRadius: '8px',
      font: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
    }), 'setup-snippet')

    const row = el('div', { display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' })
    const copy = el('button', {
      padding: '7px 14px',
      border: 'none',
      borderRadius: '8px',
      background: opts.accentColor,
      color: '#fff',
      font: `600 13px ${FONT}`,
      cursor: 'pointer',
    }, 'Copy')
    copy.type = 'button'
    const close = el('button', {
      padding: '7px 12px',
      border: '1px solid #ccc',
      borderRadius: '8px',
      background: '#fff',
      color: '#333',
      font: `13px ${FONT}`,
      cursor: 'pointer',
    }, 'Close')
    close.type = 'button'
    row.append(copy, close)

    const after = el('p', { margin: '12px 0 0', color: '#555', fontSize: '13px' })
    const appLink = hide(el('a', { color: opts.accentColor }, 'install the GitHub App'))
    appLink.target = '_blank'
    appLink.rel = 'noopener'

    const update = () => {
      const repo = input.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '')
      const ok = REPO.test(repo)
      code.textContent = opts.snippet(ok ? repo : 'owner/repo')
      copy.disabled = !ok
      copy.style.opacity = ok ? '1' : '0.5'
      after.textContent = 'Anyone who can open issues on the repo can report right away. '
      if (opts.setupUrl && ok) {
        appLink.href = opts.setupUrl(repo)
        after.append('To let anyone report, without a GitHub account, ', appLink, '.')
      }
    }
    input.addEventListener('input', update)
    input.addEventListener('keydown', (e) => e.stopPropagation())
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(code.textContent ?? '').then(() => {
        copy.textContent = 'Copied'
        setTimeout(() => (copy.textContent = 'Copy'), 1500)
      })
    })
    close.addEventListener('click', () => opts.onClose())
    update()

    root.append(title, intro, input, step, code, row, after)
    this.root = root
  }

  mount() {
    document.body.appendChild(this.root)
    this.root.querySelector('input')?.focus()
  }

  remove() {
    this.root.parentNode?.removeChild(this.root)
  }
}
