import { test, expect, type Page } from '@playwright/test';
import { stubAzure, signInAs, instance, APP_NAME } from './fixtures';

async function openInstance(page: Page, status: string) {
  await signInAs(page);
  await stubAzure(page, {
    instances: [instance('abc123', 'OrderSaga', status)],
    detailStatus: status,
  });
  await page.goto('/');
  await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
  await page.locator('.idtext', { hasText: /^abc123$/ }).click();
  await expect(page.getByRole('button', { name: '← Instances' })).toBeVisible();
}

test.describe('M3 actions', () => {
  test('offers the right actions for a Running instance', async ({ page }) => {
    await openInstance(page, 'Running');
    const bar = page.locator('.actionbar');
    await expect(bar.getByRole('button', { name: 'Terminate' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Suspend' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Raise event' })).toBeVisible();
    // Rewind/Purge are meaningless for a running instance.
    await expect(bar.getByRole('button', { name: 'Rewind' })).toHaveCount(0);
    await expect(bar.getByRole('button', { name: 'Purge' })).toHaveCount(0);
  });

  test('offers recovery actions for a Failed instance', async ({ page }) => {
    await openInstance(page, 'Failed');
    const bar = page.locator('.actionbar');
    await expect(bar.getByRole('button', { name: 'Rewind' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Restart' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Purge' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Terminate' })).toHaveCount(0);
  });

  /*
   * The core safety property: a destructive action cannot fire until a real
   * reason is typed. Typing the reason IS the confirmation — there is no second
   * "are you sure".
   */
  test('keeps confirm disabled until a >=10-char reason is typed', async ({ page }) => {
    await openInstance(page, 'Running');
    await page.locator('.actionbar').getByRole('button', { name: 'Terminate' }).click();

    // The dialog's confirm button (distinct from the action-bar button that opened it).
    const confirm = page.locator('button.confirm');
    await expect(confirm).toBeDisabled();

    await page.getByRole('textbox').fill('too short');
    await expect(confirm).toBeDisabled();

    await page.getByRole('textbox').fill('runaway retry storm, stopping it');
    await expect(confirm).toBeEnabled();
  });

  test('forwards the reason with the acting identity to the target app', async ({ page }) => {
    await openInstance(page, 'Running');
    await page.locator('.actionbar').getByRole('button', { name: 'Terminate' }).click();
    await page.getByRole('textbox').fill('runaway retry storm, stopping it');

    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/terminate')),
      page.locator('button.confirm').click(),
    ]);

    const reason = new URL(request.url()).searchParams.get('reason');
    // who + why, in the app's own telemetry.
    expect(reason).toBe('DurableOps/ops@contoso.com: runaway retry storm, stopping it');
    // Dialog closes on success.
    await expect(page.locator('button.confirm')).toHaveCount(0);
  });

  test('purge warns that the reason is not forwarded', async ({ page }) => {
    await openInstance(page, 'Failed');
    await page.locator('.actionbar').getByRole('button', { name: 'Purge' }).click();
    await expect(page.getByText(/not forwarded to the app/)).toBeVisible();
  });

  test('raise event validates JSON before sending', async ({ page }) => {
    await openInstance(page, 'Running');
    await page.locator('.actionbar').getByRole('button', { name: 'Raise event' }).click();

    await page.getByPlaceholder('Approval').fill('Approval');
    const send = page.getByRole('button', { name: 'Send event' });

    await page.getByPlaceholder('{ "approved": true }').fill('{ not json');
    await expect(page.getByText(/not valid JSON/)).toBeVisible();
    await expect(send).toBeDisabled();

    await page.getByPlaceholder('{ "approved": true }').fill('{ "approved": true }');
    await expect(send).toBeEnabled();

    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/raiseEvent/Approval')),
      send.click(),
    ]);
    expect(request.method()).toBe('POST');
  });
});
