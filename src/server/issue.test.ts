import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assetPath, buildIssue, type Report } from './issue.ts'

const base: Report = {
  reportId: '0f4a1c2e-1111-2222-3333-444455556666',
  note: '',
  pageUrl: 'https://app.example.com/orders/42?tab=items',
  image: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' },
  viewport: { width: 1440, height: 900, dpr: 2 },
  userAgent: 'Mozilla/5.0 Test',
  language: 'en-US',
  reportedAt: '2026-10-09T15:04:05.000Z',
  context: {},
}

test('asset path groups by day and keeps the id', () => {
  assert.equal(assetPath(base), '2026-10-09/0f4a1c2e-1111-2222-3333-444455556666.png')
  assert.equal(assetPath({ ...base, image: { ...base.image, mime: 'image/jpeg' } }).endsWith('.jpg'), true)
})

test('title comes from the first line of the note', () => {
  const { title } = buildIssue({ ...base, note: 'Checkout button does nothing\nSecond line' }, 'https://x/y.png')
  assert.equal(title, 'Checkout button does nothing')
})

test('title falls back to the page path, then to the report id', () => {
  assert.equal(buildIssue(base, 'u').title, 'Report from /orders/42?tab=items')
  assert.equal(buildIssue({ ...base, pageUrl: '' }, 'u').title, 'User report 0f4a1c2e')
})

test('body embeds the screenshot, quotes the note, and tabulates details', () => {
  const { body } = buildIssue(
    { ...base, note: 'Line one\nLine two', context: { User: 'u_123', 'Replay | link': 'https://r/1' } },
    'https://github.com/o/r/blob/b/2026-10-09/x.png?raw=true',
  )
  assert.match(body, /^!\[Annotated screenshot\]\(https:\/\/github\.com\/o\/r\/blob\/b\/2026-10-09\/x\.png\?raw=true\)/)
  assert.match(body, /> Line one\n> Line two/)
  assert.match(body, /\| \*\*Page\*\* \| https:\/\/app\.example\.com\/orders\/42\?tab=items \|/)
  assert.match(body, /\| \*\*Viewport\*\* \| 1440×900, 2x pixel ratio \|/)
  assert.match(body, /\| \*\*User\*\* \| u_123 \|/)
  // Pipes in user-supplied keys and values are escaped so the table survives.
  assert.match(body, /\| \*\*Replay \\\| link\*\* \| https:\/\/r\/1 \|/)
  assert.match(body, /\| \*\*Report id\*\* \| 0f4a1c2e-1111-2222-3333-444455556666 \|/)
})

test('without an image url the body leaves a paste hint for the reporter', () => {
  const { body } = buildIssue({ ...base, note: 'Broken' }, null)
  assert.match(body, /^<!-- Paste the screenshot here/)
  assert.doesNotMatch(body, /!\[/)
})
