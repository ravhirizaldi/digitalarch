import { createRuntimeService } from '../server.mjs';
const service = await createRuntimeService();
try {
  await service.application.ready();
  // Run only with the ordinary backend stopped: the runtime lock prevents competing recovery.
  const sessions = (
    await service.application.pool.query(
      "SELECT * FROM scan_sessions WHERE status IN ('interrupted','partial','failed') ORDER BY started_at",
    )
  ).rows;
  for (const session of sessions) await service.application.batches.reconcile(session, true);
  console.log(
    `Reconciliation inspected ${sessions.length} recoverable sessions. No source files were removed.`,
  );
} finally {
  await service.application.close();
}
