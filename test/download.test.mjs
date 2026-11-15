import test from 'node:test';
import assert from 'node:assert/strict';
import { receivePdf, stagePdf } from '../src/downloadPdf.js';

const headers = (total) => ({
  'Content-Type': 'application/vnd.digitalarch.transfer',
  'X-Document-Bytes': String(total),
});
const packet = (value) => JSON.stringify({ data: Buffer.from(value).toString('base64') }) + '\n';

test('PDF transfer: stream progress, exact byte count and direct file completion', async () => {
  const input = new TextEncoder().encode('%PDF-test');
  const progress = [],
    written = [];
  let closed = false;
  const encoded = new TextEncoder().encode(packet(input.slice(0, 4)) + packet(input.slice(4)));
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: headers(input.length) },
  );
  const result = await receivePdf(response, {
    writer: {
      write(chunk) {
        written.push(...chunk);
      },
      close() {
        closed = true;
      },
      abort() {
        throw new Error('Unexpected abort');
      },
    },
    onProgress: (value) => progress.push(value.bytes),
  });
  assert.equal(result.bytes, input.length);
  assert.equal(result.blob, null);
  assert.equal(closed, true);
  assert.deepEqual(progress, [4, input.length]);
  assert.deepEqual(written, [...input]);
});

test('PDF transfer: buffered fallback and incomplete/oversized transfers fail safely', async () => {
  const result = await receivePdf(new Response(packet('%PDF-test'), { headers: headers(9) }));
  assert.equal(await result.blob.text(), '%PDF-test');
  await assert.rejects(
    receivePdf(new Response(packet('%PDF-short'), { headers: headers(100) })),
    /incomplete/,
  );
  await assert.rejects(
    receivePdf(new Response(packet('%PDF-test').slice(0, -1), { headers: headers(9) })),
    /incomplete/,
  );
  await assert.rejects(
    receivePdf(new Response('{"data":"not-base64!"}\n', { headers: headers(9) })),
    /Invalid/,
  );
  await assert.rejects(
    receivePdf(new Response(packet('%PDF-test'), { headers: headers(8) })),
    /byte count/,
  );
  await assert.rejects(
    receivePdf(new Response(packet('%PDF-test'), { headers: headers(0) })),
    /byte count/,
  );
  await assert.rejects(
    receivePdf(new Response('', { headers: headers(257 * 1024 * 1024) })),
    /Chrome or Edge/,
  );
  await assert.rejects(
    receivePdf(new Response('{}', { headers: { 'Content-Type': 'application/json' } })),
    /unavailable/,
  );
});

test('PDF transfer: private staging completes before saving, cleans only owned stale files and supports bounded fallback', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  });
  const removed = [];
  const written = [];
  let closed = false;
  const writer = {
    async write(bytes) {
      written.push(...bytes);
    },
    async close() {
      closed = true;
    },
    async abort() {},
  };
  const directory = {
    async *entries() {
      yield [
        'download-aaaa.pdf',
        { kind: 'file', getFile: async () => ({ lastModified: Date.now() - 25 * 60 * 60_000 }) },
      ];
      yield [
        'download-bbbb.pdf',
        { kind: 'file', getFile: async () => ({ lastModified: Date.now() }) },
      ];
      yield [
        'unrelated.pdf',
        {
          kind: 'file',
          getFile: () => {
            throw new Error('Unrelated files must not be read');
          },
        },
      ];
    },
    async getFileHandle(name) {
      assert.match(name, /^download-[a-f0-9-]+\.pdf$/);
      return {
        createWritable: async () => writer,
        getFile: async () => {
          assert.equal(closed, true);
          return new Blob([new Uint8Array(written)], { type: 'application/pdf' });
        },
      };
    },
    async removeEntry(name) {
      removed.push(name);
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async (name) => {
            assert.equal(name, 'digitalarch-viewer-downloads');
            return directory;
          },
        }),
      },
    },
  });
  const staged = await stagePdf();
  const result = await receivePdf(new Response(packet('%PDF-test'), { headers: headers(9) }), {
    writer: staged.writer,
  });
  assert.equal(result.blob, null);
  assert.equal(await (await staged.file()).text(), '%PDF-test');
  assert.deepEqual(removed, ['download-aaaa.pdf']);
  await staged.dispose();
  assert.equal(removed.length, 2);
  assert.ok(!removed.includes('download-bbbb.pdf'));
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: {} } });
  assert.equal((await stagePdf()).writer, null);
});
