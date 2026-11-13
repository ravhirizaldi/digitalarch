import { mkdir, mkdtemp, writeFile, rm, readdir, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { prepareScanner } from '../bridge.mjs';
import { digest } from './auth.mjs';
import { failure } from './errors.mjs';
import { processingConfig } from './ocr-profiles.mjs';
import { preprocessOcr } from './ocr-preprocess.mjs';
import { ocrRegions } from './ocr-layout.mjs';

export function ocrSettings(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const language = env.OCR_LANGUAGE || 'ind+eng';
  if (!['ind', 'eng', 'ind+eng', 'eng+ind'].includes(language))
    throw new Error('Invalid OCR_LANGUAGE.');
  if (env.OCR_PRIORITY && env.OCR_PRIORITY !== 'low')
    throw new Error('OCR_PRIORITY must be low; NAPS2 runs Tesseract BelowNormal.');
  const timeoutSeconds = integer('OCR_TIMEOUT_SECONDS', 120, 1, 600);
  return {
    language,
    concurrency: integer('OCR_WORKER_CONCURRENCY', 1, 1, 1),
    processingConfig: processingConfig({
      profile: env.OCR_PROFILE || 'standard',
      psm: env.OCR_PSM === undefined ? 3 : Number(env.OCR_PSM),
      engine: env.OCR_ENGINE || 'tesseract',
      cpuThreads:
        env.OCR_ENGINE === 'paddleocr' && env.OCR_PADDLE_CPU_THREADS !== undefined
          ? Number(env.OCR_PADDLE_CPU_THREADS)
          : undefined,
    }),
    timeoutSeconds,
    maxAttempts: integer('OCR_MAX_ATTEMPTS', 3, 1, 5),
    // Longer than the Windows wrapper's maximum lifetime, even after a Node crash.
    leaseSeconds: timeoutSeconds + 90,
    retryDelayMs: 1000,
    tesseract: env.OCR_TESSERACT_PATH,
    tessdata: env.OCR_TESSDATA_PATH,
    paddlePython: env.OCR_PADDLE_PYTHON,
    paddleModels: env.OCR_PADDLE_MODELS,
  };
}

export function windowsOcrProvider(settings) {
  let preparing;
  let pipelineHash;
  const fingerprint = () =>
    (pipelineHash ||= Promise.all(
      ['ocr-provider.mjs', 'ocr-preprocess.mjs', 'ocr-pixels.mjs', 'ocr-layout.mjs'].map((file) =>
        readFile(new URL(file, import.meta.url)),
      ),
    ).then((files) => digest(Buffer.concat(files))));
  const helper = () =>
    (preparing ||= prepareScanner()
      .then(async (bridge) => {
        await mkdir(bridge.ocrRoot, { recursive: true });
        // Crash leftovers only: every live helper is bounded to at most 625 seconds.
        for (const name of await readdir(bridge.ocrRoot)) {
          if (!/^page-[a-zA-Z0-9]{6}$/.test(name)) continue;
          const directory = path.join(bridge.ocrRoot, name);
          const entry = await lstat(directory).catch(() => null);
          if (entry?.isDirectory() && Date.now() - entry.mtimeMs > 3600000)
            await rm(directory, { recursive: true, force: true });
        }
        return bridge;
      })
      .catch((error) => {
        preparing = null;
        throw error;
      }));
  function validate(result, language, config) {
    if (
      result.engine !== 'Tesseract (NAPS2)' ||
      typeof result.engineVersion !== 'string' ||
      !result.engineVersion ||
      result.language !== language ||
      result.configuration?.sdk !== 'NAPS2.Sdk/1.6.0' ||
      result.configuration?.preprocessing !== 'none' ||
      !language
        .split('+')
        .every((code) => /^[a-f0-9]{64}$/.test(result.configuration?.languageData?.[code]))
    )
      throw failure(
        'ocr_protocol',
        'OCR helper returned invalid engine or language information.',
        503,
      );
    return {
      engine: result.engine,
      engineVersion: result.engineVersion,
      configuration:
        config.profile === 'legacy'
          ? result.configuration
          : {
              ...result.configuration,
              processing: config,
              sharp: sharp.versions.sharp,
              vips: sharp.versions.vips,
            },
    };
  }
  const engineOptions = (config) => ({
    ...settings,
    quality: config.quality,
    psm: config.profile === 'legacy' ? undefined : config.psm,
  });
  return {
    async info(language, signal, config = settings.processingConfig) {
      const bridge = await helper();
      const info = validate(
        await bridge.ocrInfo(language, { ...engineOptions(config), signal }),
        language,
        config,
      );
      if (config.version >= 2)
        info.configuration = { ...info.configuration, pipelineSha256: await fingerprint() };
      return info;
    },
    async process(buffer, page, language, signal, config = settings.processingConfig) {
      const started = performance.now();
      const rssBefore = process.memoryUsage().rss;
      const bridge = await helper();
      await mkdir(bridge.ocrRoot, { recursive: true });
      const directory = await mkdtemp(path.join(bridge.ocrRoot, 'page-'));
      try {
        const pageSignal =
          config.layout === 'regions'
            ? AbortSignal.any(
                [signal, AbortSignal.timeout(settings.timeoutSeconds * 1000)].filter(Boolean),
              )
            : signal;
        const preprocessingStarted = performance.now();
        const processed =
          config.profile === 'legacy'
            ? {
                buffer: page.rotation_degrees
                  ? await sharp(buffer).rotate(page.rotation_degrees).png().toBuffer()
                  : buffer,
                transform: { rotation: page.rotation_degrees },
              }
            : await preprocessOcr(buffer, page.rotation_degrees, config, pageSignal);
        let input = processed.buffer;
        const metadata = await sharp(input).metadata();
        const layout =
          config.layout === 'regions'
            ? await ocrRegions(input, pageSignal)
            : {
                regions: [
                  { x: 0, y: 0, width: metadata.width, height: metadata.height, kind: 'page' },
                ],
                ignored: [],
                fallback: false,
              };
        if (layout.ignored.length)
          input = await sharp(input)
            .composite(
              layout.ignored.map((box) => ({
                input: {
                  create: {
                    width: box.width,
                    height: box.height,
                    channels: 3,
                    background: '#ffffff',
                  },
                },
                left: box.x,
                top: box.y,
              })),
            )
            .png()
            .toBuffer();
        const preprocessingMs = Math.round(performance.now() - preprocessingStarted);
        const results = [];
        const lines = [];
        const pad = config.layout === 'regions' ? 12 : 0;
        for (const [index, region] of layout.regions.entries()) {
          pageSignal?.throwIfAborted();
          const crop = pad
            ? await sharp(input)
                .extract({
                  left: region.x,
                  top: region.y,
                  width: region.width,
                  height: region.height,
                })
                .extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' })
                .withMetadata({ density: 300 })
                .png()
                .toBuffer()
            : input;
          const checksum = digest(crop),
            name = `region-${index}.png`;
          await writeFile(path.join(directory, name), crop, { flag: 'wx', mode: 0o600 });
          const image = `${bridge.ocrWindowsRoot}\\${path.basename(directory)}\\${name}`;
          const result = await bridge.ocr(image, checksum, language, {
            ...engineOptions(config),
            signal: pageSignal,
          });
          const info = validate(result, language, config);
          if (
            result.imageSha256 !== checksum ||
            typeof result.text !== 'string' ||
            !Array.isArray(result.structuredResult?.lines) ||
            !Number.isSafeInteger(result.processingMs) ||
            result.processingMs < 0
          )
            throw failure('ocr_protocol', 'OCR helper returned an invalid page result.', 503);
          if (
            results.length &&
            JSON.stringify(result.configuration) !== JSON.stringify(results[0].configuration)
          )
            throw failure(
              'ocr_configuration_changed',
              'OCR resources changed between regions; the partial page was not saved.',
              409,
            );
          const bounds = (box) => ({
            ...box,
            x: box.x + region.x - pad,
            y: box.y + region.y - pad,
          });
          for (const line of result.structuredResult.lines)
            lines.push({
              ...line,
              bounds: bounds(line.bounds),
              words: (line.words || []).map((word) => ({ ...word, bounds: bounds(word.bounds) })),
            });
          results.push({ ...result, info });
        }
        const result = results[0];
        if (config.version >= 2)
          result.info.configuration = {
            ...result.info.configuration,
            pipelineSha256: await fingerprint(),
          };
        const runtime = {
          preprocessingMs,
          engineMs: results.reduce((sum, item) => sum + item.processingMs, 0),
          tesseractPeakWorkingSetBytes:
            Math.max(0, ...results.map((item) => item.peakWorkingSetBytes || 0)) || null,
          nodeRssBeforeBytes: rssBefore,
          nodeRssAfterBytes: process.memoryUsage().rss,
        };
        return {
          ...result.info,
          text:
            config.layout === 'regions' ? lines.map((line) => line.text).join('\n') : result.text,
          structuredResult: {
            ...result.structuredResult,
            pageBounds: { x: 0, y: 0, width: metadata.width, height: metadata.height },
            lines,
            transform: processed.transform,
            runtime,
            ...(config.layout === 'regions'
              ? {
                  regions: layout.regions,
                  ignoredGraphics: layout.ignored,
                  layoutFallback: layout.fallback,
                  layoutFallbackReason: layout.reason,
                }
              : {}),
          },
          processingMs: Math.round(performance.now() - started),
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
