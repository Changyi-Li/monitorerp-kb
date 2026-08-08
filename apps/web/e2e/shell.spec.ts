import { expect, test } from '@playwright/test'
import { ADMIN, signIn, uploadFile } from './helpers'

test.describe('shell polish', () => {
  test('the theme toggle persists across reloads and dark mode uses the locked primary', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password)

    // Light mode uses the locked light primary rgb(0 126 189) == #007ebd.
    const lightPrimary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    )
    expect(lightPrimary).toBe('#007ebd')

    // Toggle to dark.
    await page.getByRole('button', { name: 'Switch to dark theme' }).click()
    await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible()

    // Chromium normalizes the custom property to hex; rgb(127 195 232) == #7fc3e8.
    const primary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    )
    expect(primary).toBe('#7fc3e8')

    // The locked dark primary carries dark text: the primary button's text
    // color must resolve to a dark color, not near-white. Chromium reports
    // the declared token — oklch, lab (0–100 lightness), or rgb — so handle
    // all three forms.
    const buttonColor = await page
      .getByRole('button', { name: 'Upload' })
      .evaluate((el) => getComputedStyle(el).color)
    const oklchLightness = buttonColor.match(/oklch\(([\d.]+)/)?.[1]
    const labLightness = buttonColor.match(/lab\(([\d.]+)/)?.[1]
    const rgb = buttonColor.match(/rgb\((\d+), (\d+), (\d+)\)/)?.slice(1).map(Number)
    if (oklchLightness !== undefined) {
      expect(Number(oklchLightness)).toBeLessThan(0.5)
    } else if (labLightness !== undefined) {
      expect(Number(labLightness)).toBeLessThan(50)
    } else {
      expect(Math.max(...(rgb ?? [255, 255, 255]))).toBeLessThan(128)
    }

    // Back to light.
    await page.getByRole('button', { name: 'Switch to light theme' }).click()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible()
  })

  test('empty states offer a clear-filters action (no dead ends)', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    await uploadFile(page, 'present.md', '# present\n')

    // A search that matches nothing leaves an empty state with an escape hatch.
    await page.getByLabel('Search documents by name').fill('zzz-no-such-document')
    await expect(page.getByText('No documents match your filters')).toBeVisible()

    // The empty state itself offers the action (the filter bar does too).
    await page.getByRole('button', { name: 'Clear filters' }).last().click()
    await expect(page.getByLabel('Search documents by name')).toHaveValue('')
    await expect(page.locator('tbody tr', { hasText: 'present.md' })).toBeVisible()
  })

  test('animations are disabled under prefers-reduced-motion', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    const row = await uploadFile(page, 'motion.md', '# motion\n')
    await page.emulateMedia({ reducedMotion: 'reduce' })

    // Open the detail panel — its slide-in is motion-safe, so under reduced
    // motion it must not animate. (.last(): the sidebar is an <aside> too.)
    await row.click()
    const panel = page.locator('aside').last()
    await expect(panel).toBeVisible()
    const animationName = await panel.evaluate((el) => getComputedStyle(el).animationName)
    expect(animationName).toBe('none')
  })
})
