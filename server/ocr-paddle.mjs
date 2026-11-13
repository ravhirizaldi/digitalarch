import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { digest } from './auth.mjs';
import { failure } from './errors.mjs';
import { preprocessOcr } from './ocr-preprocess.mjs';

export const paddleModel = 'PP-OCRv6 Small';
export const paddleEngine = 'PaddleOCR';
const runner = new URL('../scripts/paddle/recognize.py', import.meta.url);

function invoke(python, args, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(python, [runner.pathname, ...args], {
      signal,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '',
      spawnError;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) child.kill('SIGKILL');
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code) => {
      if (signal?.aborted) return reject(signal.reason);
      if (spawnError)
        return reject(
          failure(
            'ocr_unavailable',
            'PaddleOCR CPU runtime unavailable. Run pnpm ocr:paddle:setup and check OCR_PADDLE_PYTHON.',
            503,
          ),
        );
      code === 0
        ? resolve(stdout)
        : reject(
            failure(
              'ocr_failed',
              'PaddleOCR CPU process failed or timed out. Verify the pinned runtime and local Small models.',
              503,
            ),
          );
    });
  });
}

export function normalizePaddle(value, width, height) {
  if (
    !value ||
    !Array.isArray(value.texts) ||
    value.texts.length > 10000 ||
    !Array.isArray(value.polygons) ||
    !Array.isArray(value.scores) ||
    value.texts.length !== value.polygons.length ||
    value.texts.length !== value.scores.length
  )
    throw failure('ocr_protocol', 'Invalid PaddleOCR result.', 503);
  const lines = value.texts.map((text, index) => {
    const polygon = value.polygons[index];
    const confidence = value.scores[index];
    if (
      typeof text !== 'string' ||
      text.length > 100000 ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      !Array.isArray(polygon) ||
      polygon.length !== 4 ||
      !polygon.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
    )
      throw failure('ocr_protocol', 'Invalid PaddleOCR text geometry.', 503);
    const left = Math.max(0, Math.min(width, Math.floor(Math.min(...polygon.map((p) => p[0])))));
    const top = Math.max(0, Math.min(height, Math.floor(Math.min(...polygon.map((p) => p[1])))));
    const right = Math.max(left, Math.min(width, Math.ceil(Math.max(...polygon.map((p) => p[0])))));
    const bottom = Math.max(
      top,
      Math.min(height, Math.ceil(Math.max(...polygon.map((p) => p[1])))),
    );
    return {
      text,
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
      polygon,
      confidence,
      words: [],
    };
  });
  return { text: lines.map((line) => line.text).join('\n'), lines };
}

export function paddleOcrProvider(settings) {
  const home = path.resolve('.local/paddleocr');
  // shortcut: forced termination can leave private page-* derivatives; add age-gated cleanup if they accumulate.
  const python = settings.paddlePython || path.join(home, 'venv/bin/python');
  const models = path.resolve(settings.paddleModels || path.join(home, 'models'));
  const deadline = (signal) =>
    AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutSeconds * 1000)].filter(Boolean));
  async function info(language, signal, config) {
    if (
      !['ind', 'eng', 'ind+eng', 'eng+ind'].includes(language) ||
      config.engine !== 'paddleocr' ||
      config.model !== paddleModel ||
      ![1, 2, 4].includes(config.cpuThreads ?? 1)
    )
      throw failure('ocr_configuration_changed', 'Unsupported PaddleOCR model or language.', 409);
    try {
      const files = {};
      for (const name of ['PP-OCRv6_small_det', 'PP-OCRv6_small_rec'])
        for (const file of ['inference.json', 'inference.pdiparams', 'inference.yml'])
          files[`${name}/${file}`] = digest(
            await readFile(path.join(models, `${name}_infer`, file)),
          );
      const packages = JSON.parse(await invoke(python, ['--info'], deadline(signal)));
      if (
        packages.paddleocr !== '3.7.0' ||
        packages.paddlepaddle !== '3.3.1' ||
        packages.paddlex !== '3.7.2'
      )
        throw failure(
          'ocr_unavailable',
          'PaddleOCR runtime versions differ from the verified installation.',
          503,
        );
      const source = await Promise.all(
        [
          runner,
          new URL('./ocr-paddle.mjs', import.meta.url),
          new URL('./ocr-preprocess.mjs', import.meta.url),
          new URL('./ocr-pixels.mjs', import.meta.url),
          new URL('./ocr-layout.mjs', import.meta.url),
        ].map((file) => readFile(file)),
      );
      return {
        engine: paddleEngine,
        engineVersion: packages.paddleocr,
        configuration: {
          processing: config,
          model: paddleModel,
          packages,
          modelSha256: files,
          pipelineSha256: digest(Buffer.concat(source)),
          device: 'cpu',
          cpuThreads: config.cpuThreads ?? 1,
          mkldnn: false,
          recognitionBatchSize: 1,
          detectionMaxSide: 1280,
          orientation: false,
          unwarping: false,
          sharp: sharp.versions.sharp,
          vips: sharp.versions.vips,
        },
      };
    } catch (error) {
      if (error.code === 'ENOENT')
        throw failure(
          'ocr_unavailable',
          'PaddleOCR Small models are missing. Run pnpm ocr:paddle:setup.',
          503,
        );
      throw error;
    }
  }
  return {
    info,
    async process(buffer, page, language, signal, config) {
      const started = performance.now();
      const pageSignal = deadline(signal);
      const identity = await info(language, pageSignal, config);
      await mkdir(home, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(path.join(home, 'page-'));
      try {
        const processed = await preprocessOcr(buffer, page.rotation_degrees, config, pageSignal);
        const { width, height } = await sharp(processed.buffer).metadata();
        const input = path.join(directory, 'input.png'),
          output = path.join(directory, 'result.json');
        await writeFile(input, processed.buffer, { mode: 0o600 });
        await invoke(
          python,
          [input, models, output, String(settings.timeoutSeconds), String(config.cpuThreads ?? 1)],
          pageSignal,
        );
        if ((await stat(output)).size > 16_000_000)
          throw failure('ocr_protocol', 'PaddleOCR result exceeds the page limit.', 503);
        const value = JSON.parse(await readFile(output, 'utf8'));
        if (
          !Number.isSafeInteger(value.peakWorkingSetBytes) ||
          value.peakWorkingSetBytes <= 0 ||
          !Number.isSafeInteger(value.inferenceAndLoadMs) ||
          value.inferenceAndLoadMs < 0
        )
          throw failure('ocr_protocol', 'Invalid PaddleOCR processing metadata.', 503);
        const normalized = normalizePaddle(value, width, height);
        if (JSON.stringify(identity) !== JSON.stringify(await info(language, pageSignal, config)))
          throw failure(
            'ocr_configuration_changed',
            'PaddleOCR resources changed during recognition. Reprocess with a stable installation.',
            409,
          );
        return {
          ...identity,
          text: normalized.text,
          processingMs: Math.round(performance.now() - started),
          structuredResult: {
            pageBounds: { x: 0, y: 0, width, height },
            lines: normalized.lines,
            transform: processed.transform,
            runtime: {
              enginePeakWorkingSetBytes: value.peakWorkingSetBytes,
              inferenceAndLoadMs: value.inferenceAndLoadMs,
              memoryMeasurement:
                'Linux child process ru_maxrss; includes imports/model load; excludes Node parent',
              coldStart: true,
            },
            wordBoundsAvailable: false,
          },
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
