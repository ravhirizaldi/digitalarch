import path from 'node:path';
import sharp from 'sharp';
import { mkdir, writeFile, link, unlink, open as openFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openSafe } from './storage.mjs';
import { digest, uuid } from './auth.mjs';
import { failure } from './errors.mjs';

export function captureStorage(root) {
  root = path.resolve(root);
  let queue = Promise.resolve();
  let closed = false;
  const pending = new Map();
  const serial = (operation) => {
    if (closed)
      return Promise.reject(
        failure('storage_closed', 'Storage is closing; captured source files are retained.', 503),
      );
    const work = queue.then(operation);
    queue = work.catch(() => {});
    return work;
  };
  const image = (buffer) => sharp(buffer, { limitInputPixels: 100_000_000, failOn: 'warning' });
  const keyPattern = /^batches\/[a-f0-9-]{36}\/sessions\/[a-f0-9-]{36}\/page-\d{4,}\.png$/;
  async function open(key) {
    if (typeof key !== 'string' || !keyPattern.test(key))
      throw failure('invalid_storage_key', 'Invalid managed storage key.');
    return openSafe(root, key);
  }
  async function inspect(buffer) {
    if (!buffer.length || buffer.length > 200 * 1024 * 1024)
      throw failure('invalid_image', 'Captured image is empty or exceeds 200 MB.', 422);
    try {
      const info = await image(buffer).metadata();
      if (info.format !== 'png' || !info.width || !info.height) throw new Error();
      await image(buffer).resize(1, 1).png().toBuffer();
      return {
        sha256: digest(buffer),
        byteSize: buffer.length,
        width: info.width,
        height: info.height,
        dpi: info.density || null,
      };
    } catch {
      throw failure(
        'invalid_image',
        'Captured image could not be decoded. Its source file is retained.',
        422,
      );
    }
  }
  async function read(handle) {
    try {
      const size = (await handle.stat()).size;
      if (size > 200 * 1024 * 1024)
        throw failure('invalid_image', 'Captured image exceeds 200 MB.', 422);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  return {
    root,
    open,
    async close() {
      closed = true;
      await Promise.allSettled([...pending.values()]);
      await queue;
    },
    async ocrImage(page) {
      const buffer = await read(await open(page.storage_key));
      const info = await inspect(buffer);
      if (info.sha256 !== page.image_sha256)
        throw failure(
          'image_changed',
          'Queued OCR image checksum does not match managed storage.',
          422,
        );
      return buffer;
    },
    finalize(session, number, sourceRoot, filename) {
      return serial(async () => {
        uuid(session.batch_id);
        uuid(session.id);
        const key = `batches/${session.batch_id}/sessions/${session.id}/page-${String(number).padStart(4, '0')}.png`;
        const buffer = await read(await openSafe(sourceRoot, filename));
        const info = await inspect(buffer);
        try {
          const existing = await read(await open(key));
          if (digest(existing) !== info.sha256)
            throw failure(
              'image_conflict',
              'Managed original differs from captured source. Both files are retained.',
              409,
            );
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await mkdir(path.join(root, path.dirname(key)), { recursive: true });
          const temporary = path.join(root, `${key}.${randomUUID()}.partial`);
          try {
            // Keep provider output as a recovery spool; finalization never overwrites an original.
            const handle = await openFile(temporary, 'wx', 0o400);
            try {
              await handle.writeFile(buffer);
              await handle.sync();
            } finally {
              await handle.close();
            }
            await link(temporary, path.join(root, key));
          } finally {
            await unlink(temporary).catch(() => {});
          }
        }
        return { key, ...info };
      });
    },
    validate(page) {
      return serial(async () => {
        const buffer = await read(await open(page.original_storage_key));
        const info = await inspect(buffer);
        if (info.sha256 !== page.sha256)
          throw failure(
            'image_changed',
            'An original image changed outside DigitalArch. Restore the original before completing capture.',
            422,
          );
      });
    },
    async derivative(page, size) {
      const key = page.active_storage_key;
      const source = await open(key);
      let info;
      try {
        info = await source.stat();
      } finally {
        await source.close();
      }
      const cacheKey = `${digest(`${key}:${info.size}:${info.mtimeMs}:${size}`)}.webp`;
      const cache = path.join(root, 'previews');
      try {
        return await openSafe(cache, cacheKey);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!pending.has(cacheKey)) {
        const work = serial(async () => {
          const buffer = await read(await open(key));
          const output = await image(buffer)
            .resize({
              width: size === 'thumbnail' ? 320 : 1400,
              height: size === 'thumbnail' ? 420 : 1800,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .webp({ quality: 85 })
            .toBuffer();
          await mkdir(cache, { recursive: true });
          const temporary = path.join(cache, `${cacheKey}.${randomUUID()}.partial`);
          try {
            await writeFile(temporary, output, { flag: 'wx', mode: 0o600 });
            await link(temporary, path.join(cache, cacheKey)).catch((error) => {
              if (error.code !== 'EEXIST') throw error;
            });
          } finally {
            await unlink(temporary).catch(() => {});
          }
        });
        pending.set(cacheKey, work);
        work.finally(() => pending.delete(cacheKey)).catch(() => {});
      }
      await pending.get(cacheKey);
      return openSafe(cache, cacheKey);
    },
  };
}
