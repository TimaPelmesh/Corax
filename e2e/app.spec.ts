import { expect, test } from '@playwright/test'

test('API health', async ({ request }) => {
  const res = await request.get('/api/v1/health')
  expect(res.ok()).toBeTruthy()
  await expect(res.json()).resolves.toMatchObject({ status: 'ok', api: 'v1' })
})

test('UI shell when production bundle is served', async ({ page }) => {
  await page.goto('/')
  // Locale may be ru or en (browser / localStorage) — accept both login titles.
  await expect(page.getByRole('heading', { name: /Вход в панель|Sign in/i })).toBeVisible({
    timeout: 30_000,
  })
})
