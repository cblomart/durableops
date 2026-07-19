import { test, expect } from '@playwright/test';
import { stubAzure, signInAs, instance, APP_NAME } from './fixtures';

const APP_HASH = new RegExp(`#/app/${APP_NAME}$`);
const INSTANCE_HASH = new RegExp(`#/app/${APP_NAME}/i/abc123$`);

test.describe('deep-link routing', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page);
    await stubAzure(page, { instances: [instance('abc123', 'OrderSaga', 'Failed')] });
  });

  test('a link straight to an app opens its instance list', async ({ page }) => {
    await page.goto(`/#/app/${APP_NAME}`);
    // Skips the app list entirely — the operator lands in the app.
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.locator('.idtext', { hasText: /^abc123$/ })).toBeVisible();
  });

  test('a link straight to an instance opens its detail', async ({ page }) => {
    await page.goto(`/#/app/${APP_NAME}/i/abc123`);
    await expect(page.locator('.title .id')).toHaveText('abc123');
  });

  test('navigating updates the URL, and Back retraces it', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();

    // Apps -> app: the hash gains the app.
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    await expect(page).toHaveURL(APP_HASH);
    await expect(page.getByRole('table')).toBeVisible();

    // App -> instance: the hash gains the instance id.
    await page.locator('.idtext', { hasText: /^abc123$/ }).click();
    await expect(page).toHaveURL(INSTANCE_HASH);
    await expect(page.locator('.title .id')).toBeVisible();

    // Back -> instance list.
    await page.goBack();
    await expect(page).toHaveURL(APP_HASH);
    await expect(page.getByRole('table')).toBeVisible();

    // Back -> app list.
    await page.goBack();
    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();
  });

  test('an unknown app in the URL degrades to the app list', async ({ page }) => {
    await page.goto('/#/app/does-not-exist');
    // No such app was discovered, so the safe fallback is the fleet list.
    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();
    await expect(page.locator('.title .id')).toHaveCount(0);
  });
});
