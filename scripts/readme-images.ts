/**
 * Produce the README images: boot the fixture, drive the demo page to the annotated
 * state, capture it, overlay numbered callouts, and capture the resulting issue.
 *
 *   npm run readme-images   ->  docs/annotate.png, docs/issue.png
 */
import { chromium, type Page } from '@playwright/test'
import type { AddressInfo } from 'node:net'
import { createGitHubStub } from '../fixture/github-stub.ts'
import { createApp } from '../src/server/app.ts'
import { configFromEnv } from '../src/server/config.ts'

const VIEWPORT = { width: 1100, height: 720 }
const DPR = 2

// ---------------------------------------------------------------------------
// Boot fixture + server on free ports
// ---------------------------------------------------------------------------

const stub = createGitHubStub()
const stubUrl = await stub.listen()
const app = createApp({
  config: configFromEnv({ GITHUB_TOKEN: 'x', GITHUB_REPO: 'acme/app', GITHUB_API_URL: stubUrl, GITHUB_WEB_URL: stubUrl, RATE_LIMIT: '0' }),
  staticDir: new URL('../dist/', import.meta.url),
  log: () => {},
})
await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DPR })
const role = (r: string) => page.locator(`[data-report-role="${r}"]`)

async function stroke(points: [number, number][]) {
  await page.mouse.move(points[0][0], points[0][1])
  await page.mouse.down()
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y)
  await page.mouse.up()
}

const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 40): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = (i / n) * Math.PI * 2 - Math.PI / 2
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]
  })

interface Rect {
  x: number
  y: number
  width: number
  height: number
}
const box = async (selector: string): Promise<Rect> => {
  const b = await page.locator(selector).boundingBox()
  if (!b) throw new Error(`no box for ${selector}`)
  return b
}

// ---------------------------------------------------------------------------
// 1. The page with the button, then the annotated overlay
// ---------------------------------------------------------------------------

await page.goto(`${appUrl}/demo`)
const buttonRect = await box('[data-report-role="button"]')
const pageShot = await page.screenshot()

const broken = await box('.broken')
await role('button').click()
await role('toolbar').waitFor()

// Circle the broken status with the pen.
await stroke(ellipse(broken.x + broken.width / 2, broken.y + broken.height / 2, broken.width / 2 + 14, broken.height / 2 + 10))
// Box the total line.
await page.getByRole('button', { name: 'Box', exact: true }).click()
await stroke([
  [205, 288],
  [400, 300],
  [545, 318],
])
// Label it.
await page.getByRole('button', { name: 'Text', exact: true }).click()
await page.mouse.click(broken.x + broken.width + 270, broken.y - 6)
await role('text-input').fill('should say "Shipped"')
await page.keyboard.press('Enter')
await role('text-input').waitFor({ state: 'detached' })
await role('note').fill('Order status shows undefined')

const toolbar = await box('[data-report-role="toolbar"]')
const pen = await box('[data-report-role="toolbar"] button:nth-child(2)')
const note = await box('[data-report-role="note"]')
const send = (await page.getByRole('button', { name: 'Send report' }).boundingBox())!
const password = await box('#pw')
const overlayShot = await page.screenshot()

// ---------------------------------------------------------------------------
// 2. Send it, capture the issue as rendered by the fake GitHub
// ---------------------------------------------------------------------------

await page.getByRole('button', { name: 'Send report' }).click()
await role('toast').waitFor()
const issue = stub.issues[0]
if (!issue) throw new Error('no issue was filed')
await page.goto(issue.html_url)
await page.locator('img[alt="Annotated screenshot"]').waitFor()
const issuePage = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: DPR })
await issuePage.goto(issue.html_url)
await issuePage.locator('img[alt="Annotated screenshot"]').waitFor()
await issuePage.screenshot({ path: 'docs/issue.png', fullPage: true })
await issuePage.close()

// ---------------------------------------------------------------------------
// 3. Compose: overlay screenshot + inset of the button + numbered callouts + legend
// ---------------------------------------------------------------------------

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`

interface Callout {
  n: number
  x: number
  y: number
  text: string
}
const callouts: Callout[] = [
  { n: 2, x: password.x + password.width - 24, y: password.y + password.height / 2, text: 'The capture is frozen and shown as-is. Password fields and anything marked data-report-mask are blacked out before it is taken.' },
  { n: 3, x: pen.x + pen.width / 2, y: toolbar.y - 4, text: 'Select, pen, box and text, in five colours, with undo and delete. Shapes stay editable until you send.' },
  { n: 4, x: note.x + note.width / 2, y: note.y + note.height + 4, text: 'A one-line note. Its first line becomes the issue title.' },
  { n: 5, x: send.x + send.width / 2, y: send.y + send.height + 4, text: 'Send files a GitHub issue with the annotated screenshot inline. No database, no bucket.' },
]
const INSET = { w: 180, h: 80 }
const insetCrop = {
  x: VIEWPORT.width - INSET.w,
  y: VIEWPORT.height - INSET.h,
}
const buttonCallout: Callout = {
  n: 1,
  x: 0,
  y: 0,
  text: 'A floating button, added with one <script> tag or an import.',
}

const badge = (n: number, x: number, y: number) => `
  <div class="badge" style="left:${x}px;top:${y}px">${n}</div>`

const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#fff;font:14px/1.45 system-ui,-apple-system,sans-serif;color:#1f2328}
  .wrap{width:${VIEWPORT.width}px;padding:16px;box-sizing:border-box}
  .frame{position:relative;width:${VIEWPORT.width - 32}px;height:${Math.round((VIEWPORT.height * (VIEWPORT.width - 32)) / VIEWPORT.width)}px;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.18);border:1px solid #d0d7de}
  .frame img.main{position:absolute;inset:0;width:100%;height:100%}
  .scale{position:absolute;left:0;top:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;transform-origin:0 0;transform:scale(${(VIEWPORT.width - 32) / VIEWPORT.width})}
  .badge{position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;background:#1f2328;color:#fff;font:700 15px/28px system-ui;text-align:center;box-shadow:0 0 0 3px #fff,0 2px 6px rgba(0,0,0,.4)}
  .inset{position:absolute;right:14px;top:14px;width:${INSET.w}px;height:${INSET.h}px;border-radius:8px;overflow:hidden;box-shadow:0 0 0 3px #fff,0 4px 14px rgba(0,0,0,.35);background:#fafafa}
  .inset img{position:absolute;left:-${insetCrop.x}px;top:-${insetCrop.y}px;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px}
  .inset .cap{position:absolute;left:0;right:0;top:0;padding:6px 10px;font:600 12px system-ui;color:#656d76;background:linear-gradient(#fafafa,rgba(250,250,250,0))}
  .legend{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-top:14px}
  .legend div{display:flex;gap:10px;align-items:flex-start}
  .legend .badge{position:static;margin:1px 0 0;flex:none;box-shadow:none;width:24px;height:24px;line-height:24px;font-size:13px}
  .legend code{font:12px ui-monospace,monospace;background:#f6f8fa;padding:0 4px;border-radius:4px}
</style>
<div class="wrap">
  <div class="frame">
    <img class="main" src="${dataUrl(overlayShot)}">
    <div class="scale">
      ${callouts.map((c) => badge(c.n, c.x, c.y)).join('')}
      <div class="inset">
        <img src="${dataUrl(pageShot)}">
        <div class="cap">Before clicking</div>
        ${badge(1, buttonRect.x - insetCrop.x - 14, buttonRect.y - insetCrop.y + buttonRect.height / 2)}
      </div>
    </div>
  </div>
  <div class="legend">
    ${[buttonCallout, ...callouts]
      .map((c) => `<div><span class="badge">${c.n}</span><span>${c.text.replace(/data-report-mask|<script>/g, (m) => `<code>${m.replace('<', '&lt;')}</code>`)}</span></div>`)
      .join('')}
  </div>
</div>`

const compose = await browser.newPage({ viewport: { width: VIEWPORT.width, height: 900 }, deviceScaleFactor: DPR })
await compose.setContent(html)
await compose.locator('.wrap').screenshot({ path: 'docs/annotate.png' })
await compose.close()

await browser.close()
app.close()
await stub.close()
console.log(`wrote docs/annotate.png and docs/issue.png (issue: ${issue.title})`)
