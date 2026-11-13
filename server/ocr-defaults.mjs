import { availableParallelism, cpus, totalmem } from 'node:os';
import { audit, keys, requirePermission } from './auth.mjs';
import { transaction } from './db.mjs';
import { failure } from './errors.mjs';
import { processingConfig, ocrProfiles } from './ocr-profiles.mjs';

export function ocrDefaults(pool, settings, provider) {
  const maxThreads = Math.min(4, availableParallelism());
  const hardware = {
    cpu: cpus()[0]?.model || 'CPU',
    logicalCpus: cpus().length,
    availableCpus: availableParallelism(),
    paddleThreadOptions: [1, 2, 4].filter((n) => n <= maxThreads),
    totalMemoryBytes: totalmem(),
  };
  async function current(client = pool) {
    let row = (await client.query('SELECT * FROM ocr_defaults WHERE singleton')).rows[0];
    if (!row) {
      await client.query(
        'INSERT INTO ocr_defaults(singleton,language,processing_config) VALUES(true,$1,$2) ON CONFLICT DO NOTHING',
        [settings.language, settings.processingConfig],
      );
      row = (await client.query('SELECT * FROM ocr_defaults WHERE singleton')).rows[0];
    }
    return row;
  }
  return {
    current,
    async get(user) {
      requirePermission(user, 'settings:read');
      return {
        defaults: await current(),
        hardware,
        engines: (await provider.catalog()).engines,
        profiles: ocrProfiles.map((profile) => ({
          id: profile,
          preprocessing: processingConfig({ profile }).preprocessing,
        })),
        limits: {
          concurrency: 1,
          dpi: 300,
          timeoutSeconds: settings.timeoutSeconds,
          maxAttempts: settings.maxAttempts,
        },
      };
    },
    async update(user, body) {
      requirePermission(user, 'settings:manage');
      keys(body, [
        'version',
        'language',
        'engine',
        'model',
        'profile',
        'psm',
        'layout',
        'cpuThreads',
        'preprocessing',
      ]);
      const { version, language, ...options } = body;
      if (
        !Number.isSafeInteger(version) ||
        !['ind', 'eng', 'ind+eng', 'eng+ind'].includes(language) ||
        !['tesseract', 'paddleocr'].includes(options.engine) ||
        !ocrProfiles.includes(options.profile)
      )
        throw failure(
          'invalid_request',
          'A current settings version and supported OCR engine, profile and language are required.',
        );
      const config = processingConfig({
        ...options,
        ...(options.engine === 'paddleocr' ? { cpuThreads: options.cpuThreads ?? 1 } : {}),
      });
      if (config.cpuThreads > maxThreads)
        throw failure(
          'invalid_request',
          'The selected CPU budget exceeds this workstation’s available thread options.',
        );
      if ((await current()).version !== version)
        throw failure('conflict', 'OCR settings changed. Reload before saving.', 409);
      await provider.info(language, AbortSignal.timeout(15000), config);
      const defaults = await transaction(pool, async (client) => {
        const saved = (
          await client.query(
            'UPDATE ocr_defaults SET language=$2,processing_config=$3,version=version+1,updated_at=now(),updated_by=$4 WHERE singleton AND version=$1 RETURNING *',
            [version, language, config, user.id],
          )
        ).rows[0];
        if (!saved) throw failure('conflict', 'OCR settings changed. Reload before saving.', 409);
        await audit(client, user, 'ocr.settings_updated', 'ocr_settings', null, {
          version: saved.version,
          language,
          configuration: config,
        });
        return saved;
      });
      return { defaults };
    },
  };
}
