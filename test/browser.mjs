import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testApplication } from './support.mjs';

const f = await testApplication();
let browser;
let page;
try {
  let executablePath = process.env.CHROMIUM_EXECUTABLE;
  if (!executablePath && !existsSync(chromium.executablePath())) {
    const cache =
      process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(homedir(), '.cache/ms-playwright');
    executablePath = (existsSync(cache) ? readdirSync(cache) : [])
      .filter((name) => /^chromium(?:_headless_shell)?-\d+$/.test(name))
      .sort()
      .reverse()
      .flatMap((name) =>
        [
          'chrome-headless-shell-linux64/chrome-headless-shell',
          'chrome-linux64/chrome',
          'chrome-linux/chrome',
        ].map((relative) => path.join(cache, name, relative)),
      )
      .find(existsSync);
    if (!executablePath)
      throw new Error(
        'No cached Chromium. Set CHROMIUM_EXECUTABLE; this test never downloads a browser.',
      );
  }
  browser = await chromium.launch({ headless: true, executablePath });
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(15000);
  const exceptions = [];
  const csp = [];
  page.on('pageerror', (error) => {
    exceptions.push(error.message);
    console.error('Browser exception:', error.message);
  });
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to apply.*style/i.test(message.text()))
      csp.push(message.text());
  });
  const screenshots = path.resolve('.impeccable/review');
  await mkdir(screenshots, { recursive: true });
  async function contained(name) {
    await page.locator('.ant-spin-spinning').waitFor({ state: 'hidden' });
    await page.locator('.ant-btn-loading').waitFor({ state: 'hidden' });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.image-paper img, .thumbnail-media img')]
        .filter((image) => {
          const bounds = image.getBoundingClientRect();
          return bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight;
        })
        .every((image) => image.complete && image.naturalWidth > 0),
    );
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight &&
          document.body.scrollHeight <= innerHeight,
      ),
      true,
      'No browser-level scrolling',
    );
    await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
  }
  async function signIn(username, password) {
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  async function changePassword(currentPassword, newPassword) {
    await page.getByLabel('Current password', { exact: true }).fill(currentPassword);
    await page.getByLabel('New password', { exact: true }).fill(newPassword);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Change password', exact: true })
      .click();
  }
  async function choose(label, option) {
    await page.getByLabel(label, { exact: true }).click();
    await page.locator('.ant-select-dropdown:visible').getByText(option, { exact: true }).click();
  }
  async function captureFinished(session, count) {
    await page.waitForFunction(
      ({ session, count }) => {
        const button = [...document.querySelectorAll('.scanner-toolbar button')].find((button) =>
          button.textContent.includes('Scan feeder'),
        );
        return (
          button &&
          !button.disabled &&
          document.querySelector('[aria-label="Current scan session"]')?.textContent ===
            `Session ${session}` &&
          document.querySelector('[aria-label="Captured page count"]')?.textContent ===
            String(count)
        );
      },
      { session, count },
    );
  }
  const adminAccount = await f.app.admin.create(f.bootstrap.user, {
    username: 'browser-admin',
    displayName: 'Browser Administrator',
    roles: ['system_admin'],
  });
  const adminPassword = `browser-admin-${randomUUID()}`;
  const operatorPassword = `browser-operator-${randomUUID()}`;
  await page.goto(f.origin);
  await contained('login-1366');
  await signIn('browser-admin', adminAccount.temporaryPassword);
  await page.getByRole('dialog', { name: 'Choose your password', exact: true }).waitFor();
  await changePassword(adminAccount.temporaryPassword, adminPassword);
  await page.getByRole('heading', { name: 'Users', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('menuitem', { name: 'Capture Workspace', exact: true }).count(),
    0,
  );
  for (const name of [
    'All users',
    'System Administrator',
    'Operator',
    'QC Officer',
    'Approver Level 1',
    'Approver Level 2',
    'Archive Viewer',
  ])
    await page.getByRole('tab', { name: new RegExp(name) }).waitFor();
  const createUser = page.getByRole('button', { name: 'Create user', exact: true });
  assert.equal(
    await createUser.evaluate((button) =>
      button.closest('.ant-space').contains(document.querySelector('button[aria-label="Refresh"]')),
    ),
    true,
  );
  await page.getByRole('button', { name: 'Create user', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('browser-operator');
  await page.getByLabel('Display name', { exact: true }).fill('Capture Operator');
  await choose('Roles', 'Operator');
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Auto-generate', exact: true }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Create user', exact: true }).click();
  await page.getByText('Temporary credentials · shown once', { exact: true }).waitFor();
  const temporary = await page.locator('.temporary-password').innerText();
  await page.getByRole('button', { name: 'I have saved these credentials' }).click();
  await page.getByRole('tab', { name: /^Operator/ }).click();
  const operatorRow = page.getByRole('row').filter({ hasText: 'browser-operator' });
  await operatorRow.waitFor();
  for (const label of ['Edit user', 'Disable user', 'Reset password', 'Delete user']) {
    const action = operatorRow.getByRole('button', { name: label, exact: true });
    assert.equal((await action.textContent()).trim(), '', 'Row actions are icon-only');
  }
  await operatorRow.getByRole('button', { name: 'Reset password', exact: true }).click();
  const resetModal = page.getByRole('dialog', {
    name: 'Reset password · browser-operator',
    exact: true,
  });
  await resetModal.getByRole('radio', { name: 'Set password', exact: true }).check();
  await resetModal.getByLabel('Password', { exact: true }).fill('Browser temporary passphrase!');
  await resetModal.getByLabel('Confirm password', { exact: true }).fill('Does not match yet');
  await resetModal.getByRole('button', { name: 'Reset password', exact: true }).click();
  await resetModal.getByText('Passwords do not match.', { exact: true }).waitFor();
  await resetModal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await operatorRow.getByRole('checkbox', { name: 'Select browser-operator', exact: true }).check();
  await page.getByRole('button', { name: 'Reset selected passwords', exact: true }).click();
  const bulkReset = page.getByRole('dialog', { name: 'Reset password · 1 users', exact: true });
  await bulkReset.getByRole('radio', { name: 'Set password', exact: true }).check();
  await bulkReset.getByLabel('Password', { exact: true }).fill('A shared browser password!');
  await bulkReset
    .getByLabel('Confirm password', { exact: true })
    .fill('A shared browser password!');
  await bulkReset.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Delete selected users', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete browser-operator?', exact: true });
  await deleteDialog
    .getByText(/Document ownership, original scans and audit history are retained/)
    .waitFor();
  await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  await page.getByRole('tab', { name: /^Operator/ }).waitFor();
  assert.equal(
    await page.getByRole('tab', { name: /^Operator/ }).getAttribute('aria-selected'),
    'true',
  );
  await contained('users-1366');
  await page.getByRole('menuitem', { name: 'Audit Logs', exact: true }).click();
  await page.getByText('user.created', { exact: true }).first().waitFor();
  await page.getByRole('tab', { name: /^Users & roles/ }).click();
  await page.getByLabel('Search audit logs', { exact: true }).fill('user.created');
  await page.getByText('user.created', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'View event details', exact: true }).first().click();
  const auditModal = page.getByRole('dialog', { name: 'Audit event details', exact: true });
  await auditModal.getByText('Event metadata', { exact: true }).waitFor();
  await auditModal.getByRole('button', { name: 'Close', exact: true }).last().click();
  await contained('audit-1366');
  await page.getByRole('menuitem', { name: 'System', exact: true }).click();
  await page.getByRole('cell', { name: '0.8.7', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn('browser-operator', temporary);
  await changePassword(temporary, operatorPassword);
  await page.getByRole('button', { name: 'Scan New Batch', exact: true }).waitFor();
  const workspaceUrl = page.url();
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  const passwordDialog = page.getByRole('dialog', { name: 'Change password', exact: true });
  await passwordDialog.waitFor();
  assert.equal(page.url(), workspaceUrl);
  await passwordDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await passwordDialog.waitFor({ state: 'hidden' });
  assert.equal(page.url(), workspaceUrl);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await changePassword(operatorPassword, `browser-updated-${randomUUID()}`);
  await passwordDialog.waitFor({ state: 'hidden' });
  assert.equal(page.url(), workspaceUrl);
  await page.getByRole('button', { name: 'Scan New Batch', exact: true }).waitFor();
  const activity = page.getByRole('region', { name: 'Recent activity', exact: true });
  const activityToggle = activity.getByRole('button', { name: 'Recent activity', exact: true });
  assert.equal(await activityToggle.getAttribute('aria-expanded'), 'false');
  await activityToggle.click();
  await activity.getByText('No recent activity', { exact: true }).waitFor();
  await activityToggle.click();
  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [1280, 720],
  ]) {
    await page.setViewportSize({ width, height });
    await contained(`home-${width}`);
  }
  const batchCountBefore = (
    await f.pool.query('SELECT count(*)::int AS count FROM archive_batches')
  ).rows[0].count;
  await page.getByRole('button', { name: 'Scan New Batch', exact: true }).click();
  await page.getByRole('heading', { name: 'No active batch', exact: true }).waitFor();
  assert.equal(await page.locator('.scanner-page').count(), 0);
  assert.equal(
    (await f.pool.query('SELECT count(*)::int AS count FROM archive_batches')).rows[0].count,
    batchCountBefore,
  );
  await page.getByRole('menuitem', { name: 'Capture Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Scan New Batch', exact: true }).click();
  await page.getByRole('button', { name: 'Scan feeder', exact: true }).waitFor();
  assert.equal(
    (await f.pool.query('SELECT count(*)::int AS count FROM archive_batches')).rows[0].count,
    batchCountBefore,
  );
  assert.equal(await page.getByRole('button', { name: 'Batch Info', exact: true }).count(), 0);
  assert.equal(await page.locator('[aria-label="Captured page count"]').innerText(), '0');
  assert.equal(await page.getByLabel('Document title', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Advanced scanner settings', exact: true }).click();
  await page.getByLabel('Page Delay (ms)', { exact: true }).fill('200');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await choose('Simulation Scenario', 'Duplex Document');
  const started = page.waitForResponse(
    (response) =>
      response.url().endsWith('/scan-sessions') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Scan feeder', exact: true }).click();
  assert.equal((await started).status(), 200);
  const scanProgress = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: 'Cancel scan', exact: true }) });
  await scanProgress.waitFor();
  assert.equal(
    await scanProgress.getByRole('button').count(),
    1,
    'Cancel is the only scan-dialog action',
  );
  assert.equal(await page.locator('.app-shell').evaluate((element) => element.inert), true);
  await page.keyboard.press('Escape');
  assert.equal(await scanProgress.isVisible(), true, 'Escape cannot dismiss scan progress');
  const acceptReload = (dialog) => dialog.accept();
  page.on('dialog', acceptReload);
  await page.reload();
  page.off('dialog', acceptReload);
  await captureFinished(1, 4);
  assert.equal(
    (await f.pool.query('SELECT count(*)::int AS count FROM archive_batches')).rows[0].count,
    batchCountBefore + 1,
  );
  const batchA = await page.locator('.batch-context h1 .ant-tag').first().innerText();
  assert.equal(await page.locator('.batch-context h1 .ant-tag').count(), 2);
  assert.equal(
    (await page.locator('.batch-context h1').innerText()).includes('Active batch'),
    false,
  );
  assert.match(batchA, /^B-\d{8}-\d{6}-[A-F0-9]{8}$/);
  await page.getByRole('button', { name: 'Batch Info', exact: true }).click();
  await page.getByLabel('Physical location', { exact: true }).fill('Rack A-12');
  await page.getByRole('button', { name: 'Save location', exact: true }).click();
  assert.equal(await page.locator('.scanner-page').count(), 4);
  assert.equal(await page.locator('.scan-message').count(), 0);
  assert.equal(await page.getByText(/^(Last|This) session:/).count(), 0);
  assert.equal(await page.locator('[aria-label="Captured page count"]').count(), 1);
  assert.equal(await page.getByText('Original retained', { exact: true }).count(), 0);
  assert.equal(await page.locator('.session-result').count(), 0);
  await page.getByRole('button', { name: 'Rotate right', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.image-paper img')?.style.transform.includes('rotate(90deg)'),
  );
  await page.getByRole('button', { name: 'Rotate left', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.image-paper img')?.style.transform.includes('rotate(0deg)'),
  );
  await page.getByRole('button', { name: 'Remove page', exact: true }).click();
  await page.getByRole('button', { name: 'Undo removal', exact: true }).waitFor();
  assert.equal(await page.locator('[aria-label="Captured page count"]').innerText(), '3');
  await page.getByRole('button', { name: 'Undo removal', exact: true }).click();
  await captureFinished(1, 4);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.thumbnail-media img')].every(
      (image) => image.complete && image.naturalWidth > 0 && image.naturalWidth <= 320,
    ),
  );
  await page.getByRole('button', { name: 'Actual size (original)', exact: true }).click();
  await page.getByRole('button', { name: 'Fit width', exact: true }).click();
  const pageViewport = page.locator('.image-viewport');
  const fitWidth = await pageViewport
    .locator('.image-paper')
    .evaluate((element) => element.offsetWidth);
  const viewportWidth = await pageViewport.evaluate((element) => element.clientWidth);
  assert.ok(Math.abs(fitWidth - (viewportWidth - 32)) <= 2);
  await pageViewport.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await page.waitForFunction(
    (width) => document.querySelector('.image-paper').offsetWidth > width,
    fitWidth,
  );
  await pageViewport.focus();
  await page.keyboard.press('Control+0');
  await page.waitForFunction(
    (width) => Math.abs(document.querySelector('.image-paper').offsetWidth - width) <= 2,
    fitWidth,
  );
  await page.getByRole('button', { name: 'Fullscreen preview', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [1280, 720],
  ]) {
    await page.setViewportSize({ width, height });
    const preview = await page.locator('.image-viewport').boundingBox();
    assert.ok(preview.height > 180);
    await contained(`scanner-${width}`);
  }
  await page.getByRole('button', { name: 'Scan feeder', exact: true }).click();
  await captureFinished(2, 8);
  assert.equal(await page.locator('.scanner-page').count(), 8);
  await contained('scanner-two-sessions-1280');
  await choose('Scan session', 'Session 001 · 4 pages · completed');
  await page.waitForFunction(() => document.querySelectorAll('.scanner-page').length === 4);
  assert.equal(await page.locator('.scanner-page').count(), 4);
  assert.equal(await page.locator('[aria-label="Captured page count"]').innerText(), '8');
  await choose('Scan session', 'All sessions');
  await page.getByRole('button', { name: 'Save & Exit', exact: true }).click();
  await page.getByRole('heading', { name: 'Capture Workspace', exact: true }).waitFor();
  assert.equal(await activityToggle.getAttribute('aria-expanded'), 'false');
  await activityToggle.click();
  await activity.getByRole('cell', { name: 'Batch paused', exact: true }).waitFor();
  assert.equal(await activity.getByText('batch.paused', { exact: true }).count(), 0);
  await contained('recent-activity-expanded-1280');
  await activityToggle.focus();
  await activityToggle.press('Enter');
  await activity
    .getByRole('cell', { name: 'Batch paused', exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(await activityToggle.getAttribute('aria-expanded'), 'false');
  await page.getByRole('menuitem', { name: 'Scanner', exact: true }).click();
  await page.getByRole('heading', { name: 'No active batch', exact: true }).waitFor();
  assert.equal(await page.locator('.thumbnail-media').count(), 0);
  await contained('empty-scanner-1280');
  await choose('Simulation Scenario', 'Normal Document');
  await page.getByRole('button', { name: 'Scan feeder', exact: true }).click();
  await captureFinished(1, 1);
  assert.equal(await page.locator('.scanner-page').count(), 1);
  await page.getByRole('button', { name: 'Save & Exit', exact: true }).click();
  await page.getByRole('menuitem', { name: 'My Batches', exact: true }).click();
  await page.getByRole('tab', { name: /^Paused/ }).click();
  assert.equal(
    await page
      .locator('.worklist-tabs')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(255, 255, 255)',
  );
  assert.equal(
    await page
      .getByRole('columnheader', { name: /Activity/ })
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(255, 255, 255)',
  );
  await page.getByRole('row').filter({ hasText: batchA }).waitFor();
  await contained('paused-batches-1280');
  await page
    .getByRole('row')
    .filter({ hasText: batchA })
    .getByRole('button', { name: 'Resume', exact: true })
    .click();
  await page.getByRole('button', { name: 'Scan feeder', exact: true }).waitFor();
  assert.equal(await page.locator('.scanner-page').count(), 8);
  await captureFinished(2, 8);
  assert.equal(
    await page.getByRole('button', { name: 'Add Another Session', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'Scan feeder', exact: true }).click();
  await captureFinished(3, 9);
  assert.equal(await page.locator('.scanner-page').count(), 9);
  await page.getByRole('button', { name: 'Complete Capture', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Complete Capture', exact: true })
    .click();
  await page.getByLabel('Document preparation', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('heading', { name: 'My Batches', exact: true }).waitFor();
  await page.getByRole('tab', { name: /^Capture Completed/ }).click();
  const completedRow = page.getByRole('row').filter({ hasText: batchA });
  await completedRow.waitFor();
  assert.equal(
    await completedRow.getByRole('button', { name: 'Delete batch', exact: true }).count(),
    0,
  );
  await page
    .getByRole('row')
    .filter({ hasText: batchA })
    .getByRole('button', { name: 'View details', exact: true })
    .click();
  await page.getByText('Capture completed · Read-only', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Scan feeder', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Scanner controls', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Open OCR', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Rotate right', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Remove page', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Back to My Batches', exact: true }).click();
  await page.getByRole('button', { name: 'Scan New Batch', exact: true }).click();
  await choose('Simulation Scenario', 'Paper Jam After Page 2');
  await page.getByRole('button', { name: 'Scan feeder', exact: true }).click();
  await captureFinished(1, 2);
  assert.equal(await page.locator('.scanner-page').count(), 2);
  await page
    .getByText('Simulated paper jam after page 2. Captured pages are retained.', { exact: true })
    .waitFor();
  await contained('partial-session-1280');
  await page.getByRole('button', { name: 'Complete Capture', exact: true }).click();
  const confirm = page
    .getByRole('dialog')
    .getByRole('button', { name: 'Complete Capture', exact: true });
  assert.equal(await confirm.isDisabled(), true);
  await page.getByRole('checkbox').check();
  await confirm.click();
  await page.getByLabel('Document preparation', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('heading', { name: 'My Batches', exact: true }).waitFor();
  await page.route('**/api/batches', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Database unavailable. Retry after PostgreSQL recovers.' }),
        })
      : route.continue(),
  );
  await page.getByRole('button', { name: 'Scan New Batch', exact: true }).click();
  await page.getByRole('button', { name: 'Scan feeder', exact: true }).click();
  await page
    .getByText('Database unavailable. Retry after PostgreSQL recovers.', { exact: true })
    .waitFor();
  assert.equal(await page.locator('.scanner-page').count(), 0);
  await page.unroute('**/api/batches');
  await page.getByRole('button', { name: 'Advanced scanner settings', exact: true }).click();
  await page.getByLabel('Page Delay (ms)', { exact: true }).fill('2000');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await choose('Simulation Scenario', 'Multi-page Feeder');
  await page.getByRole('button', { name: 'Scan feeder', exact: true }).click();
  await page.getByRole('dialog').getByText('1 page captured', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel scan', exact: true }).click();
  await page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: /Cancel.*scan/ }) })
    .waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.app-shell').evaluate((element) => element.inert), false);
  assert.ok(Number(await page.locator('[aria-label="Captured page count"]').innerText()) >= 1);
  await page.getByRole('button', { name: 'Save & Exit', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn('browser-admin', adminPassword);
  await page.getByRole('heading', { name: 'Users', exact: true }).waitFor();
  await page.getByLabel('Search users', { exact: true }).fill('browser-operator');
  await page
    .getByRole('row')
    .filter({ hasText: 'browser-operator' })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await page.getByLabel('Display name', { exact: true }).fill('Updated Capture Operator');
  await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await page.getByRole('cell', { name: 'Updated Capture Operator', exact: true }).waitFor();
  await page
    .getByRole('row')
    .filter({ hasText: 'browser-operator' })
    .getByRole('button', { name: 'Disable', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await page.getByRole('cell', { name: 'Disabled', exact: true }).waitFor();
  await page
    .getByRole('row')
    .filter({ hasText: 'browser-operator' })
    .getByRole('button', { name: 'Reset', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await page.getByText('Temporary credentials · shown once', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'I have saved these credentials' }).click();
  assert.equal(await page.locator('.temporary-password:visible').count(), 0);
  const viewer = await f.account(['archive_viewer']);
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: 'digitalarch_session',
      value: viewer.cookie.split('=')[1],
      url: f.origin,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  await page.reload();
  await page
    .getByRole('heading', { name: 'Your workspace is not yet available', exact: true })
    .waitFor();
  await contained('future-workspace-1280');
  assert.deepEqual(exceptions, []);
  assert.deepEqual(csp, []);
  console.log(
    'Browser passed: administration, forced password change, batch switching, 4+4=8 cumulative counts, session filtering, collapsible activity with readable events, partial acknowledgement, read-only completion, empty scanner, viewport containment at 1920/1366/1280, CSP. No hardware or browser downloads.',
  );
} catch (error) {
  if (page) await page.screenshot({ path: '.impeccable/review/failure.png', fullPage: true });
  throw error;
} finally {
  await browser?.close();
  await f.cleanup();
}
