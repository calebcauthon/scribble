/**
 * Produce the README screenshot of the annotation overlay, untouched, and file the
 * report it shows.
 *
 *   npm run readme-images                    ->  docs/annotate.png, filed on the fake GitHub
 *   GITHUB_TOKEN=$(gh auth token) GITHUB_REPO=you/app npm run readme-images
 *                                            ->  docs/annotate.png, filed on real GitHub
 *
 * With a real repo the script prints the issue URL; screenshot that page yourself
 * (a private repo's issue needs your logged-in browser) and save it as docs/issue.png.
 */
import { chromium } from '@playwright/test'
import type { AddressInfo } from 'node:net'
import { createGitHubStub } from '../fixture/github-stub.ts'
import { createApp } from '../src/server/app.ts'
import { configFromEnv } from '../src/server/config.ts'

const VIEWPORT = { width: 1100, height: 720 }
const DPR = 2
const real = !!process.env.GITHUB_TOKEN

const stub = real ? null : createGitHubStub()
const stubUrl = await stub?.listen()
const config = real
  ? configFromEnv({ ...process.env, RATE_LIMIT: '0' })
  : configFromEnv({ GITHUB_TOKEN: 'x', GITHUB_REPO: 'acme/app', GITHUB_API_URL: stubUrl, GITHUB_WEB_URL: stubUrl, RATE_LIMIT: '0' })
const app = createApp({ config, staticDir: new URL('../dist/', import.meta.url), log: () => {} })
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

await page.goto(`${appUrl}/demo`)
const broken = (await page.locator('.broken').boundingBox())!
await role('button').click()
await role('toolbar').waitFor()

// Circle the broken status, box the total line, label it, write the note.
await stroke(ellipse(broken.x + broken.width / 2, broken.y + broken.height / 2, broken.width / 2 + 14, broken.height / 2 + 10))
await page.getByRole('button', { name: 'Box', exact: true }).click()
await stroke([
  [205, 288],
  [400, 300],
  [545, 318],
])
await page.getByRole('button', { name: 'Text', exact: true }).click()
await page.mouse.click(broken.x + broken.width + 270, broken.y - 6)
await role('text-input').fill('should say "Shipped"')
await page.keyboard.press('Enter')
await role('text-input').waitFor({ state: 'detached' })
await role('note').fill('Order status shows undefined')
await page.screenshot({ path: 'docs/annotate.png' })

const filed = page.waitForResponse((r) => r.url().endsWith('/report') && r.request().method() === 'POST')
await page.getByRole('button', { name: 'Send report' }).click()
const res = await filed
const body = (await res.json()) as { issueUrl?: string; error?: string }

await browser.close()
app.close()
await stub?.close()
if (!body.issueUrl) throw new Error(`report failed: ${res.status()} ${body.error}`)
console.log(`wrote docs/annotate.png; filed ${body.issueUrl}`)
