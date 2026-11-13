import { constants } from 'node:fs';
import { open, readdir, lstat, realpath, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const pageName = /^scan-[a-zA-Z0-9-]+-\d{3,}\.png$/;
export const jobName = /^scan-\d+-[a-f0-9-]{36}$/;

// Reject symlinks in every component, not only the last filename.
export async function safePath(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (!target.startsWith(base + path.sep))
    throw Object.assign(new Error('Unsafe file'), { code: 'ENOENT' });
  let current = base;
  for (const component of path.relative(base, target).split(path.sep)) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink())
      throw Object.assign(new Error('Unsafe file'), { code: 'ENOENT' });
  }
  if (!(await realpath(target)).startsWith((await realpath(base)) + path.sep))
    throw Object.assign(new Error('Unsafe file'), { code: 'ENOENT' });
  return target;
}

export async function openSafe(root, relative) {
  const file = await safePath(root, relative);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
  }
  return handle;
}

export async function listPages(root, provider, jobId) {
  if (!root) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const names = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        pageName.test(entry.name) &&
        (!jobId || entry.name.replace(/-\d+\.png$/, '') === jobId),
    )
    .map((entry) => entry.name);
  names.sort((a, b) => {
    const [, batchA, numberA] = a.match(/^(.*)-(\d+)\.png$/);
    const [, batchB, numberB] = b.match(/^(.*)-(\d+)\.png$/);
    return batchB.localeCompare(batchA) || Number(numberA) - Number(numberB);
  });
  return names.map((filename) => ({
    id: `${provider}:${filename}`,
    jobId: filename.replace(/-\d+\.png$/, ''),
    provider,
    pageNumber: Number(filename.match(/-(\d+)\.png$/)[1]),
    filename,
    mimeType: 'image/png',
  }));
}

export async function writeJson(directory, name, value) {
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${name}.${randomUUID()}.partial`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path.join(directory, name));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
