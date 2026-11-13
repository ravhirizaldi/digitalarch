import { createInterface } from 'node:readline/promises';
import { database } from '../server/db.mjs';
import { authentication, administration } from '../server/auth.mjs';
const pool = database();
const input = createInterface({ input: process.stdin, output: process.stdout });
try {
  const username = process.argv[2] || (await input.question('Administrator username: '));
  const displayName = process.argv[3] || (await input.question('Display name: '));
  const result = await administration(pool, authentication(pool)).create(
    null,
    { username, displayName, roles: ['system_admin'] },
    true,
  );
  console.log(
    `Created ${result.user.username}. Temporary password (shown once): ${result.temporaryPassword}\nChange it on first sign-in. Assign operational roles explicitly.`,
  );
} catch (error) {
  console.error(
    error.statusCode
      ? error.message
      : 'Bootstrap failed. Check database connectivity and migrations.',
  );
  process.exitCode = 1;
} finally {
  input.close();
  await pool.end();
}
