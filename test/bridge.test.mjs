import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { helperIsCurrent } from '../bridge.mjs';

test('helper setup cache requires matching sources and installed runtime files', async (t) => {
  const root = await mkdtemp('/tmp/opencode/digitalarch-helper-');
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await helperIsCurrent(root, 'version-one'), false);
  await writeFile(path.join(root, '.source-version'), 'version-one');
  assert.equal(
    await helperIsCurrent(root, 'version-one'),
    false,
    'An incomplete setup cannot skip installation',
  );
  for (const file of [
    'DigitalArch.Service.dll',
    'DigitalArch.Service.deps.json',
    'DigitalArch.Service.runtimeconfig.json',
    'NAPS2.Sdk.dll',
    'NAPS2.Wia.dll',
    'NAPS2.Images.dll',
    'NAPS2.Images.Gdi.dll',
    'windows-helper.ps1',
    'DigitalArch.Ocr.exe',
    'DigitalArch.Ocr.dll',
    'DigitalArch.Ocr.runtimeconfig.json',
  ])
    await writeFile(path.join(root, file), 'test');
  assert.equal(await helperIsCurrent(root, 'version-one'), true);
  assert.equal(
    await helperIsCurrent(root, 'version-two'),
    false,
    'Source changes must rebuild and copy the helper',
  );
  await writeFile(path.join(root, 'NAPS2.Wia.dll'), '');
  assert.equal(
    await helperIsCurrent(root, 'version-one'),
    false,
    'An empty dependency must trigger setup again',
  );
  await rm(path.join(root, 'NAPS2.Wia.dll'));
  assert.equal(
    await helperIsCurrent(root, 'version-one'),
    false,
    'A missing dependency must trigger setup again',
  );
});
