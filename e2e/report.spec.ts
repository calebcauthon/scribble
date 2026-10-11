import { test, expect, type Page } from '@playwright/test'

const GITHUB = 'http://localhost:8790'
const shot = (name: string) => ({ path: `e2e/screenshots/${name}.png` })

const role = (page: Page, r: string) => page.locator(`[data-report-role="${r}"]`)

/** Draw a stroke on the annotation canvas from (x1,y1) to (x2,y2) with a few waypoints. */
async function drag(page: Page, x1: number, y1: number, x2: number, y2: number) {
  await page.mouse.move(x1, y1)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8)
  }
  await page.mouse.up()
}

test.beforeEach(async ({ request }) => {
  await request.get(`${GITHUB}/_fixture/reset`)
})

test('annotate a screenshot and file it as an issue', async ({ page, request }) => {
  await page.goto('/demo')
  await expect(role(page, 'button')).toHaveText('Report a problem')
  await page.screenshot(shot('1-page'))

  await role(page, 'button').click()
  await expect(role(page, 'toolbar')).toBeVisible()
  await expect(role(page, 'screenshot')).toBeVisible()
  // The trigger hides itself while the overlay is up so it can't appear in the capture.
  await expect(role(page, 'button')).toBeHidden()
  await page.screenshot(shot('2-overlay'))

  // Pen (the default tool): circle-ish stroke around the broken status line.
  await drag(page, 120, 200, 420, 215)
  // Box.
  await page.getByRole('button', { name: 'Box', exact: true }).click()
  await drag(page, 90, 160, 500, 240)
  // Text.
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page.mouse.click(520, 170)
  await role(page, 'text-input').fill('status is undefined')
  await page.keyboard.press('Enter')
  await expect(role(page, 'text-input')).toHaveCount(0)
  // Note: first line becomes the issue title.
  await role(page, 'note').fill('Order status shows undefined')
  await page.screenshot(shot('3-annotated'))

  await page.getByRole('button', { name: 'Send report' }).click()
  await expect(role(page, 'toast')).toContainText('Thanks, your report was sent.')
  await expect(role(page, 'toolbar')).toHaveCount(0)
  await expect(role(page, 'button')).toBeVisible()
  await page.screenshot(shot('4-sent'))

  // What landed on the fake GitHub.
  const issues = await (await request.get(`${GITHUB}/_fixture/issues`)).json()
  expect(issues).toHaveLength(1)
  const issue = issues[0]
  expect(issue.title).toBe('Order status shows undefined')
  expect(issue.labels).toEqual(['user-report'])
  expect(issue.body).toContain('> Order status shows undefined')
  expect(issue.body).toMatch(/\| \*\*Page\*\* \| http:\/\/localhost:8787\/demo \|/)
  expect(issue.body).toMatch(/\| \*\*Demo user\*\* \| pat@example\.com \|/)
  expect(issue.body).toMatch(/\| \*\*Viewport\*\* \| 1100×720 \|/)

  // The inline image resolves to a real PNG of the viewport.
  const imageUrl = /!\[Annotated screenshot\]\((.*?)\)/.exec(issue.body)![1]
  expect(imageUrl).toMatch(new RegExp(`^${GITHUB}/acme/app/blob/report-screenshots/\\d{4}-\\d{2}-\\d{2}/[\\w-]+\\.png\\?raw=true$`))
  const image = await request.get(imageUrl)
  expect(image.status()).toBe(200)
  expect(image.headers()['content-type']).toBe('image/png')
  const bytes = await image.body()
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  expect(bytes.length).toBeGreaterThan(5000)

  // The issue as a reviewer would see it.
  await page.goto(issue.html_url)
  await expect(page.locator('img[alt="Annotated screenshot"]')).toBeVisible()
  await page.screenshot({ ...shot('5-issue'), fullPage: true })
})

test('masks the password field and data-report-mask content before capture', async ({ page }) => {
  await page.goto('/demo')
  const pw = await page.locator('#pw').boundingBox()
  const secret = await page.locator('[data-report-mask]').boundingBox()
  const email = await page.locator('#email').boundingBox()
  expect(pw && secret && email).toBeTruthy()

  await role(page, 'button').click()
  await expect(role(page, 'screenshot')).toBeVisible()

  // Sample the frozen capture (the backdrop canvas) at the centre of each element.
  const pixel = (x: number, y: number) =>
    page.evaluate(
      ([x, y]: [number, number]) => {
        const c = document.querySelector<HTMLCanvasElement>('[data-report-role="screenshot"]')!
        const dpr = window.devicePixelRatio || 1
        const d = c.getContext('2d')!.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data
        return [d[0], d[1], d[2]]
      },
      [x, y] as [number, number],
    )
  expect(await pixel(pw!.x + pw!.width / 2, pw!.y + pw!.height / 2)).toEqual([0, 0, 0])
  expect(await pixel(secret!.x + secret!.width / 2, secret!.y + secret!.height / 2)).toEqual([0, 0, 0])
  // The ordinary email field is not blacked out.
  expect(await pixel(email!.x + 2, email!.y + 2)).not.toEqual([0, 0, 0])
  await page.screenshot(shot('6-masking'))
})

test('cancel tears the overlay down and files nothing', async ({ page, request }) => {
  await page.goto('/demo')
  await role(page, 'button').click()
  await drag(page, 100, 100, 300, 300)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(role(page, 'toolbar')).toHaveCount(0)
  await expect(role(page, 'screenshot')).toHaveCount(0)
  await expect(role(page, 'canvas')).toHaveCount(0)
  await expect(role(page, 'button')).toBeVisible()
  expect(await (await request.get(`${GITHUB}/_fixture/issues`)).json()).toEqual([])
})

test('undo and delete edit the shape list', async ({ page }) => {
  await page.goto('/demo')
  await role(page, 'button').click()
  const undo = page.getByRole('button', { name: 'Undo' })
  const del = page.getByRole('button', { name: 'Delete' })
  await expect(undo).toBeDisabled()

  await drag(page, 100, 100, 300, 120)
  await expect(undo).toBeEnabled()
  await undo.click()
  await expect(undo).toBeDisabled()

  await page.getByRole('button', { name: 'Box', exact: true }).click()
  await drag(page, 100, 300, 300, 400)
  await page.getByRole('button', { name: 'Select' }).click()
  await expect(del).toBeDisabled()
  await page.mouse.click(100, 350) // on the box's left edge
  await expect(del).toBeEnabled()
  await del.click()
  await expect(del).toBeDisabled()
})

test('shows a failure toast and keeps the overlay when the server rejects', async ({ page }) => {
  await page.route('**/report', (route) => route.fulfill({ status: 502, body: JSON.stringify({ error: 'GitHub down' }) }))
  await page.goto('/demo')
  await role(page, 'button').click()
  await drag(page, 100, 100, 300, 120)
  await page.getByRole('button', { name: 'Send report' }).click()
  await expect(role(page, 'toast')).toContainText("couldn't be sent")
  await expect(role(page, 'toolbar')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send report' })).toBeEnabled()
  await page.screenshot(shot('7-failed'))
})

test('a repo the GitHub App is installed on files through the relay', async ({ page, request }) => {
  await page.goto('/demo?repo=acme/connected')
  await role(page, 'button').click()
  await drag(page, 100, 100, 300, 120)
  await role(page, 'note').fill('Filed by the app')
  await page.getByRole('button', { name: 'Send report' }).click()
  await expect(role(page, 'toast')).toContainText('Thanks, your report was sent.')

  const issues = await (await request.get(`${GITHUB}/_fixture/issues`)).json()
  expect(issues).toHaveLength(1)
  expect(issues[0].title).toBe('Filed by the app')
  expect(issues[0].html_url).toBe(`${GITHUB}/acme/connected/issues/1`)
  const calls = await (await request.get(`${GITHUB}/_fixture/calls`)).json()
  const filed = calls.find((c: { method: string; path: string }) => c.method === 'POST' && c.path === '/repos/acme/connected/issues')
  expect(filed.auth).toBe('ghs_installation_42')
})

test('an unconnected repo opens a prefilled GitHub issue with the screenshot on the clipboard', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8787' })
  await context.route('https://github.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>new issue</h1>' }))
  await page.goto('/demo?repo=acme/elsewhere')
  await role(page, 'button').click()
  await drag(page, 100, 100, 300, 120)
  await role(page, 'note').fill('Checkout total is wrong')
  const submit = page.getByRole('button', { name: 'Open in GitHub' })
  await expect(submit).toBeVisible()
  await page.screenshot(shot('8-github-mode'))

  const [tab] = await Promise.all([context.waitForEvent('page'), submit.click()])
  const url = new URL(tab.url())
  expect(url.origin + url.pathname).toBe('https://github.com/acme/elsewhere/issues/new')
  expect(url.searchParams.get('title')).toBe('Checkout total is wrong')
  const body = url.searchParams.get('body')!
  expect(body).toMatch(/^<!-- Paste the screenshot here/)
  expect(body).toContain('> Checkout total is wrong')
  expect(body).toMatch(/\| \*\*Demo user\*\* \| pat@example\.com \|/)
  expect(url.searchParams.get('labels')).toBe('user-report')

  await expect(role(page, 'toast')).toContainText('Screenshot copied')
  await expect(role(page, 'toolbar')).toHaveCount(0)
  const clip = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read()
    const blob = await item.getType('image/png')
    return { types: item.types, size: blob.size }
  })
  expect(clip.types).toContain('image/png')
  expect(clip.size).toBeGreaterThan(5000)
  expect(await (await request.get(`${GITHUB}/_fixture/issues`)).json()).toEqual([])
})

test('without a repo the button shows setup, which links to the relay setup page', async ({ page }) => {
  await page.goto('/demo?repo=')
  await role(page, 'button').click()
  await expect(role(page, 'setup')).toBeVisible()
  await expect(role(page, 'toolbar')).toHaveCount(0)
  await role(page, 'setup-repo').fill('acme/site')
  await expect(role(page, 'setup-snippet')).toHaveText('<script src="http://localhost:8787/report-button.js" data-repo="acme/site"></script>')
  await page.screenshot(shot('9-setup-panel'))

  const link = page.getByRole('link', { name: 'install the GitHub App' })
  const href = await link.getAttribute('href')
  expect(href).toBe('http://localhost:8787/setup?repo=acme%2Fsite&origin=http%3A%2F%2Flocalhost%3A8787')
  await page.goto(href!)
  await expect(page.getByRole('link', { name: 'Install on GitHub' })).toHaveAttribute(
    'href',
    `${GITHUB}/apps/report-button-fixture/installations/new`,
  )
  await page.screenshot({ ...shot('10-setup-page'), fullPage: true })

  // Once installed, the same page says so and offers the origin lock.
  await page.goto('/setup?repo=acme/connected&origin=http://localhost:8787')
  await expect(page.getByRole('heading', { name: /^Connected/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Create \.github\/report-button\.yml/ })).toBeVisible()
})

test('captures pages styled with modern CSS colour functions', async ({ page }) => {
  // html2canvas 1.x threw on these, so the overlay never opened on such pages.
  await page.goto('/demo')
  await page.addStyleTag({
    content: `body { background: oklch(0.97 0.01 250); color: lab(20% 10 -30); }
              h1 { color: color(display-p3 0.8 0.2 0.1); border-bottom: 2px solid oklab(0.6 0.1 0.1); }`,
  })
  await role(page, 'button').click()
  await expect(role(page, 'toolbar')).toBeVisible()
  await expect(role(page, 'screenshot')).toBeVisible()
})
