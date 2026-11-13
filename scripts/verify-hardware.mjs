import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeService } from '../server.mjs';
import { audit } from '../server/auth.mjs';
import { transaction } from '../server/db.mjs';

if (!process.argv.includes('--confirm-loaded-paper')) {
  console.error(
    'Physical operation refused. Stop the backend, load paper, then run pnpm test:hardware --confirm-loaded-paper. This consumes the feeder once; no automatic retry.',
  );
  process.exit(1);
}
const service = await createRuntimeService();
const app = service.application;
let operator;
let batchId;
try {
  await app.ready();
  const scanner = await service.setMode('real');
  if (!scanner.canScan) throw new Error(`Real scanner unavailable: ${scanner.message}`);
  const profile = scanner.profiles.find((item) => item.id === scanner.profileId);
  console.log(
    JSON.stringify({
      phase: 'physical-inspection',
      device: scanner.device?.name,
      profile: profile?.name,
      settings: profile?.settings,
      state: scanner.state,
    }),
  );
  const account = await app.admin.create(null, {
    username: `hardware-check-${randomUUID().slice(0, 8)}`,
    displayName: 'Physical hardware verification (temporary)',
    roles: ['operator'],
  });
  operator = account.user;
  const created = await app.batches.create(operator, {});
  batchId = created.batch.id;
  await app.batches.start(operator, batchId, { version: created.batch.version, options: {} });
  console.log('One real feeder capture started. No simulator fallback or automatic retry.');
  let result;
  const deadline = Date.now() + 12 * 60_000;
  do {
    await delay(500);
    await app.batches.sweep();
    result = await app.batches.get(operator, batchId);
    if (Date.now() > deadline)
      throw new Error(
        'Capture still pending. Files and session are retained; inspect hardware before recovery.',
      );
  } while (result.sessions.some((session) => session.status === 'running'));
  for (const page of result.pages) {
    if (page.source !== 'real') throw new Error('Unexpected source provenance.');
    await app.storage.validate(page);
  }
  result = await app.batches.transition(operator, batchId, 'pause', {
    version: result.batch.version,
  });
  console.log(
    JSON.stringify(
      {
        phase: 'physical-result',
        batchCode: result.batch.batch_code,
        batchId,
        batchStatus: result.batch.status,
        sessions: result.sessions.map((session) => ({
          id: session.id,
          number: session.session_number,
          status: session.status,
          source: session.scanner_mode,
          device: session.device_name,
          profile: session.profile_name,
          pages: session.page_count,
          error: session.error_summary,
        })),
        pages: result.pages.map((page) => ({
          id: page.id,
          order: page.capture_order,
          storageKey: page.original_storage_key,
          bytes: page.byte_size,
          sha256: page.sha256,
          width: page.width_px,
          height: page.height_px,
          dpi: page.dpi,
          source: page.source,
        })),
        validatedOriginals: result.pages.length,
        originalsPreserved: true,
      },
      null,
      2,
    ),
  );
  if (result.sessions[0].status !== 'completed') process.exitCode = 1;
} catch (error) {
  console.error(
    `Physical verification did not complete: ${error.message}. Batch ${batchId || '(not created)'} and any generated files are retained. Do not automatically retry.`,
  );
  process.exitCode = 1;
} finally {
  if (operator)
    await transaction(app.pool, async (client) => {
      await client.query(
        'UPDATE users SET is_active=false,version=version+1,updated_at=now() WHERE id=$1',
        [operator.id],
      );
      await audit(client, null, 'user.disabled', 'user', operator.id, {
        reason: 'Temporary physical-verification account retired',
        retainedBatchId: batchId || null,
      });
    }).catch(() =>
      console.error(
        'Could not retire verification account. Disable it in Administration after database recovery.',
      ),
    );
  await app.close();
}
