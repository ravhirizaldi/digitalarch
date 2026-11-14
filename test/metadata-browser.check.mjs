import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { testApplication, scanned } from './support.mjs';

// Explicit browser check: isolated database, synthetic capture, no OCR engine or hardware.
const info = { engine: 'Tesseract (NAPS2)', engineVersion: 'fixture', configuration: {} };
const f = await testApplication(undefined, {
  ocr: {
    provider: {
      async info() {
        return info;
      },
      async process() {
        return {
          ...info,
          text: 'Nama: Rina Contoh\nNama Perusahaan: PT. Contoh Arsip\nSerial Number: ZX1000A749',
          structuredResult: { lines: [] },
          processingMs: 1,
        };
      },
    },
  },
});
let browser;
try {
  const operator = await f.account();
  let batch = (await operator.request('/api/batches', {})).body.batch;
  batch = (await scanned(operator, batch, { scenario: 'multi', pageDelay: 0 })).batch;
  assert.equal(
    (
      await operator.request(`/api/batches/${batch.id}/complete-capture`, {
        version: batch.version,
      })
    ).status,
    200,
  );
  for (let i = 0; i < 20; i++) {
    if (!(await f.app.ocr.runOne())) break;
    assert.ok(i < 19, 'Synthetic queue drains');
  }
  await f.app.qc.refresh();
  const jobId = (await f.pool.query('SELECT id FROM ocr_jobs WHERE batch_id=$1', [batch.id]))
    .rows[0].id;
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
    assert.ok(executablePath, 'A cached Chromium is required; never download a browser');
  }
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const separator = operator.cookie.indexOf('=');
  await context.addCookies([
    {
      name: operator.cookie.slice(0, separator),
      value: operator.cookie.slice(separator + 1),
      url: f.origin,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${f.origin}/ocr/jobs/${jobId}`);
  await page.getByRole('tab', { name: 'Recognized text', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Extracted text', { exact: true }).isVisible(), true);
  await page.getByRole('tab', { name: 'Run metadata history', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'Extract all pages', exact: true }).count(),
    0,
  );
  await page.screenshot({ path: '/tmp/opencode/digitalarch-metadata-tabs.png' });
  console.log(
    'Tab panel visibility:',
    await page.locator('[role="tabpanel"]').evaluateAll((panels) =>
      panels.map((panel) => ({
        hidden: panel.getAttribute('aria-hidden'),
        display: getComputedStyle(panel).display,
        height: panel.getBoundingClientRect().height,
      })),
    ),
  );
  assert.equal(
    await page.getByLabel('Extracted text', { exact: true }).isVisible(),
    false,
    'Recognized text must be hidden on Metadata tab',
  );
  await page.getByRole('button', { name: 'Document metadata / QC', exact: true }).click();
  await page.getByLabel('Field 1 value', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Field 1 value', { exact: true }).inputValue(), 'Rina Contoh');
  assert.equal(await page.locator('.metadata-field').count(), 3);
  await page.getByLabel('Field 1 value', { exact: true }).fill('Rina Reviewed');
  await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
  await page
    .getByRole('button', { name: 'Save metadata', exact: true })
    .waitFor({ state: 'visible' });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent.includes('Save metadata') && button.disabled,
    ),
  );
  await page.getByRole('tab', { name: 'OCR Text', exact: true }).click();
  assert.equal(await page.getByLabel('QC effective OCR text', { exact: true }).isVisible(), true);
  assert.equal(await page.getByLabel('Field 1 value', { exact: true }).isVisible(), false);
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click();
  assert.equal(
    await page.getByLabel('Field 1 value', { exact: true }).inputValue(),
    'Rina Reviewed',
  );
  await page.reload();
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click();
  await page.getByLabel('Field 1 value', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('Field 1 value', { exact: true }).inputValue(),
    'Rina Reviewed',
  );
  for (const [width, height] of [
    [1280, 720],
    [1366, 768],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    const metadataBounds = await page.locator('.metadata-scroll').boundingBox();
    assert.ok(metadataBounds.height > 150 && metadataBounds.y + metadataBounds.height <= height);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
      true,
    );
  }
  await page.screenshot({ path: '/tmp/opencode/digitalarch-metadata-editor.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Metadata browser check passed: tab visibility, all-page extraction, editing, save/reload and bounded layout.',
  );
} finally {
  await browser?.close();
  await f.cleanup();
}
