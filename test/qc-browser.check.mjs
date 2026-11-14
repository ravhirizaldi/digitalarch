import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { testApplication, scanned, until } from './support.mjs';

// Only generated images, isolated PostgreSQL schemas, simulator and injected OCR.
const fixtures = await mkdtemp('/tmp/opencode/digitalarch-qc-fixtures-');
const image = await sharp({
  create: { width: 850, height: 1100, channels: 3, background: '#ffffff' },
})
  .png()
  .withMetadata({ density: 300 })
  .toBuffer();
const addFixtures = async (start, end) => {
  for (let i = start; i <= end; i++)
    await writeFile(path.join(fixtures, `page-${String(i).padStart(4, '0')}.png`), image);
};
await addFixtures(1, 10);
const info = { engine: 'Tesseract (NAPS2)', engineVersion: 'browser-fixture', configuration: {} };
const f = await testApplication(undefined, {
  customFixtures: fixtures,
  ocr: {
    provider: {
      async info() {
        return info;
      },
      async process() {
        return {
          ...info,
          text: 'Judul: Machine title\nNomor: DOC-100\nTanggal: 14 November 2026',
          structuredResult: { lines: [] },
          processingMs: 1,
        };
      },
    },
  },
});
let browser;
const errors = [];
const good = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const drain = async () => {
  for (let i = 0; i < 2000; i++) {
    if (!(await f.app.ocr.runOne())) break;
    assert.ok(i < 1999);
  }
  await f.app.qc.refresh();
};
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
        ].map((file) => path.join(cache, name, file)),
      )
      .find(existsSync);
    assert.ok(executablePath, 'Use an installed browser; do not download one.');
  }
  browser = await chromium.launch({ headless: true, executablePath });
  const op = await f.account(),
    qc = await f.account(['qc_officer']),
    qc2 = await f.account(['qc_officer']);
  async function pageFor(account) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const at = account.cookie.indexOf('=');
    await context.addCookies([
      {
        name: account.cookie.slice(0, at),
        value: account.cookie.slice(at + 1),
        url: f.origin,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (e) => {
      errors.push(e.message);
      console.error('Browser error:', e.message);
    });
    return page;
  }
  const p = await pageFor(op),
    q = await pageFor(qc),
    q2 = await pageFor(qc2);
  await p.goto(`${f.origin}/capture`);
  await p.getByRole('button', { name: 'Scan New Batch', exact: true }).click();
  await p.getByRole('button', { name: 'Scan feeder', exact: true }).click();
  let batch = await until(async () => {
    const rows = good(await op.request('/api/batches')).batches;
    return rows[0]?.page_count === 10 ? rows[0] : null;
  }, 30000);
  await until(async () => {
    const d = good(await op.request(`/api/batches/${batch.id}`));
    return d.sessions.every((s) => s.status !== 'running');
  });
  await p.getByRole('button', { name: 'Document / Metadata / QC', exact: true }).click();
  await p
    .getByRole('button', { name: 'Add field', exact: true })
    .waitFor()
    .catch(async (e) => {
      await p.screenshot({ path: '/tmp/opencode/digitalarch-qc-operator-debug.png' });
      console.error('Operator document state:', p.url(), await p.locator('body').innerText());
      throw e;
    });
  await p.getByRole('button', { name: 'Add field', exact: true }).click();
  await p.getByLabel('Field 1 type', { exact: true }).fill('Title');
  await p.locator('.ant-select-dropdown:visible').getByText('Title', { exact: true }).click();
  await p.getByLabel('Field 1 value', { exact: true }).fill('Human browser title');
  await p.getByRole('button', { name: 'Save metadata', exact: true }).click();
  await until(
    async () =>
      good(await op.request(`/api/batches/${batch.id}/metadata`)).metadata.fields[0]?.value ===
      'Human browser title',
  );
  await p.getByRole('button', { name: 'Capture / rework', exact: true }).click();
  await p.getByRole('button', { name: 'Complete Capture', exact: true }).click();
  await p
    .getByRole('dialog')
    .getByRole('button', { name: 'Complete Capture', exact: true })
    .click();
  await until(
    async () =>
      good(await op.request(`/api/batches/${batch.id}`)).batch.status === 'capture_completed',
  );
  await drain();
  await q.goto(`${f.origin}/qc`);
  await q.getByRole('button', { name: 'Open', exact: true }).first().click();
  await q.getByRole('button', { name: 'Claim document', exact: true }).click();
  await q.getByRole('button', { name: 'Pass QC', exact: true }).waitFor();
  assert.equal(
    await q.getByLabel('Field 1 value', { exact: true }).inputValue(),
    'Human browser title',
  );
  const verify = q.getByRole('button', { name: 'Verify', exact: true });
  for (let i = 0; i < (await verify.count()); i++) await verify.nth(i).click();
  await q.getByRole('button', { name: 'Save metadata', exact: true }).click();
  await until(async () =>
    good(await qc.request(`/api/batches/${batch.id}/metadata`)).metadata.fields.every(
      (field) => field.verification === 'verified',
    ),
  );
  await q.getByRole('tab', { name: 'Issues', exact: true }).click();
  for (const name of ['ordering reviewed', 'completeness reviewed', 'metadata reviewed'])
    await q.getByRole('checkbox', { name, exact: true }).check();
  await q.getByRole('button', { name: 'Save Draft', exact: true }).click();
  await until(
    async () => good(await qc.request(`/api/qc/${batch.id}`)).reviews[0].metadata_reviewed,
  );
  await q.getByRole('button', { name: 'Pass QC', exact: true }).click();
  await q.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await until(
    async () =>
      good(await qc.request(`/api/qc/${batch.id}`)).document.workflow_status ===
      'awaiting_approval_l1',
  );
  console.log(
    'A/D: ten-page normal capture, pre-OCR human metadata preservation, claim, verification and pass through browser controls.',
  );

  await addFixtures(11, 100);
  let capture = good(await op.request('/api/batches', {}));
  capture = await scanned(op, capture.batch, { scenario: 'multi', pageDelay: 0 });
  const multiId = capture.batch.id;
  assert.equal(capture.pages.length, 100);
  capture = good(
    await op.request(`/api/batches/${multiId}/pause`, { version: capture.batch.version }),
  );
  const other = good(await op.request('/api/batches', {}));
  await p.goto(`${f.origin}/scanner/${other.batch.id}`);
  await p.getByRole('heading', { name: new RegExp(other.batch.batch_code) }).waitFor();
  await p.goto(`${f.origin}/scanner/${multiId}`);
  await p.getByRole('heading', { name: new RegExp(capture.batch.batch_code) }).waitFor();
  capture = good(await op.request(`/api/batches/${multiId}`));
  capture = await scanned(op, capture.batch, { scenario: 'multi', pageDelay: 0 });
  assert.equal(capture.pages.length, 200);
  assert.equal(capture.sessions.length, 2);
  good(
    await op.request(`/api/batches/${multiId}/complete-capture`, {
      version: capture.batch.version,
    }),
  );
  await drain();
  await q.goto(`${f.origin}/documents/${multiId}`);
  await q.getByRole('button', { name: 'Claim document', exact: true }).click();
  await q.getByRole('button', { name: 'Pass QC', exact: true }).waitFor();
  await q2.goto(`${f.origin}/documents/${multiId}`);
  await q2.getByRole('button', { name: 'Claim document', exact: true }).click();
  await q2.getByText('Another QC Officer is reviewing this document.', { exact: true }).waitFor();
  await q.getByRole('button', { name: 'Release', exact: true }).click();
  await q2.getByRole('button', { name: 'Reload', exact: true }).click();
  await q2.getByRole('button', { name: 'Claim document', exact: true }).click();
  await q2.getByRole('button', { name: 'Pass QC', exact: true }).waitFor();
  console.log(
    'B/E: two 100-page sessions, switching and reload, cross-browser claim conflict, release and reclaim.',
  );

  let d = good(await qc2.request(`/api/qc/${multiId}`));
  const page45 = d.pages[44],
    page78 = d.pages[77];
  for (const [page, category, description] of [
    [page45, 'blurred_page', 'Page 45 is blurry'],
    [page78, 'missing_page', 'Insert missing page after page 78'],
  ]) {
    d = good(await qc2.request(`/api/qc/${multiId}`));
    good(
      await qc2.request(`/api/qc/${multiId}/findings`, {
        version: d.document.version,
        pageIds: [page.id],
        category,
        severity: 'critical',
        description,
      }),
    );
  }
  await q2.getByRole('button', { name: 'Reload', exact: true }).click();
  await q2.getByRole('button', { name: 'Return to Operator', exact: true }).click();
  await q2.getByLabel('QC decision reason').fill('Replace page 45 and insert after page 78.');
  await q2.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await until(
    async () => good(await op.request(`/api/qc/${multiId}`)).document.workflow_status === 'rework',
  );
  await p.goto(`${f.origin}/documents/${multiId}`);
  await p.getByRole('button', { name: 'View findings', exact: true }).click();
  await p.getByText('Page 45 is blurry', { exact: true }).waitFor();
  await p.getByRole('button', { name: 'Page 45', exact: true }).click();
  await p.getByRole('button', { name: 'Capture / rework', exact: true }).click();
  await p.getByRole('button', { name: 'Replace Page', exact: true }).click();
  // Single-page scenario keeps this replacement operation focused; multiple candidates are covered by API tests.
  await p.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await p.getByLabel('Simulation Scenario', { exact: true }).click();
  await p
    .locator('.ant-select-dropdown:visible')
    .getByText('Normal Document', { exact: true })
    .click();
  await p.getByRole('button', { name: 'Replace Page', exact: true }).click();
  await p
    .getByRole('dialog')
    .getByRole('button', { name: 'Scan replacement candidates', exact: true })
    .click();
  await p.getByLabel('Replacement candidate', { exact: true }).click();
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await p.getByRole('button', { name: 'Confirm selected replacement', exact: true }).click();
  await until(
    async () =>
      good(await op.request(`/api/batches/${multiId}`)).pages.find((pg) => pg.id === page45.id)
        .image_revision === 2,
  );
  capture = good(await op.request(`/api/batches/${multiId}`));
  good(
    await op.request(`/api/batches/${multiId}/scan-sessions`, {
      version: capture.batch.version,
      options: { scenario: 'single', pageDelay: 0 },
      placement: 'after',
      anchorPageId: page78.id,
    }),
  );
  capture = await until(async () => {
    const c = good(await op.request(`/api/batches/${multiId}`));
    return c.sessions.every((s) => s.status !== 'running') ? c : null;
  });
  good(await op.request(`/api/batches/${multiId}/resubmit-qc`, { version: capture.batch.version }));
  await drain();
  await q2.goto(`${f.origin}/documents/${multiId}`);
  await q2.getByRole('button', { name: 'Claim document', exact: true }).click();
  await q2.getByRole('button', { name: 'Pass QC', exact: true }).waitFor();
  d = good(await qc2.request(`/api/qc/${multiId}`));
  assert.equal(d.reviews.length, 2);
  assert.equal(d.reviews[1].outcome, 'returned');
  const verifyAgain = q2.getByRole('button', { name: 'Verify', exact: true });
  for (let i = 0; i < (await verifyAgain.count()); i++) await verifyAgain.nth(i).click();
  await q2.getByRole('button', { name: 'Save metadata', exact: true }).click();
  await until(async () =>
    good(await qc2.request(`/api/batches/${multiId}/metadata`)).metadata.fields.every(
      (field) => field.verification === 'verified',
    ),
  );
  await q2.getByRole('tab', { name: 'Issues', exact: true }).click();
  for (const description of ['Page 45 is blurry', 'Insert missing page after page 78']) {
    await q2
      .locator('.qc-finding')
      .filter({ hasText: description })
      .getByRole('button', { name: 'Update finding', exact: true })
      .click();
    await q2.getByLabel('Finding status', { exact: true }).click();
    await q2.locator('.ant-select-dropdown:visible').getByText('resolved', { exact: true }).click();
    await q2
      .getByLabel('Finding resolution note', { exact: true })
      .fill('Correction inspected in the new revision.');
    await q2.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
    await q2.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  for (const name of ['ordering reviewed', 'completeness reviewed', 'metadata reviewed'])
    await q2.getByRole('checkbox', { name, exact: true }).check();
  await q2.getByRole('button', { name: 'Save Draft', exact: true }).click();
  await until(
    async () => good(await qc2.request(`/api/qc/${multiId}`)).reviews[0].metadata_reviewed,
  );
  await q2.getByRole('button', { name: 'Pass QC', exact: true }).click();
  await q2.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await until(
    async () =>
      good(await qc2.request(`/api/qc/${multiId}`)).document.workflow_status ===
      'awaiting_approval_l1',
    90000,
  ).catch(async (e) => {
    console.error('Rework pass:', await q2.locator('body').innerText());
    await q2.screenshot({ path: '/tmp/opencode/digitalarch-qc-pass-debug.png' });
    throw e;
  });
  console.log(
    'C: returned findings, targeted page navigation, browser replacement preview/confirmation, insertion and a second QC cycle.',
  );
  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [1280, 720],
  ]) {
    await q2.setViewportSize({ width, height });
    for (const name of ['Metadata', 'OCR Text', 'Page Properties', 'Issues', 'History']) {
      await q2.getByRole('tab', { name, exact: true }).click();
      await q2.getByRole('tabpanel').filter({ visible: true }).waitFor();
      assert.equal(
        await q2.getByRole('tabpanel').count(),
        1,
        `${name}: only the active inspector panel is accessible`,
      );
      assert.equal(
        await q2.getByLabel('Field 1 value', { exact: true }).isVisible(),
        name === 'Metadata',
      );
      assert.equal(
        await q2.evaluate(
          () =>
            document.documentElement.scrollHeight <= innerHeight &&
            document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `${name}: viewport-contained ${width}x${height}`,
      );
      const bounds = await q2.locator('.qc-split').boundingBox();
      assert.ok(bounds.height > 200 && bounds.y + bounds.height <= height);
    }
    await q2.screenshot({ path: `/tmp/opencode/digitalarch-qc-${width}.png` });
  }
  assert.deepEqual(errors, []);
  let large = good(await op.request('/api/batches', {}));
  for (let i = 0; i < 5; i++)
    large = await scanned(op, large.batch, { scenario: 'multi', pageDelay: 0 });
  assert.equal(large.pages.length, 500);
  await q.goto(`${f.origin}/documents/${large.batch.id}`);
  await q.getByRole('tab', { name: 'Page Properties', exact: true }).click();
  assert.ok(
    (await q.locator('.scanner-page-list .page-item').count()) <= 40,
    '500 pages use a windowed thumbnail rail',
  );
  assert.equal(
    await q.getByRole('button', { name: 'Add field', exact: true }).isVisible(),
    false,
    'Metadata is hidden while inspecting page properties',
  );
  assert.equal(
    await q.evaluate(
      () =>
        document.documentElement.scrollHeight <= innerHeight &&
        document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await q.screenshot({ path: '/tmp/opencode/digitalarch-qc-500-pages.png' });
  console.log(
    '500-page fixture: five sessions in one document, bounded preview and windowed thumbnails.',
  );
  console.log(
    'Browser checks passed at all three desktop viewports; screenshots contain generated fixtures only.',
  );
} finally {
  await browser?.close();
  await f.cleanup();
  await rm(fixtures, { recursive: true, force: true });
}
