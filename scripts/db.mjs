import { database, migrate } from '../server/db.mjs';
const pool = database();
try {
  if (process.argv[2] === 'migrate') await migrate(pool);
  const result = await pool.query(
    "SELECT version(), (SELECT extversion FROM pg_extension WHERE extname='vector') AS vector",
  );
  console.log(result.rows[0]);
} finally {
  await pool.end();
}
