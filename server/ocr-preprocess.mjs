import { Worker } from 'node:worker_threads';
import sharp from 'sharp';

export async function ocrPixels(operation, buffer, signal) {
  const { data, info } = await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ocr-pixels.mjs', import.meta.url), {
      workerData: { operation, pixels: data, width: info.width, height: info.height },
    });
    const abort = () => {
      worker.terminate();
      reject(new Error('OCR preprocessing stopped.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once('message', (value) => resolve({ value, width: info.width, height: info.height }));
    worker.once('error', reject);
    worker.once('exit', () => signal?.removeEventListener('abort', abort));
  });
}

export async function preprocessOcr(buffer, rotation, config, signal) {
  const steps = config.preprocessing || {};
  let input = rotation ? await sharp(buffer).rotate(rotation).png().toBuffer() : buffer;
  let angle = 0;
  if (steps.deskew) {
    const preview = await sharp(input)
      .resize({ width: 1000, height: 1400, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    angle = (await ocrPixels('deskew', preview, signal)).value;
    if (angle) input = await sharp(input).rotate(angle, { background: '#ffffff' }).png().toBuffer();
  }
  let image = sharp(input);
  let lineRemoval;
  if (steps.lineRemoval) {
    const { value, width, height } = await ocrPixels('lines', input, signal);
    lineRemoval = { removedPixels: value.removedPixels, lines: value.lines };
    image = sharp(Buffer.from(value.pixels), { raw: { width, height, channels: 1 } });
  }
  if (steps.grayscale || steps.adaptiveThreshold) image = image.grayscale();
  if (steps.contrast) image = image.normalise({ lower: 1, upper: 99 });
  if (steps.denoise) image = image.median(3);
  input = await image.withMetadata({ density: 300 }).png().toBuffer();
  if (steps.adaptiveThreshold) {
    const { value, width, height } = await ocrPixels('threshold', input, signal);
    input = await sharp(Buffer.from(value), { raw: { width, height, channels: 1 } })
      .withMetadata({ density: 300 })
      .png()
      .toBuffer();
  }
  return {
    buffer: input,
    transform: {
      rotation,
      deskewDegrees: angle,
      coordinateSystem: 'ocr-input-pixels',
      ...(lineRemoval ? { lineRemoval } : {}),
    },
  };
}
