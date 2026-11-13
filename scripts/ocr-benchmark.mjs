import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { database, transaction } from '../server/db.mjs';
import { uuid } from '../server/auth.mjs';
import { processingConfig, ocrProfiles } from '../server/ocr-profiles.mjs';

export function excerptDistance(expected, actual, fullPage = false) {
  let previous = new Uint32Array(actual.length + 1);
  if (fullPage) for (let i = 0; i < previous.length; i++) previous[i] = i;
  for (let row = 1; row <= expected.length; row++) {
    const next = new Uint32Array(actual.length + 1);
    next[0] = row;
    for (let col = 1; col <= actual.length; col++)
      next[col] = Math.min(
        next[col - 1] + 1,
        previous[col] + 1,
        previous[col - 1] + (expected[row - 1] === actual[col - 1] ? 0 : 1),
      );
    previous = next;
  }
  if (fullPage) return previous[actual.length];
  let best = expected.length;
  for (const distance of previous) best = Math.min(best, distance);
  return best;
}
const normalize = (text) => text.replace(/\s+/g, ' ').trim();
function excerptScore(references, text) {
  if (!references?.length) return null;
  const actual = normalize(text);
  let characters = 0,
    errors = 0;
  for (const reference of references) {
    const expected = normalize(reference);
    characters += expected.length;
    errors += excerptDistance(expected, actual);
  }
  return { characters, errors, characterErrorRate: errors / characters };
}

export function fullPageScore(reference, text) {
  if (!reference) return null;
  const expected = normalize(reference.text).replace(/\.{3,}|…+/g, '…');
  const actual = normalize(text).replace(/\.{3,}|…+/g, '…');
  const errors = excerptDistance(expected, actual, true);
  const tokens = new Set(text.match(/\d+/g) || []);
  const words = expected.split(' ');
  const wordErrors = excerptDistance(words, actual.split(' '), true);
  return {
    characters: expected.length,
    errors,
    characterErrorRate: errors / expected.length,
    words: words.length,
    wordErrors,
    wordErrorRate: wordErrors / words.length,
    exactValuesChecked: reference.exactValues?.length || 0,
    exactValuesMatched: (reference.exactValues || []).filter((value) => tokens.has(value)).length,
  };
}

export function fieldScore(reference, text) {
  if (!reference) return null;
  const actual = normalize(text);
  const score = (values) => ({
    checked: values?.length || 0,
    matched: (values || []).filter((value) => {
      const needle = normalize(value);
      let start = actual.indexOf(needle);
      while (start !== -1) {
        const before = actual[start - 1] || '',
          after = actual[start + needle.length] || '';
        if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
        start = actual.indexOf(needle, start + 1);
      }
      return false;
    }).length,
  });
  return { documentNumbers: score(reference.documentNumbers), dates: score(reference.dates) };
}

export const engineVariants = [
  { name: 'tesseract-standard-3', config: processingConfig() },
  {
    name: 'tesseract-regions-adaptive-6',
    config: processingConfig({ profile: 'high-accuracy', psm: 6, layout: 'regions' }),
  },
  ...ocrProfiles.map((profile) => ({
    name: `paddleocr-small-${profile}`,
    config: processingConfig({ engine: 'paddleocr', profile }),
  })),
];
export const threadVariants = [1, 2, 4].map((cpuThreads) => ({
  name: `paddleocr-enhanced-threads-${cpuThreads}`,
  config: processingConfig({ engine: 'paddleocr', profile: 'enhanced', cpuThreads }),
}));

export const layoutVariants = [
  { name: 'regions-standard-3', profile: 'standard', psm: 3 },
  { name: 'regions-standard-6', profile: 'standard', psm: 6 },
  { name: 'regions-no-denoise-6', profile: 'enhanced', psm: 6, preprocessing: { denoise: false } },
  { name: 'regions-adaptive-6', profile: 'high-accuracy', psm: 6 },
  {
    name: 'regions-lines-6',
    profile: 'enhanced',
    psm: 6,
    preprocessing: { denoise: false, lineRemoval: true },
  },
  {
    name: 'regions-adaptive-lines-6',
    profile: 'high-accuracy',
    psm: 6,
    preprocessing: { lineRemoval: true },
  },
].map(({ name, ...settings }) => ({
  name,
  config: processingConfig({ ...settings, layout: 'regions' }),
}));

export async function benchmark({
  pool,
  jobId,
  output,
  references = {},
  fullReferences = {},
  fieldReferences = {},
  mode = 'profiles',
  variant,
}) {
  uuid(jobId);
  const source = (
    await pool.query(
      `SELECT j.* FROM ocr_jobs j JOIN archive_batches b ON b.id=j.batch_id
    WHERE j.id=$1 AND b.status='capture_completed' AND b.deleted_at IS NULL`,
      [jobId],
    )
  ).rows[0];
  if (!source) throw new Error('Completed-capture OCR source job not found.');
  if (!['profiles', 'layout', 'engines', 'threads'].includes(mode))
    throw new Error('Benchmark mode must be profiles, layout, engines or threads.');
  if (
    !fieldReferences ||
    typeof fieldReferences !== 'object' ||
    Array.isArray(fieldReferences) ||
    !Object.values(fieldReferences).every(
      (ref) =>
        ref &&
        typeof ref === 'object' &&
        !Array.isArray(ref) &&
        Object.entries(ref).every(
          ([key, values]) =>
            ['documentNumbers', 'dates'].includes(key) &&
            Array.isArray(values) &&
            values.every((value) => typeof value === 'string' && normalize(value).length),
        ),
    )
  )
    throw new Error('Field references must map page IDs to documentNumbers/dates string arrays.');
  if (
    !fullReferences ||
    typeof fullReferences !== 'object' ||
    Array.isArray(fullReferences) ||
    !Object.values(fullReferences).every(
      (reference) =>
        reference &&
        typeof reference.text === 'string' &&
        normalize(reference.text).length &&
        (!reference.exactValues ||
          (Array.isArray(reference.exactValues) &&
            reference.exactValues.every(
              (value) => typeof value === 'string' && /^\d+$/.test(value),
            ))),
    )
  )
    throw new Error(
      'Full references must map page IDs to transcribed text and optional exact digit strings.',
    );
  const choices =
    mode === 'threads'
      ? threadVariants
      : mode === 'engines'
        ? engineVariants
        : mode === 'layout'
          ? layoutVariants
          : ocrProfiles.flatMap((profile) =>
              [3, 4, 6].map((psm) => ({
                name: `${profile}-${psm}`,
                config: processingConfig({ profile, psm }),
              })),
            );
  const variants = variant ? choices.filter((choice) => choice.name === variant) : choices;
  if (!variants.length) throw new Error('Unknown benchmark variant.');
  if (
    !references ||
    typeof references !== 'object' ||
    Array.isArray(references) ||
    !Object.values(references).every(
      (excerpts) =>
        Array.isArray(excerpts) &&
        excerpts.every((text) => typeof text === 'string' && normalize(text).length > 0),
    )
  )
    throw new Error('References must map page IDs to nonempty transcribed excerpts.');
  const token = `benchmark-${randomUUID()}`;
  const jobs = await transaction(pool, async (client) => {
    await client.query('SELECT id FROM archive_batches WHERE id=$1 FOR UPDATE', [source.batch_id]);
    const changed = (
      await client.query(
        `SELECT 1 FROM (SELECT * FROM pages WHERE batch_id=$1 AND NOT is_excluded) p FULL JOIN
      (SELECT * FROM page_ocr_results WHERE ocr_job_id=$2) r ON r.page_id=p.id
      WHERE (p.id IS NULL OR r.id IS NULL OR
       ROW(p.active_storage_key,p.active_image_sha256,p.rotation_degrees,p.image_revision)
       IS DISTINCT FROM ROW(r.storage_key,r.image_sha256,r.rotation_degrees,r.image_revision)) LIMIT 1`,
        [source.batch_id, jobId],
      )
    ).rowCount;
    if (changed)
      throw new Error(
        'Source job images differ from the current batch. Benchmark a current job so every run uses identical source snapshots.',
      );
    const ids = [];
    for (const { config } of variants) {
      const id = (
        await client.query('SELECT queue_batch_ocr($1,$2,$3,$4) AS id', [
          source.batch_id,
          source.language,
          config,
          token,
        ])
      ).rows[0].id;
      if (!id) throw new Error('Benchmark requires retained captured pages.');
      ids.push(id);
    }
    return ids;
  });
  console.log(`Queued ${jobs.length} OCR benchmark runs on the existing worker (concurrency 1).`);
  const deadline = Date.now() + Math.max(300000, jobs.length * source.total_pages * 180000);
  let states;
  while (Date.now() < deadline) {
    states = (await pool.query('SELECT id,status FROM ocr_jobs WHERE id=ANY($1::uuid[])', [jobs]))
      .rows;
    if (
      states.every((job) =>
        ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(job.status),
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (
    !states.every((job) =>
      ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(job.status),
    )
  )
    throw new Error('Benchmark wait expired. Persisted jobs remain available in OCR Processing.');
  const rows = (
    await pool.query(
      `SELECT j.id,j.processing_config,j.status,r.page_id,r.image_sha256,r.status AS page_status,
    coalesce(r.extracted_text,c.extracted_text,'') AS text,coalesce(r.structured_result,c.structured_result) AS structured,
    CASE WHEN r.reused_result_id IS NULL THEN r.processing_ms ELSE c.processing_ms END AS processing_ms,
    r.reused_result_id IS NOT NULL AS reused,r.error_code
    FROM ocr_jobs j JOIN page_ocr_results r ON r.ocr_job_id=j.id LEFT JOIN page_ocr_results c ON c.id=r.reused_result_id
    WHERE j.id=ANY($1::uuid[]) ORDER BY j.created_at,r.page_id`,
      [jobs],
    )
  ).rows;
  const baseline = (
    await pool.query(
      `SELECT r.page_id,coalesce(r.extracted_text,c.extracted_text,'') AS text,r.processing_ms,
    r.image_sha256 FROM page_ocr_results r LEFT JOIN page_ocr_results c ON c.id=r.reused_result_id WHERE r.ocr_job_id=$1`,
      [jobId],
    )
  ).rows;
  for (const page of baseline) {
    page.excerptScore = excerptScore(references[page.page_id], page.text);
    page.fullPageScore = fullPageScore(fullReferences[page.page_id], page.text);
    page.fieldScore = fieldScore(fieldReferences[page.page_id], page.text);
  }
  const runs = jobs.map((id, index) => {
    const pages = rows
      .filter((row) => row.id === id)
      .map((row) => ({
        ...row,
        excerptScore: excerptScore(references[row.page_id], row.text),
        fullPageScore: fullPageScore(fullReferences[row.page_id], row.text),
        fieldScore: fieldScore(fieldReferences[row.page_id], row.text),
      }));
    const scores = pages.map((page) => page.excerptScore).filter(Boolean);
    const characters = scores.reduce((sum, score) => sum + score.characters, 0);
    const errors = scores.reduce((sum, score) => sum + score.errors, 0);
    return {
      jobId: id,
      variant: variants[index].name,
      engine: pages[0]?.processing_config.engine || 'tesseract',
      cpuThreads:
        pages[0]?.processing_config.engine === 'paddleocr'
          ? (pages[0].processing_config.cpuThreads ?? 1)
          : null,
      profile: pages[0]?.processing_config.profile,
      psm: pages[0]?.processing_config.psm,
      status: pages[0]?.status,
      totalProcessingMs: pages.reduce((sum, page) => sum + (page.processing_ms || 0), 0),
      peakEngineWorkingSetBytes: pages.some(
        (p) =>
          p.structured?.runtime?.enginePeakWorkingSetBytes ||
          p.structured?.runtime?.tesseractPeakWorkingSetBytes,
      )
        ? Math.max(
            ...pages.map(
              (p) =>
                p.structured?.runtime?.enginePeakWorkingSetBytes ||
                p.structured?.runtime?.tesseractPeakWorkingSetBytes ||
                0,
            ),
          )
        : null,
      fullPageWordErrorRate: pages.some((p) => p.fullPageScore)
        ? pages.reduce((s, p) => s + (p.fullPageScore?.wordErrors || 0), 0) /
          pages.reduce((s, p) => s + (p.fullPageScore?.words || 0), 0)
        : null,
      fieldAccuracy: Object.fromEntries(
        ['documentNumbers', 'dates'].map((key) => [
          key,
          {
            checked: pages.reduce((s, p) => s + (p.fieldScore?.[key].checked || 0), 0),
            matched: pages.reduce((s, p) => s + (p.fieldScore?.[key].matched || 0), 0),
          },
        ]),
      ),
      peakTesseractWorkingSetBytes: pages.some(
        (page) => page.structured?.runtime?.tesseractPeakWorkingSetBytes > 0,
      )
        ? Math.max(
            0,
            ...pages.map((page) => page.structured?.runtime?.tesseractPeakWorkingSetBytes || 0),
          )
        : null,
      excerptCharacterErrorRate: characters ? errors / characters : null,
      fullPageCharacterErrorRate: pages.some((p) => p.fullPageScore)
        ? pages.reduce((s, p) => s + (p.fullPageScore?.errors || 0), 0) /
          pages.reduce((s, p) => s + (p.fullPageScore?.characters || 0), 0)
        : null,
      pages,
    };
  });
  const report = {
    sourceJobId: jobId,
    createdAt: new Date().toISOString(),
    language: source.language,
    sourceConfiguration: source.engine_config,
    measurement:
      'Per-page Node pipeline wall time; Tesseract Windows peak working set or PaddleOCR Linux child ru_maxrss (includes cold imports/model loading). Not whole-tree or OS-equivalent memory. Reused results retain original measurements.',
    qualityScope:
      'Excerpt error rates apply only to supplied manually transcribed excerpts, not whole-page accuracy. Without references, no accuracy score is reported.',
    fullPageScope:
      'Full-page CER compares all transcribed non-logo printed text, including insertions/deletions, normalizing whitespace and dotted leaders only. Exact digit values are measured, never corrected. Unreferenced pages are not scored.',
    baseline,
    runs,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.table(
    runs.map(
      ({
        profile,
        psm,
        status,
        totalProcessingMs,
        peakTesseractWorkingSetBytes,
        peakEngineWorkingSetBytes,
        fullPageWordErrorRate,
        fieldAccuracy,
        cpuThreads,
        excerptCharacterErrorRate,
        fullPageCharacterErrorRate,
        variant,
      }) => ({
        profile,
        variant,
        psm,
        cpuThreads: cpuThreads ?? 'SDK managed',
        status,
        totalSeconds: (totalProcessingMs / 1000).toFixed(2),
        peakEngineMiB:
          (peakEngineWorkingSetBytes ?? peakTesseractWorkingSetBytes) === null
            ? 'not measured'
            : ((peakEngineWorkingSetBytes ?? peakTesseractWorkingSetBytes) / 1048576).toFixed(1),
        fullPageWER:
          fullPageWordErrorRate == null
            ? 'not measured'
            : `${(fullPageWordErrorRate * 100).toFixed(2)}%`,
        documentNumbers: `${fieldAccuracy.documentNumbers.matched}/${fieldAccuracy.documentNumbers.checked}`,
        dates: `${fieldAccuracy.dates.matched}/${fieldAccuracy.dates.checked}`,
        excerptCER:
          excerptCharacterErrorRate === null
            ? 'not measured'
            : `${(excerptCharacterErrorRate * 100).toFixed(2)}%`,
        fullPageCER:
          fullPageCharacterErrorRate == null
            ? 'not measured'
            : `${(fullPageCharacterErrorRate * 100).toFixed(2)}%`,
      }),
    ),
  );
  console.log('Private benchmark report saved; extracted document text was not printed.');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argument = (name) =>
    process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const pool = database();
  try {
    const references = argument('references')
      ? JSON.parse(await readFile(argument('references'), 'utf8'))
      : {};
    await benchmark({
      pool,
      jobId: argument('job'),
      references,
      fullReferences: argument('full-references')
        ? JSON.parse(await readFile(argument('full-references'), 'utf8'))
        : {},
      fieldReferences: argument('field-references')
        ? JSON.parse(await readFile(argument('field-references'), 'utf8'))
        : {},
      mode: argument('mode') || 'profiles',
      variant: argument('variant'),
      output: path.resolve(argument('output') || `.local/ocr-benchmarks/${randomUUID()}.json`),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
