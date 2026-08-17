import { chromium } from 'playwright'

async function main() {
  const base = process.env.PW_BASE_URL || 'http://localhost:3000'
  const browser = await chromium.launch()
  const page = await browser.newPage()

  const logs = []
  page.on('console', (m) => logs.push(`console ${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`pageerror: ${e?.message || String(e)}`))
  page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText || ''}`))

  const shots = [
    { path: '/', file: 'pw-home.png' },
    { path: '/login', file: 'pw-login.png' },
  ]

  for (const s of shots) {
    const url = `${base}${s.path}`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: s.file, fullPage: true })
  }

  if (logs.length) {
    // eslint-disable-next-line no-console
    console.log(logs.join('\n'))
  } else {
    // eslint-disable-next-line no-console
    console.log('no console/page errors captured')
  }

  await browser.close()
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e)
  process.exit(1)
})

