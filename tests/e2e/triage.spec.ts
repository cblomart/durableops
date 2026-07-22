import { test, expect } from '@playwright/test';
import { stubAzure, signInAs, instance, failureOutput, STUCK_HISTORY, APP_NAME } from './fixtures';

test.describe('signed out', () => {
  test('shows a sign-in prompt and no app list', async ({ page }) => {
    await stubAzure(page);
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  /*
   * Onboarding: the landing must explain the access model and give an admin a
   * one-click way to consent for the whole tenant (the multi-tenant case).
   */
  test('explains access and offers a tenant admin-consent link', async ({ page }) => {
    await stubAzure(page);
    await page.goto('/');

    await expect(
      page.getByRole('heading', { name: /Troubleshoot Azure Durable Functions/ })
    ).toBeVisible();
    // The only sign-in affordance is the top-bar pill (no redundant landing button).
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByText(/Granting access/)).toBeVisible();

    const consent = page.getByRole('link', { name: 'Grant admin consent' });
    const href = await consent.getAttribute('href');
    expect(href).toContain('login.microsoftonline.com');
    expect(href).toContain('/adminconsent?');
    expect(href).toContain('client_id=11111111-1111-1111-1111-111111111111');
  });

  /*
   * The status bar carries the released version, and About holds the legal bits:
   * licence, warranty disclaimer, and the no-data-collected privacy statement.
   */
  test('shows a version and an About dialog with licence, disclaimer and privacy', async ({
    page,
  }) => {
    await stubAzure(page);
    await page.goto('/');

    await expect(page.locator('.statusbar .ver')).toHaveText(/^v\d+\.\d+\.\d+/);

    await page.getByRole('button', { name: 'About & legal' }).click();
    const about = page.getByRole('dialog', { name: 'About DurableOps' });
    await expect(about.getByRole('heading', { name: 'Licence' })).toBeVisible();
    await expect(about.getByRole('link', { name: 'MIT Licence' })).toBeVisible();
    await expect(about.getByText(/without warranty/i)).toBeVisible();
    await expect(about.getByText(/collects nothing/i)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(about).toHaveCount(0);
  });

  /*
   * The star and sponsor links are the maintainer's, shown only when the config
   * opts in — so a fork or a third party's self-hosted copy shows neither.
   */
  test('star and sponsor links appear only when the instance opts in', async ({ page }) => {
    await stubAzure(page);

    // Default config (the example): no opt-in, so neither link — the fork case.
    await page.goto('/');
    await expect(page.locator('.statusbar')).toBeVisible();
    await expect(page.locator('.statusbar .ghstar')).toHaveCount(0);
    await expect(page.locator('.statusbar .sponsor')).toHaveCount(0);

    // Opt-in config (the maintainer's hosting): both appear and link out.
    await page.route('**/config.json', (route) =>
      route.fulfill({
        json: {
          tenantId: '00000000-0000-0000-0000-000000000000',
          clientId: '11111111-1111-1111-1111-111111111111',
          showGitHubStar: true,
          donateUrl: 'https://ko-fi.com/cblomart',
        },
      })
    );
    await page.reload();
    await expect(page.locator('.statusbar').getByRole('link', { name: /Star/ })).toHaveAttribute(
      'href',
      /github\.com\/cblomart\/durableops/
    );
    await expect(page.locator('.statusbar .sponsor')).toHaveAttribute(
      'href',
      /ko-fi\.com\/cblomart/
    );
  });
});

test.describe('discovery', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page);
    await stubAzure(page);
  });

  test('lists the apps Resource Graph returns, and shows the signed-in user', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Account: ops@contoso.com' })).toBeVisible();
    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh rights' })).toBeVisible();
  });

  test('filters the app list client-side', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();

    await page.getByRole('searchbox').fill('nonsense-xyz');
    await expect(page.getByText(/No app matches/)).toBeVisible();

    await page.getByRole('searchbox').fill('billing');
    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();
  });
});

test.describe('triage and instance list', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page);
  });

  test('groups instances by orchestrator and status, failures first', async ({ page }) => {
    await stubAzure(page, {
      instances: [
        instance('i1', 'OrderSaga', 'Failed'),
        instance('i2', 'OrderSaga', 'Failed'),
        instance('i3', 'OrderSaga', 'Running'),
        instance('i4', 'Shipping', 'Running'),
      ],
    });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();

    // The triage header is the ops landing view: it must lead with what broke.
    const triage = page.locator('.triage');
    await expect(triage).toBeVisible();
    await expect(triage.getByRole('button', { name: /2 Failed/ })).toBeVisible();
    await expect(triage.getByRole('button', { name: /1 Running/ }).first()).toBeVisible();
  });

  test('clicking a triage cell filters the list to that orchestrator and status', async ({
    page,
  }) => {
    await stubAzure(page, {
      instances: [instance('i1', 'OrderSaga', 'Failed'), instance('i2', 'Shipping', 'Running')],
    });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();

    await page
      .locator('.triage')
      .getByRole('button', { name: /1 Failed/ })
      .click();

    await expect(page.locator('.idtext', { hasText: /^i1$/ })).toBeVisible();
    await expect(page.locator('.idtext', { hasText: /^i2$/ })).toHaveCount(0);
  });

  /*
   * The 2 AM signal: one bug vs many. Three failures sharing an error collapse to
   * one Problems chip; a fourth with a different error is its own chip.
   */
  test('shows the error inline and groups failures by signature', async ({ page }) => {
    await stubAzure(page, {
      instances: [
        instance('i1', 'OrderSaga', 'Failed', failureOutput('ChargeCard', 'Card declined')),
        instance('i2', 'OrderSaga', 'Failed', failureOutput('ChargeCard', 'Card declined')),
        instance('i3', 'OrderSaga', 'Failed', failureOutput('ChargeCard', 'Card declined')),
        instance('i4', 'OrderSaga', 'Failed', failureOutput('CallBank', 'Gateway timeout')),
        instance('i5', 'OrderSaga', 'Running'),
      ],
    });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();

    // Error shown inline in the row — no need to open the instance.
    await expect(page.locator('.err').filter({ hasText: 'Card declined' }).first()).toBeVisible();

    // Two distinct signatures, the common one counted 3.
    const problems = page.locator('.problems');
    await expect(problems.getByRole('button', { name: /3.*Card declined/ })).toBeVisible();
    await expect(problems.getByRole('button', { name: /1.*Gateway timeout/ })).toBeVisible();

    // Clicking a signature filters the list to just those instances.
    await problems.getByRole('button', { name: /Gateway timeout/ }).click();
    await expect(page.locator('.idtext', { hasText: /^i4$/ })).toBeVisible();
    await expect(page.locator('.idtext', { hasText: /^i1$/ })).toHaveCount(0);
  });

  test('sorts failures above healthy instances', async ({ page }) => {
    await stubAzure(page, {
      instances: [
        instance('healthy', 'OrderSaga', 'Running'),
        instance('broken', 'OrderSaga', 'Failed', failureOutput('ChargeCard', 'boom')),
      ],
    });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();

    const firstRowId = page.locator('tbody tr').first().locator('.idtext');
    await expect(firstRowId).toHaveText('broken');
  });

  /*
   * The app-header refresh governs the whole view: triage, problems and the list
   * all recompute from one fetch, so "Refresh now" must re-list the instances.
   */
  test('the app-header refresh button re-fetches the whole view', async ({ page }) => {
    await stubAzure(page, { instances: [instance('i1', 'OrderSaga', 'Running')] });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();

    const [request] = await Promise.all([
      page.waitForRequest((r) => /\/instances\?/.test(r.url())),
      page.getByRole('button', { name: 'Refresh now' }).click(),
    ]);
    expect(request.method()).toBe('GET');
  });

  test('copies an instance id to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await stubAzure(page, { instances: [instance('copy-me', 'OrderSaga', 'Running')] });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();

    // The copy button is revealed on hover; force past the opacity transition.
    await page.getByRole('button', { name: 'Copy instance ID' }).click({ force: true });
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe('copy-me');
  });

  test('drives the list from the keyboard (j / k / enter)', async ({ page }) => {
    await stubAzure(page, {
      instances: [
        instance('first', 'OrderSaga', 'Failed', failureOutput('A', 'x')),
        instance('second', 'OrderSaga', 'Failed', failureOutput('B', 'y')),
      ],
    });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    // Wait for the rows (and the keydown listener) before driving from the keyboard.
    await expect(page.locator('tbody tr').first()).toBeVisible();

    // j selects the first row, j again the second, enter opens it.
    await page.keyboard.press('j');
    await expect(page.locator('tbody tr').first()).toHaveClass(/selected/);
    await page.keyboard.press('j');
    await expect(page.locator('tbody tr').nth(1)).toHaveClass(/selected/);
    await page.keyboard.press('Enter');

    // Opening navigates to the instance detail (back button appears).
    await expect(page.locator('.title .id')).toBeVisible();
  });

  test('"/" focuses the Go-to-instance field', async ({ page }) => {
    await stubAzure(page, { instances: [instance('i1', 'OrderSaga', 'Running')] });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();

    await page.keyboard.press('/');
    // The Go-to-instance field takes focus; typing there must not move rows.
    const focusedPlaceholder = await page.evaluate(
      () => (document.activeElement as HTMLInputElement | null)?.placeholder
    );
    expect(focusedPlaceholder).toContain('instance id');
  });

  /*
   * Instance ids are random, so the field is an exact jump, not a prefix filter:
   * paste the id from an alert, Enter, and land on that instance's detail.
   */
  test('Go to instance opens an instance by its exact id', async ({ page }) => {
    await stubAzure(page, { instances: [instance('i1', 'OrderSaga', 'Running')] });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    await expect(page.getByRole('table')).toBeVisible();

    await page.getByPlaceholder(/instance id/).fill('abc123');
    await page.getByPlaceholder(/instance id/).press('Enter');

    await expect(page.locator('.title .id')).toBeVisible();
    await expect(page).toHaveURL(/#\/app\/func-prod-billing\/i\/abc123$/);
  });

  test('a created-time preset scopes the query by createdTimeFrom', async ({ page }) => {
    await stubAzure(page, { instances: [instance('i1', 'OrderSaga', 'Running')] });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    await expect(page.getByRole('table')).toBeVisible();

    const [request] = await Promise.all([
      page.waitForRequest((r) => /createdTimeFrom=/.test(r.url())),
      page.getByRole('button', { name: '1h', exact: true }).click(),
    ]);
    expect(request.method()).toBe('GET');
  });
});

test.describe('instance detail', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page);
  });

  test('leads with a failure summary and lets each event expand for detail', async ({ page }) => {
    await stubAzure(page);
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    await page.locator('.idtext', { hasText: /^abc123$/ }).click();

    // The cause is surfaced immediately, with the failed function named — no
    // scrolling, no "go to first failure".
    const summary = page.locator('.summary');
    await expect(summary).toContainText('Card declined by issuer');
    await expect(summary).toContainText('in ChargeCard');
    await expect(page.getByRole('button', { name: 'Go to first failure' })).toHaveCount(0);

    // The stack is machine detail: hidden until asked for.
    await expect(page.getByText(/System\.Exception/)).toHaveCount(0);
    await summary.getByRole('button', { name: 'Show detail' }).click();
    await expect(page.getByText(/System\.Exception/)).toBeVisible();

    // Investigation: each history event expands to its full detail, including
    // the complete raw event — the parsed fields are a convenience, not a filter.
    const failedRow = page.locator('.row.failed');
    await expect(failedRow.locator('.event-detail')).toHaveCount(0);
    await failedRow.locator('.line').click();
    await expect(failedRow.locator('.event-detail')).toBeVisible();
    await expect(failedRow.getByText('Raw event')).toBeVisible();
  });

  test('surfaces instance input and custom status, and expands every event at once', async ({
    page,
  }) => {
    await stubAzure(page, {
      instances: [instance('abc123', 'OrderSaga', 'Running')],
      detailStatus: 'Running',
      history: [
        { EventType: 'ExecutionStarted', Name: 'OrderSaga', Timestamp: '2026-06-04T10:00:00Z' },
        {
          EventType: 'TaskCompleted',
          Name: 'ReserveStock',
          Result: '"reserved"',
          Timestamp: '2026-06-04T10:00:01Z',
        },
      ],
    });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    await page.locator('.idtext', { hasText: /^abc123$/ }).click();

    // Instance-level payloads are first-class, not buried.
    await expect(page.locator('.payloads')).toContainText('Custom status');
    await expect(page.locator('.payloads')).toContainText('Input');

    // Expand all dumps every event's detail for an expert who wants everything.
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(page.locator('.event-detail')).toHaveCount(2);
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(page.locator('.event-detail')).toHaveCount(0);
  });

  test('walks between failures and collapses to failures only', async ({ page }) => {
    // Two failures (a retry), so prev/next navigation has somewhere to go.
    await stubAzure(page, {
      history: [
        {
          EventType: 'ExecutionStarted',
          FunctionName: 'OrderSaga',
          Timestamp: '2026-06-04T10:00:00Z',
        },
        { EventType: 'TaskScheduled', Name: 'ChargeCard', Timestamp: '2026-06-04T10:00:01Z' },
        {
          EventType: 'TaskFailed',
          FunctionName: 'ChargeCard',
          Reason: 'declined once',
          Timestamp: '2026-06-04T10:00:02Z',
        },
        { EventType: 'TaskScheduled', Name: 'ChargeCard', Timestamp: '2026-06-04T10:00:03Z' },
        {
          EventType: 'TaskFailed',
          FunctionName: 'ChargeCard',
          Reason: 'declined again',
          Timestamp: '2026-06-04T10:00:04Z',
        },
      ],
    });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    await page.locator('.idtext', { hasText: /^abc123$/ }).click();

    await expect(page.getByText('failure 1 / 2')).toBeVisible();
    await page.getByRole('button', { name: 'Next failure' }).click();
    await expect(page.getByText('failure 2 / 2')).toBeVisible();

    await expect(page.locator('.row')).toHaveCount(5);
    await page.getByLabel('Failures only').check();
    // Two failures, each with one event of context, so fewer than the full five.
    expect(await page.locator('.row').count()).toBeLessThan(5);
  });

  test('badges a live instance stuck at scheduling', async ({ page }) => {
    await stubAzure(page, {
      instances: [instance('abc123', 'StuckSaga', 'Running')],
      history: STUCK_HISTORY,
      detailStatus: 'Running',
    });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    await page.locator('.idtext', { hasText: /^abc123$/ }).click();

    // "Possibly", never a verdict: a slow activity looks identical from history.
    await expect(page.getByText(/Possibly stuck at scheduling/)).toBeVisible();
    await expect(page.getByText(/NeverReturns/).first()).toBeVisible();
    // A running instance is not a failure, so no failure summary card.
    await expect(page.locator('.summary')).toHaveCount(0);
  });

  test('does not badge or summarise a healthy completed instance', async ({ page }) => {
    await stubAzure(page, {
      instances: [instance('abc123', 'HappyPath', 'Completed')],
      history: [
        { EventType: 'ExecutionStarted', Timestamp: '2020-01-01T00:00:00Z' },
        { EventType: 'ExecutionCompleted', Timestamp: '2020-01-01T00:00:02Z' },
      ],
      detailStatus: 'Completed',
    });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();
    await page.locator('.idtext', { hasText: /^abc123$/ }).click();

    await expect(page.getByText(/Possibly stuck/)).toHaveCount(0);
    await expect(page.locator('.summary')).toHaveCount(0);
    await expect(page.getByText(/failure \d+ \//)).toHaveCount(0);
  });
});

test.describe('permissions', () => {
  test('a 403 on the data plane offers the PIM remediation and a Refresh rights shortcut', async ({
    page,
  }) => {
    await signInAs(page);
    await stubAzure(page, { forbidData: true });
    await page.goto('/');
    await page.getByRole('cell', { name: APP_NAME, exact: true }).click();

    await expect(page.getByText(/activate your PIM role/)).toBeVisible();
    // Two: the top bar's and the error banner's shortcut.
    await expect(page.getByRole('button', { name: 'Refresh rights' })).toHaveCount(2);
  });
});

test.describe('durable-only app list', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page);
  });

  /*
   * An ops tool for Durable Functions has no business listing apps that run
   * none. Classification reads ARM function bindings and pulls no keys.
   */
  test('hides an app that runs no Durable Functions, without explaining itself', async ({
    page,
  }) => {
    await stubAzure(page, { bindings: ['httpTrigger', 'timerTrigger'] });
    await page.goto('/');

    await expect(page.getByText('No apps to show.')).toBeVisible();
    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toHaveCount(0);
    // No counts and no lecture: that only invites questions from an operator.
    await expect(page.getByText(/hidden/)).toHaveCount(0);
    await expect(page.getByText(/non-durable/)).toHaveCount(0);
  });

  test('keeps an app that runs Durable Functions', async ({ page }) => {
    await stubAzure(page, { bindings: ['orchestrationTrigger'] });
    await page.goto('/');

    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();
    await expect(page.getByText(/1 app/)).toBeVisible();
  });

  /* Unknown must never be treated as not-durable: that would hide real work. */
  test('keeps an app it could not classify, listed plainly', async ({ page }) => {
    await stubAzure(page, { forbidFunctions: true });
    await page.goto('/');

    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();
  });
});

test.describe('operability: only show what you can actually use', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page);
  });

  /*
   * The exact confusion this filter removes: Reader can SEE every app in the
   * tenant but holds only read actions, so it can invoke no host runtime and
   * operate none of them. Listing them would just be noise with a 403 behind
   * every click.
   */
  test('hides apps the user cannot operate, and stays calm about it', async ({ page }) => {
    await stubAzure(page, { actions: ['*/read'] });
    await page.goto('/');

    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toHaveCount(0);
    await expect(page.getByText('No apps to show.')).toBeVisible();
    // The operator is never told anything was filtered, that access is missing,
    // or that reading and managing differ: that only worries them. The neutral
    // recovery (Refresh rights) lives in the top bar, not here.
    await expect(page.getByText(/hidden/i)).toHaveCount(0);
    await expect(page.getByText(/permission/i)).toHaveCount(0);
    await expect(page.getByText(/cannot operate/i)).toHaveCount(0);
    await expect(page.getByText(/activate/i)).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Activate access/ })).toHaveCount(0);
  });

  test('shows apps once the user holds Microsoft.Web/sites/*', async ({ page }) => {
    await stubAzure(page, { actions: ['Microsoft.Web/sites/*'] });
    await page.goto('/');

    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();
  });
});

test.describe('opportunistic failure scan', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page);
  });

  /*
   * Apps are scanned automatically as their rows scroll into view (bounded
   * queue). A failing app is treated first-class: the whole row reads as a
   * problem, with a plain, prominent count — not a decorative pill.
   */
  test('marks a failing app as a problem row with a clear count', async ({ page }) => {
    await stubAzure(page, {
      instances: [
        instance('f1', 'OrderSaga', 'Failed', failureOutput('ChargeCard', 'boom')),
        instance('f2', 'OrderSaga', 'Failed', failureOutput('ChargeCard', 'boom')),
      ],
    });
    await page.goto('/');
    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();

    // Scanned on sight — the count appears and the row is a problem.
    await expect(page.locator('.failcount')).toHaveText(/2 failed/);
    await expect(page.locator('tbody tr').first()).toHaveClass(/problem/);
  });

  test('marks a scanned app with no failures as healthy, not a problem', async ({ page }) => {
    // On the app-list page the only instances query is the scan's failed-count.
    await stubAzure(page, { instances: [] });
    await page.goto('/');
    await expect(page.getByRole('cell', { name: APP_NAME, exact: true })).toBeVisible();

    await expect(page.locator('.clean')).toContainText('healthy');
    await expect(page.locator('tbody tr').first()).not.toHaveClass(/problem/);
  });

  test('a per-app refresh button forces an immediate re-scan', async ({ page }) => {
    await stubAzure(page, {
      instances: [instance('f1', 'OrderSaga', 'Failed', failureOutput('ChargeCard', 'boom'))],
    });
    await page.goto('/');
    // Scanned once on sight.
    await expect(page.locator('.failcount')).toBeVisible();

    // The refresh button forces a fresh failed-count request for that app.
    const [request] = await Promise.all([
      page.waitForRequest((r) => /\/instances\?.*runtimeStatus=Failed/.test(r.url())),
      page.getByRole('button', { name: /Re-scan .* for failures/ }).click(),
    ]);
    expect(request.method()).toBe('GET');
  });
});

test.describe('account menu', () => {
  test('signed out shows a sign-in pill and no avatar', async ({ page }) => {
    await stubAzure(page);
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Account:/ })).toHaveCount(0);
  });

  /* A tenant GUID means nothing to an operator; the flyout shows the name. */
  test('avatar opens a flyout with the UPN and tenant NAME, not a GUID', async ({ page }) => {
    await signInAs(page);
    await stubAzure(page);
    await page.goto('/');

    // Initials, not a sign-out button, in the bar.
    const avatar = page.getByRole('button', { name: 'Account: ops@contoso.com' });
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveText('O');
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);

    await avatar.click();

    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menu').getByText('Contoso', { exact: true })).toBeVisible();
    await expect(page.getByText('tenant-id')).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });

  test('flyout closes on Escape', async ({ page }) => {
    await signInAs(page);
    await stubAzure(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Account: ops@contoso.com' }).click();
    await expect(page.getByRole('menu')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});
