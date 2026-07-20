import { expect, test, type Page } from '@playwright/test'

async function login(page: Page) {
  const user = process.env.E2E_USERNAME || process.env.TEST_LOGIN_USERNAME || 'admin'
  const pass = process.env.E2E_PASSWORD || process.env.TEST_LOGIN_PASSWORD || 'admin123'
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Вход в панель|Sign in/i })).toBeVisible({
    timeout: 30_000,
  })
  await page.locator('input[type="text"], input[autocomplete="username"]').first().fill(user)
  await page.locator('input[type="password"]').first().fill(pass)
  await page.getByRole('button', { name: /Войти|Sign in/i }).click()
  await expect(page.getByRole('heading', { name: /Дашборд|Dashboard/i })).toBeVisible({
    timeout: 30_000,
  })
}

test('API health', async ({ request }) => {
  const res = await request.get('/api/v1/health')
  expect(res.ok()).toBeTruthy()
  await expect(res.json()).resolves.toMatchObject({ status: 'ok', api: 'v1' })
})

test('login shell is reachable', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Вход в панель|Sign in/i })).toBeVisible({
    timeout: 30_000,
  })
})

test('computers page loads after login', async ({ page }) => {
  await login(page)
  await page.goto('/computers')
  await expect(page.getByRole('heading', { name: /Компьютеры|Computers/i })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole('button', { name: /В сети|Online|Все|All|Не в сети|Offline/i }).first()).toBeVisible()
})

test('software catalog switches kinds', async ({ page }) => {
  await login(page)
  await page.goto('/software')
  await expect(page.getByRole('heading', { name: /^ПО$|Software/i })).toBeVisible({ timeout: 20_000 })
  const osChip = page.getByRole('button', { name: /^ОС$|^OS$/i })
  await osChip.click()
  await expect(osChip).toBeVisible()
})

test('building map page mounts', async ({ page }) => {
  await login(page)
  await page.goto('/knowledge-base/sitemap')
  await expect(page.getByText(/Карта|Sitemap|этаж|Floor|Объекты|Objects|здани/i).first()).toBeVisible({
    timeout: 25_000,
  })
})

test('warehouse: create and delete room when editor', async ({ page }) => {
  await login(page)
  await page.goto('/knowledge-base/warehouse')
  await expect(page.getByRole('heading', { name: /Склад|Warehouse/i })).toBeVisible({
    timeout: 20_000,
  })

  const addRoom = page.getByRole('button', { name: /\+ Помещение|Add room|\+ Room/i })
  if (!(await addRoom.isVisible().catch(() => false))) {
    test.skip(true, 'Room create not available for this role')
    return
  }

  const name = `E2E Room ${Date.now()}`
  await addRoom.click()
  await page.locator('.fixed input.app-input, .fixed input').first().fill(name)
  await page.getByRole('button', { name: /Сохранить|Save/i }).click()
  await expect(page.getByRole('button', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeVisible({
    timeout: 15_000,
  })

  await page.getByRole('button', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click()
  await page.getByRole('button', { name: '⋮' }).click()
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: /Удалить|Delete/i }).click()
  await expect(page.getByRole('button', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toHaveCount(0, {
    timeout: 15_000,
  })
})
