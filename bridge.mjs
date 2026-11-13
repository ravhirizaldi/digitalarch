import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { failure } from './server/errors.mjs';

const exec = promisify(execFile);
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const helperFiles = [
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
];

export async function helperIsCurrent(directory, fingerprint) {
  try {
    if ((await readFile(path.join(directory, '.source-version'), 'utf8')) !== fingerprint)
      return false;
    const files = await Promise.all(helperFiles.map((file) => stat(path.join(directory, file))));
    return files.every((file) => file.isFile() && file.size > 0);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Preparation builds/copies files only; scanner discovery requires an explicit invoke.
export async function prepareScanner() {
  let windowsRoot;
  let root;
  try {
    const { stdout } = await exec(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', '$env:LOCALAPPDATA'],
      { timeout: 15000 },
    );
    windowsRoot = `${stdout.trim()}\\DigitalArch`;
    const { stdout: linuxPath } = await exec('wslpath', ['-u', windowsRoot], { timeout: 5000 });
    root = linuxPath.trim();
    const inputs = await Promise.all(
      [
        'DigitalArch.Service/Program.cs',
        'DigitalArch.Service/Profiles.cs',
        'DigitalArch.Service/Ocr.cs',
        'DigitalArch.Ocr/DigitalArch.Ocr.csproj',
        'DigitalArch.Ocr/Program.cs',
        'DigitalArch.Service/DigitalArch.Service.csproj',
        'server/windows-helper.ps1',
        'bridge.mjs',
      ].map((file) => readFile(file, 'utf8')),
    );
    const fingerprint = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
    const directory = path.join(root, 'DigitalArch.Service');
    if (!(await helperIsCurrent(directory, fingerprint))) {
      await rm(path.join(directory, '.source-version'), { force: true });
      await exec(
        'dotnet',
        ['build', 'DigitalArch.Service/DigitalArch.Service.csproj', '-c', 'Release', '--nologo'],
        {
          timeout: 120000,
        },
      );
      await exec(
        'dotnet',
        ['build', 'DigitalArch.Ocr/DigitalArch.Ocr.csproj', '-c', 'Release', '--nologo'],
        {
          timeout: 120000,
        },
      );
      await mkdir(directory, { recursive: true });
      await cp('DigitalArch.Service/bin/Release/net8.0-windows', directory, { recursive: true });
      await cp('DigitalArch.Ocr/bin/Release/net8.0/win-x64', directory, { recursive: true });
      await cp('server/windows-helper.ps1', path.join(directory, 'windows-helper.ps1'));
      await writeFile(path.join(directory, '.source-version'), fingerprint);
    }
    await mkdir(path.join(root, 'scans'), { recursive: true });
  } catch (error) {
    console.error('Scanner helper preparation:', error.message);
    throw failure(
      'helper_unavailable',
      'Windows scanner helper unavailable. Check WSL interoperability, WSL .NET SDK and Windows .NET 8 Desktop runtime.',
    );
  }
  async function invoke(args, timeout = 30000, signal) {
    const cancellation = `ocr-cancel-${randomUUID()}`;
    const cancelFile = path.join(root, cancellation);
    let cancellationWrite;
    const cancel = () => (cancellationWrite = writeFile(cancelFile, '').catch(() => {}));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) await cancel();
    const request = Buffer.from(
      JSON.stringify({ args, timeoutMs: timeout, cancelFile: `${windowsRoot}\\${cancellation}` }),
    ).toString('base64');
    const command = `& ${quote(`${windowsRoot}\\DigitalArch.Service\\windows-helper.ps1`)} -RequestBase64 ${quote(request)}`;
    let output;
    let processError;
    try {
      output = await exec(
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { timeout: timeout + 10000, maxBuffer: 2 * 1024 * 1024 },
      );
    } catch (error) {
      output = error;
      processError = error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      await cancellationWrite;
      await rm(cancelFile, { force: true });
    }
    if (processError?.killed)
      throw failure(
        'timeout',
        'Scanner helper timed out. Check the scanner before retrying. Saved pages are retained.',
      );
    let messages;
    try {
      messages = output.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      console.error('Helper did not return JSON:', output.stderr);
      await rm(path.join(root, 'DigitalArch.Service', '.source-version'), { force: true });
      throw failure(
        'helper_unavailable',
        'Windows scanner helper did not return valid JSON. Check the Windows .NET 8 Desktop runtime.',
      );
    }
    const result = messages.at(-1);
    if (result?.success === false) {
      if (result.error.code === 'helper_unavailable')
        await rm(path.join(root, 'DigitalArch.Service', '.source-version'), { force: true });
      throw failure(result.error.code, result.error.message);
    }
    if (processError || result?.success !== true) {
      console.error('Unexpected helper exit:', output.stderr);
      await rm(path.join(root, 'DigitalArch.Service', '.source-version'), { force: true });
      throw failure(
        'helper_unavailable',
        'Unexpected Windows scanner helper exit. Saved pages are retained.',
      );
    }
    return result;
  }
  return {
    scans: path.join(root, 'scans'),
    ocrRoot: path.join(root, 'ocr-temp'),
    ocrWindowsRoot: `${windowsRoot}\\ocr-temp`,
    ocrInfo: (language, options = {}) =>
      invoke(['--ocr-info', '--language', language, ...ocrOptions(options)], 30000, options.signal),
    ocr: (imagePath, checksum, language, options = {}) =>
      invoke(
        [
          '--ocr',
          '--image',
          imagePath,
          '--sha256',
          checksum,
          '--language',
          language,
          '--timeout-seconds',
          String(options.timeoutSeconds || 120),
          '--priority',
          'low',
          ...ocrOptions(options),
        ],
        (options.timeoutSeconds || 120) * 1000 + 15000,
        options.signal,
      ),
    inspect: (profileId, deviceId) =>
      invoke([
        '--inspect',
        '--profile',
        profileId,
        ...(deviceId ? ['--device', deviceId] : []),
        ...(process.env.DIGITALARCH_NAPS2_PROFILES
          ? ['--profile-file', process.env.DIGITALARCH_NAPS2_PROFILES]
          : []),
      ]),
    devices: () => invoke(['--devices']),
    profiles: () =>
      invoke([
        '--profiles',
        ...(process.env.DIGITALARCH_NAPS2_PROFILES
          ? ['--profile-file', process.env.DIGITALARCH_NAPS2_PROFILES]
          : []),
      ]),
    probe: (profileId, deviceId) =>
      invoke([
        '--probe',
        '--profile',
        profileId,
        '--device',
        deviceId,
        ...(process.env.DIGITALARCH_NAPS2_PROFILES
          ? ['--profile-file', process.env.DIGITALARCH_NAPS2_PROFILES]
          : []),
      ]),
    scan: (id, { profileId = 'digitalarch-default', deviceId } = {}) =>
      invoke(
        [
          '--scan',
          '--output',
          `${windowsRoot}\\scans\\${id}.png`,
          '--profile',
          profileId,
          ...(deviceId ? ['--device', deviceId] : []),
          ...(process.env.DIGITALARCH_NAPS2_PROFILES
            ? ['--profile-file', process.env.DIGITALARCH_NAPS2_PROFILES]
            : []),
        ],
        10 * 60 * 1000,
      ),
  };
}

function ocrOptions(options) {
  return [
    ...(options.quality ? ['--quality', options.quality] : []),
    ...(options.psm ? ['--psm', String(options.psm)] : []),
    ...(options.tesseract ? ['--tesseract', options.tesseract] : []),
    ...(options.tessdata ? ['--tessdata', options.tessdata] : []),
  ];
}
