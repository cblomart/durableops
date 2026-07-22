import { test, expect, type Page } from '@playwright/test';
import { stubAzure, signInAs, instance, failureOutput, APP_NAME } from './fixtures';

/*
 * Layout integrity across the sizes an operator actually reaches for:
 * a big console, the work laptop, a tablet, and a phone pulled out mid-meeting.
 * The core invariant is that the page never scrolls sideways — wide content
 * (the tables) must scroll inside its own box, not push the body.
 */
const DEVICES = [
  { name: 'large monitor', viewport: { width: 2560, height: 1440 } },
  { name: 'laptop', viewport: { width: 1440, height: 900 } },
  { name: 'tablet', viewport: { width: 820, height: 1180 } },
  { name: 'phone', viewport: { width: 390, height: 844 } },
];

/** Horizontal overflow of the page itself, in px (0 = the body never scrolls sideways). */
async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  );
}

for (const device of DEVICES) {
  test.describe(`responsive — ${device.name}`, () => {
    test.use({ viewport: device.viewport });

    test('signed-out landing fits and stays centred', async ({ page }) => {
      await stubAzure(page);
      await page.goto('/');

      await expect(page.getByRole('heading', { name: /Troubleshoot/ })).toBeVisible();
      await expect(page.locator('.statusbar')).toBeVisible();
      await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(1);
    });

    test('signed-in app + instance views never scroll the body sideways', async ({ page }) => {
      await signInAs(page);
      await stubAzure(page, {
        instances: [instance('i1', 'OrderSaga', 'Failed', failureOutput('ChargeCard', 'boom'))],
      });
      await page.goto('/');

      // App list.
      await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();
      await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(1);

      // Instance list (the widest table).
      await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
      await expect(page.getByRole('table')).toBeVisible();
      await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(1);

      // Instance detail.
      await page.locator('.idtext', { hasText: /^i1$/ }).click();
      await expect(page.locator('.title .id')).toBeVisible();
      await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(1);
    });
  });
}
