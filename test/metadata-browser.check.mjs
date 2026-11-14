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
  const reviewNotices = [
    'Similar spellings were grouped as alternatives. Check each against the source.',
    'Printed pagination suggests more pages than the completed OCR pages in this run. Check document completeness.',
    'Different personal names require role verification.',
  ];
  await f.pool.query(
    "UPDATE documents SET metadata_json=jsonb_set(metadata_json,'{warnings}',$2::jsonb) WHERE batch_id=$1",
    [batch.id, JSON.stringify(reviewNotices)],
  );
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
  const listQuery = new URLSearchParams({
    q: batch.batch_code,
    sort: 'total_pages',
    direction: 'asc',
    size: '50',
    page: '1',
  });
  await page.goto(`${f.origin}/ocr?${listQuery}`);
  await page.getByRole('button', { name: 'Open OCR job', exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('Search OCR jobs', { exact: true }).inputValue(),
    batch.batch_code,
  );
  assert.equal(
    await page.getByRole('columnheader', { name: /Pages/ }).getAttribute('aria-sort'),
    'ascending',
  );
  assert.match(
    await page.getByRole('status', { name: 'Filtered table totals', exact: true }).innerText(),
    /1\s*jobs/,
  );
  await page.getByRole('button', { name: 'Open OCR job', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, `/ocr/jobs/${jobId}`);
  assert.equal(new URL(page.url()).searchParams.get('returnTo'), `/ocr?${listQuery}`);
  await page.getByRole('progressbar', { name: 'OCR job progress', exact: true }).waitFor();
  assert.match(
    await page.locator('.status-bar').innerText(),
    /3 \/ 3 processed · 0 failed · 1 scan session/,
  );
  assert.equal(await page.locator('.ocr-progress-strip').count(), 0);
  await page.getByRole('button', { name: 'All jobs', exact: true }).click();
  await page.getByRole('button', { name: 'Open OCR job', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('progressbar', { name: 'OCR job progress', exact: true }).count(),
    0,
  );
  assert.equal(new URL(page.url()).searchParams.get('q'), batch.batch_code);
  assert.equal(new URL(page.url()).searchParams.get('size'), '50');
  await page.reload();
  await page.getByRole('button', { name: 'Open OCR job', exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('Search OCR jobs', { exact: true }).inputValue(),
    batch.batch_code,
  );
  assert.equal(
    await page.getByRole('columnheader', { name: /Pages/ }).getAttribute('aria-sort'),
    'ascending',
  );
  await page.getByRole('button', { name: 'Open OCR job', exact: true }).click();
  await page.getByRole('tab', { name: 'Recognized text', exact: true }).waitFor();
  const pageRail = page.locator('.ocr-inspection-body > .registry-table-region');
  assert.equal(
    await pageRail.getByRole('columnheader', { name: 'Status', exact: true }).count(),
    0,
  );
  await pageRail
    .locator('.ocr-page-list-item')
    .first()
    .getByText('Completed', { exact: true })
    .waitFor();
  assert.equal(
    await pageRail
      .getByRole('columnheader', { name: 'Page', exact: true })
      .evaluate((element) => element.getBoundingClientRect().height < 60),
    true,
    'Page rail header must not wrap vertically',
  );
  assert.equal(
    await pageRail.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    'Page rail must fit its available width',
  );
  assert.equal(await page.getByLabel('Extracted text', { exact: true }).isVisible(), true);
  await page.getByRole('tab', { name: 'Job details', exact: true }).click();
  await page.locator('.ocr-job-details').getByText('Engine', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Extracted text', { exact: true }).isVisible(), false);
  assert.equal(await page.locator('.workspace > .ant-collapse').count(), 0);
  assert.match(await page.locator('.ocr-job-details').innerText(), /test-engine|fixture/);
  await page.getByRole('tab', { name: 'Run metadata history', exact: true }).click();
  assert.equal(await page.locator('.ocr-job-details').isVisible(), false);
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
  const openDocument = page.getByRole('button', { name: 'Open document', exact: true });
  assert.equal(
    await openDocument.evaluate((button) => button.classList.contains('ant-btn-primary')),
    true,
  );
  assert.equal(
    await openDocument.evaluate(
      (button) =>
        !!(
          button
            .closest('.workspace-toolbar')
            .querySelector('.toolbar-spacer')
            .compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
    true,
  );
  await openDocument.click();
  await page.getByLabel('Field 1 value', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('progressbar', { name: 'OCR job progress', exact: true }).count(),
    0,
  );
  assert.equal(await page.getByLabel('Field 1 value', { exact: true }).inputValue(), 'Rina Contoh');
  assert.equal(await page.locator('.metadata-field').count(), 3);
  const notices = page.locator('.metadata-notices');
  assert.match(
    await notices.locator('summary').innerText(),
    /3 review notices.*Check completeness/s,
  );
  assert.equal(await notices.evaluate((element) => element.open), false);
  assert.equal(await notices.locator('li').first().isVisible(), false);
  await notices.locator('summary').click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('notices') === '1');
  assert.equal(new URL(page.url()).searchParams.get('notices'), '1');
  assert.equal(await notices.locator('li').first().innerText(), reviewNotices[1]);
  await page.reload();
  await page.getByLabel('Field 1 value', { exact: true }).waitFor();
  assert.equal(await notices.evaluate((element) => element.open), true);
  assert.equal(await notices.locator('li').count(), 3);
  await notices.locator('summary').click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('notices') === '0');
  assert.equal(new URL(page.url()).searchParams.get('notices'), '0');
  assert.equal(await notices.locator('li').first().isVisible(), false);
  assert.deepEqual(
    (await f.pool.query('SELECT metadata_json FROM documents WHERE batch_id=$1', [batch.id]))
      .rows[0].metadata_json.warnings,
    reviewNotices,
    'Collapsing notices does not dismiss or resolve them',
  );
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
