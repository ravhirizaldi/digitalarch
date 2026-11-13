import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpApp } from './server/http.mjs';
import { scannerService } from './server/scanner/scanner-service.mjs';
import { simulatedScanner } from './server/scanner/simulated-scanner.mjs';
import { realScanner } from './server/scanner/real-scanner.mjs';
import { prepareScanner } from './bridge.mjs';
import { enterprise } from './server/enterprise.mjs';

export function createApp({ service, publicDir } = {}) {
  return createHttpApp(service, publicDir);
}

// Provider construction is also used directly by hardware-free scanner tests.
export async function createService({
  dataDir = path.resolve(process.env.DIGITALARCH_DATA_DIR || '.local'),
  prepare = prepareScanner,
  customFixtures = process.env.DIGITALARCH_FIXTURES,
} = {}) {
  const service = scannerService({
    dataDir,
    providers: {
      simulator: simulatedScanner({ scans: path.join(dataDir, 'capture-spool'), customFixtures }),
      real: realScanner({ prepare }),
    },
  });
  service.dataDir = dataDir;
  await service.initialize();
  return service;
}

export async function createRuntimeService(options = {}) {
  const service = await createService(options);
  service.application = enterprise({
    scanner: service,
    dataDir: service.dataDir,
    pool: options.pool,
    storageRoot: options.storageRoot,
    ocr: options.ocr,
  });
  await service.application.start();
  return service;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createRuntimeService();
  const server = createApp({ service });
  server.listen(3000, '127.0.0.1', () => console.log('DigitalArch · http://localhost:3000'));
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, async () => {
      server.closeAllConnections();
      server.close();
      await service.application.close();
      process.exit(0);
    });
}
