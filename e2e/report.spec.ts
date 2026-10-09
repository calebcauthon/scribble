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
