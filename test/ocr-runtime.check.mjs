import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { samples, writeOcrSamples } from './ocr-samples.mjs';
import { windowsOcrProvider, ocrSettings } from '../server/ocr-provider.mjs';
import { digest } from '../server/auth.mjs';
import { testApplication, scanned } from './support.mjs';
import { processingConfig } from '../server/ocr-profiles.mjs';

test(
  'installed NAPS2/Tesseract: independent Indonesian and English recognition plus bilingual simulator persistence',
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp('/tmp/opencode/digitalarch-ocr-samples-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeOcrSamples(directory);
    const engine = windowsOcrProvider(ocrSettings());
    const missingResources = windowsOcrProvider({
      ...ocrSettings(),
      tessdata: 'C:\\DigitalArch-missing-ocr-resources-test',
    });
    await assert.rejects(
      missingResources.info('ind+eng'),
      (error) => error.code === 'ocr_language_missing' && /ind\.traineddata/.test(error.message),
    );
    const evidence = [];
    for (const sample of samples) {
      const before = await readFile(path.join(directory, sample.name));
      const info = await engine.info(sample.language);
      const result = await engine.process(before, { rotation_degrees: 0 }, sample.language);
      const normalized = result.text.replace(/\s+/g, ' ').trim();
      for (const line of sample.lines)
        assert.ok(
          normalized.includes(line),
          JSON.stringify({ language: sample.language, expected: line, actual: result.text }),
        );
      assert.ok(result.structuredResult.lines.length >= 3);
      assert.ok(
        result.structuredResult.lines.some((line) =>
          line.words.some((word) => word.bounds.width > 0),
        ),
      );
      assert.equal(info.engineVersion, result.engineVersion);
      assert.deepEqual(await readFile(path.join(directory, sample.name)), before);
      evidence.push({
        language: sample.language,
        engineVersion: result.engineVersion,
        text: result.text,
        lines: result.structuredResult.lines.length,
        configuration: result.configuration,
        sha256: digest(before),
      });
    }
    const regionSample = await readFile(path.join(directory, samples[0].name));
    const regionConfig = processingConfig({
      profile: 'standard',
      psm: 6,
      layout: 'regions',
      preprocessing: { lineRemoval: true },
    });
    const regionResult = await engine.process(
      regionSample,
      { rotation_degrees: 0 },
      samples[0].language,
      undefined,
      regionConfig,
    );
    for (const line of samples[0].lines)
      assert.ok(regionResult.text.replace(/\s+/g, ' ').includes(line));
    assert.ok(regionResult.structuredResult.regions.length > 0);
    for (const line of regionResult.structuredResult.lines) {
      assert.ok(line.bounds.x >= 0 && line.bounds.y >= 0);
      assert.ok(
        line.bounds.x + line.bounds.width <= regionResult.structuredResult.pageBounds.width,
      );
      assert.ok(
        line.bounds.y + line.bounds.height <= regionResult.structuredResult.pageBounds.height,
      );
    }
    assert.deepEqual(await readFile(path.join(directory, samples[0].name)), regionSample);
    const f = await testApplication(t, { customFixtures: directory, ocr: { provider: engine } });
    const operator = await f.account();
    let result = (await operator.request('/api/batches', {})).body;
    result = await scanned(operator, result.batch, { scenario: 'multi', pageDelay: 0 });
    assert.equal(result.pages.length, 2);
    const response = await operator.request(`/api/batches/${result.batch.id}/complete-capture`, {
      version: result.batch.version,
    });
    assert.equal(response.status, 200);
    while (await f.app.ocr.runOne()) {
      /* One image per claim. */
    }
    const job = (await operator.request('/api/ocr/jobs')).body.jobs[0];
    assert.equal(job.status, 'completed');
    assert.equal(job.processed_pages, 2);
    const pages = (await operator.request(`/api/ocr/jobs/${job.id}/pages`)).body.pages;
    for (let i = 0; i < samples.length; i++) {
      const normalized = pages[i].extracted_text.replace(/\s+/g, ' ').trim();
      for (const line of samples[i].lines) assert.ok(normalized.includes(line), normalized);
      assert.equal(pages[i].language, 'ind+eng');
      const bytes = await readFile(
        path.join(f.app.storage.root, result.pages[i].original_storage_key),
      );
      assert.equal(digest(bytes), result.pages[i].sha256);
    }
    await writeFile(
      '/tmp/opencode/digitalarch-ocr-recognition-evidence.json',
      JSON.stringify(
        {
          samples: evidence,
          bilingual: {
            status: job.status,
            pages: pages.map((p) => ({
              text: p.extracted_text,
              imageSha256: p.image_sha256,
              language: p.language,
              engineVersion: p.engine_version,
            })),
          },
        },
        null,
        2,
      ),
    );
  },
);
