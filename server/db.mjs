import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { failure } from './errors.mjs';

try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

export function database(options = {}) {
  const pool = new pg.Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.POSTGRES_HOST_PORT || 5432),
    database: process.env.POSTGRES_DB || 'digitalarch',
    user: process.env.POSTGRES_USER || 'digitalarch',
    password: process.env.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 3000,
    max: 10,
    options: '-c timezone=UTC',
    ...options,
  });
  pool.on('error', () => console.error('PostgreSQL connection lost; captured files are retained.'));
  return pool;
}

export async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(pool) {
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('digitalarch:migrations'))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const existing = (
        await client.query('SELECT sha256 FROM schema_migrations WHERE name=$1', [name])
      ).rows[0];
      if (existing && existing.sha256 !== sha256)
        throw new Error(`Applied migration changed: ${name}`);
      if (!existing) {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [
          name,
          sha256,
        ]);
      }
    }
  });
}

export function databaseError(error) {
  if (['ENOENT', 'EACCES', 'ENOSPC', 'EIO', 'EROFS'].includes(error.code))
    return failure(
      'storage_unavailable',
      'File storage is unavailable. Check the original files, permissions and free space; nothing was deleted.',
      503,
    );
  if (error.code === '23505')
    return failure('conflict', 'This record already exists. Reload and try again.', 409);
  if (error.code === '23503' || error.code === '23514' || error.code === '22P02')
    return failure('invalid_request', 'The requested relationship or value is invalid.');
  return error.statusCode
    ? error
    : failure(
        'database_unavailable',
        'Database operation unavailable. Check PostgreSQL and retry; original files are retained.',
        503,
      );
}
