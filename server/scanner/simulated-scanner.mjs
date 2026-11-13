import { mkdir, readdir, link, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { safePath, openSafe } from '../storage.mjs';
import { failure } from '../errors.mjs';

export const scenarios = [
  { id: 'single', name: 'Normal Document', folder: 'basic', limit: 1 },
  { id: 'multi', name: 'Multi-page Feeder', folder: 'basic' },
  { id: 'duplex', name: 'Duplex Document', folder: 'duplex' },
  { id: 'blank', name: 'Mostly Blank Pages', folder: 'edge-cases' },
  { id: 'jam', name: 'Paper Jam After Page 2', folder: 'basic', failAfter: 2 },
  { id: 'empty', name: 'Empty Feeder', folder: 'basic', empty: true },
  { id: 'error', name: 'Scanner Error', folder: 'basic', error: true },
];

export function simulatedScanner({
  scans,
  fixtures = path.resolve('fixtures'),
  customFixtures,
  delay = sleep,
}) {
  return {
    scans,
    async inspect() {
      return {
        state: 'simulator_ready',
        canScan: true,
        helperAvailable: false,
        message: 'Simulation only. No physical scanner or Windows helper is used.',
        devices: [{ id: 'virtual', name: 'DigitalArch Virtual Scanner', driver: 'Simulator' }],
        profiles: [
          { id: 'simulator', name: 'Local test documents', source: 'simulator', compatible: true },
        ],
        device: { id: 'virtual', name: 'DigitalArch Virtual Scanner', driver: 'Simulator' },
        profileId: 'simulator',
        scenarios: scenarios.map(({ id, name }) => ({ id, name })),
      };
    },
    validate(options) {
      if (!scenarios.some((s) => s.id === options.scenario))
        throw failure('invalid_scenario', 'Choose a listed simulation scenario.');
      if (
        !Number.isInteger(options.pageDelay) ||
        options.pageDelay < 0 ||
        options.pageDelay > 10000
      )
        throw failure(
          'invalid_delay',
          'Page delay must be an integer from 0 to 10000 milliseconds.',
        );
      for (const key of Object.keys(options))
        if (!['scenario', 'pageDelay'].includes(key))
          throw failure('invalid_options', 'Unsupported simulation option.');
    },
    async scan(job, options) {
      const scenario = scenarios.find((s) => s.id === options.scenario);
      if (scenario.empty)
        throw failure(
          'empty_feeder',
          'The simulated feeder is empty. Choose another scenario and try again.',
        );
      if (scenario.error)
        throw failure(
          'driver_error',
          'Simulated scanner error. Choose another scenario and try again.',
        );
      // Custom images are an operator-configured flat PNG directory, never a browser-provided path.
      const directory = customFixtures || (await safePath(fixtures, scenario.folder));
      const entries = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.png$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      const files = scenario.limit ? entries.slice(0, scenario.limit) : entries;
      if (!files.length)
        throw failure(
          'fixtures_unavailable',
          'No PNG fixtures found in the configured fixture directory.',
        );
      if (scenario.failAfter && files.length < scenario.failAfter)
        throw failure(
          'fixtures_unavailable',
          'The paper-jam scenario needs at least two fixture pages.',
        );
      await mkdir(scans, { recursive: true });
      job.totalPages = scenario.failAfter || files.length;
      for (let i = 0; i < files.length; i++) {
        await delay(options.pageDelay);
        const source = await openSafe(directory, files[i]);
        const target = path.join(scans, `${job.id}-${String(i + 1).padStart(3, '0')}.png`);
        const temporary = target + '.partial';
        try {
          const signature = Buffer.alloc(8);
          await source.read(signature, 0, 8, 0);
          if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            throw failure(
              'fixtures_unavailable',
              'A configured fixture is not a PNG image. Check the fixture files.',
            );
          await pipeline(
            source.createReadStream({ start: 0, autoClose: false }),
            createWriteStream(temporary, { flags: 'wx' }),
          );
        } finally {
          await source.close();
        }
        // link is atomic and refuses an existing target (rename would overwrite it).
        await link(temporary, target);
        await unlink(temporary);
        if (scenario.failAfter === i + 1)
          throw failure(
            'paper_jam',
            'Simulated paper jam after page 2. Captured pages are retained.',
          );
      }
    },
  };
}
