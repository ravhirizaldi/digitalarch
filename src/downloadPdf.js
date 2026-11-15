export async function receivePdf(response, { writer, onProgress = () => {} } = {}) {
  if (!response.ok) {
    const result = await response.json();
    if (response.status === 401) window.dispatchEvent(new Event('auth-expired'));
    throw new Error(result.error || 'PDF download failed.');
  }
  if (
    !response.headers.get('content-type')?.startsWith('application/vnd.digitalarch.transfer') ||
    !response.body
  )
    throw new Error('The PDF response is unavailable.');
  const total = Number(response.headers.get('x-document-bytes'));
  if (!Number.isSafeInteger(total) || total <= 0) {
    await response.body.cancel();
    throw new Error('Invalid download byte count.');
  }
  // shortcut: browsers without private file storage buffer up to 256 MB; use Chrome/Edge for larger exports.
  const memoryLimit = 256 * 1024 * 1024;
  if (!writer && total > memoryLimit) {
    await response.body.cancel();
    throw new Error('This PDF needs browser file storage. Download it using Chrome or Edge.');
  }
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0;
  let pending = '';
  const decoder = new TextDecoder();
  const start = performance.now();
  async function packet(line) {
    if (line.length > 128 * 1024) throw new Error('Invalid download packet.');
    const data = JSON.parse(line).data;
    if (
      typeof data !== 'string' ||
      !data.length ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      throw new Error('Invalid download packet.');
    const value = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    if (bytes + value.byteLength > total) throw new Error('Invalid download byte count.');
    if (writer) await writer.write(value);
    else {
      if (bytes + value.byteLength > memoryLimit)
        throw new Error('PDF exceeds this browser’s in-memory download limit. Use Chrome or Edge.');
      chunks.push(value);
    }
    bytes += value.byteLength;
    onProgress({ bytes, total, durationMs: Math.round(performance.now() - start) });
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        await packet(line);
      }
      if (pending.length > 128 * 1024) throw new Error('Invalid download packet.');
    }
    pending += decoder.decode();
    if (pending) throw new Error('The PDF transfer was incomplete. Try again.');
    if (bytes !== total) throw new Error('The PDF transfer was incomplete. Try again.');
    if (writer) await writer.close();
    return {
      bytes,
      durationMs: Math.round(performance.now() - start),
      blob: writer ? null : new Blob(chunks, { type: 'application/pdf' }),
    };
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (writer) await writer.abort().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function stagePdf() {
  let directory, name;
  try {
    const root = await navigator.storage.getDirectory();
    directory = await root.getDirectoryHandle('digitalarch-viewer-downloads', { create: true });
    for await (const [entry, handle] of directory.entries()) {
      if (handle.kind === 'file' && /^download-[a-f0-9-]+\.pdf$/.test(entry)) {
        const file = await handle.getFile();
        // Leave other tabs' long-running transfers alone; clear abandoned cache files after a day.
        if (file.lastModified < Date.now() - 24 * 60 * 60_000) await directory.removeEntry(entry);
      }
    }
    name = `download-${crypto.randomUUID()}.pdf`;
    const handle = await directory.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    return {
      writer,
      file: () => handle.getFile(),
      dispose: () => directory.removeEntry(name),
    };
  } catch {
    if (name) await directory?.removeEntry(name).catch(() => {});
    return { writer: null, dispose: async () => {} };
  }
}
