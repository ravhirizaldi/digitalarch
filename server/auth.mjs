import { hash, verify, Algorithm } from '@node-rs/argon2';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { transaction } from './db.mjs';
import { failure } from './errors.mjs';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
const csrfFor = (token) =>
  createHmac('sha256', token).update('digitalarch:csrf').digest('base64url');
export const temporaryPassword = () => randomBytes(24).toString('base64url');
export const passwordHash = (password) =>
  hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
const dummyHash = passwordHash(temporaryPassword());
export const uuid = (value) => {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  )
    throw failure('invalid_id', 'A valid UUID is required.');
  return value;
};
export function keys(body, allowed) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.includes(key))
  )
    throw failure('invalid_request', 'Unsupported request fields.');
}
export function text(value, max, label, optional = false) {
  if (optional && (value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw failure('invalid_request', `${label} must contain 1–${max} characters.`);
  return value.trim();
}
export function requirePermission(user, permission) {
  if (!user?.permissions.includes(permission))
    throw failure('forbidden', 'You do not have permission for this operation.', 403);
}
export async function audit(
  client,
  actor,
  action,
  entityType,
  entityId,
  metadata = {},
  batchId = null,
  correlationId = null,
) {
  await client.query(
    'INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata,batch_id,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      actor?.id || null,
      action,
      entityType,
      entityId,
      metadata,
      batchId,
      correlationId || actor?.correlationId || null,
    ],
  );
}

const userSelect = `SELECT u.id,u.username,u.display_name,u.is_active,u.must_change_password,u.version,u.created_at,u.last_login_at,
  COALESCE((SELECT array_agg(r.code ORDER BY r.code) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id),'{}') AS roles,
  COALESCE((SELECT array_agg(DISTINCT p.code) FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=u.id),'{}') AS permissions FROM users u`;

export function authentication(pool) {
  let verifying = 0;
  const cookie = (token, maxAge) =>
    `digitalarch_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;
  async function issue(client, userId) {
    const token = randomBytes(32).toString('base64url');
    const csrf = csrfFor(token);
    const hours = Number(process.env.SESSION_HOURS || 12);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168)
      throw new Error('SESSION_HOURS must be between 0 and 168');
    await client.query(
      "INSERT INTO auth_sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 hour')",
      [userId, digest(token), digest(csrf), hours],
    );
    // Set-Cookie is applied by the caller only after the transaction commits.
    return { csrfToken: csrf, sessionCookie: cookie(token, hours * 3600) };
  }
  const api = {
    async user(id, client = pool) {
      return (await client.query(`${userSelect} WHERE u.id=$1`, [id])).rows[0];
    },
    async authenticate(req) {
      const token = /(?:^|;\s*)digitalarch_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(
        req.headers.cookie || '',
      )?.[1];
      if (!token) throw failure('unauthenticated', 'Sign in to DigitalArch.', 401);
      const session = (
        await pool.query(
          'SELECT id,user_id,csrf_hash FROM auth_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',
          [digest(token)],
        )
      ).rows[0];
      const user = session && (await api.user(session.user_id));
      if (!user?.is_active)
        throw failure(
          'unauthenticated',
          'Your session expired or was revoked. Sign in again.',
          401,
        );
      return { user, session, csrfToken: csrfFor(token) };
    },
    csrf(req, session) {
      const supplied = req.headers['x-csrf-token'];
      if (
        typeof supplied !== 'string' ||
        supplied.length > 128 ||
        !timingSafeEqual(Buffer.from(digest(supplied)), Buffer.from(session.csrf_hash))
      )
        throw failure('csrf', 'Security token missing or expired. Reload the page.', 403);
    },
    async login(body, res, correlationId) {
      keys(body, ['username', 'password']);
      const username = text(body.username, 64, 'Username').toLowerCase();
      if (typeof body.password !== 'string' || body.password.length > 256)
        throw failure('invalid_credentials', 'Invalid username or password.', 401);
      if (verifying >= 4)
        throw failure('rate_limited', 'Too many sign-in requests. Try again shortly.', 429);
      verifying++;
      try {
        const result = await transaction(pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('login:'||$1))", [username]);
          const attempt = (
            await client.query('SELECT * FROM auth_login_attempts WHERE username=$1', [username])
          ).rows[0];
          if (
            attempt &&
            Date.now() - new Date(attempt.window_started_at).getTime() < 15 * 60_000 &&
            attempt.attempts >= 5
          )
            throw failure('rate_limited', 'Too many failed sign-ins. Wait 15 minutes.', 429);
          const account = (
            await client.query(
              'SELECT id,password_hash,is_active FROM users WHERE lower(username)=$1 FOR UPDATE',
              [username],
            )
          ).rows[0];
          const valid = await verify(account?.password_hash || (await dummyHash), body.password);
          if (!valid || !account?.is_active) {
            await client.query(
              `INSERT INTO auth_login_attempts(username,attempts) VALUES($1,1) ON CONFLICT(username) DO UPDATE SET
              attempts=CASE WHEN auth_login_attempts.window_started_at < now()-interval '15 minutes' THEN 1 ELSE auth_login_attempts.attempts+1 END,
              window_started_at=CASE WHEN auth_login_attempts.window_started_at < now()-interval '15 minutes' THEN now() ELSE auth_login_attempts.window_started_at END`,
              [username],
            );
            return null;
          }
          await client.query('DELETE FROM auth_login_attempts WHERE username=$1', [username]);
          await client.query('UPDATE users SET last_login_at=now() WHERE id=$1', [account.id]);
          await audit(client, account, 'auth.login', 'user', account.id, {}, null, correlationId);
          return { user: await api.user(account.id, client), ...(await issue(client, account.id)) };
        });
        if (!result) throw failure('invalid_credentials', 'Invalid username or password.', 401);
        res.setHeader('Set-Cookie', result.sessionCookie);
        delete result.sessionCookie;
        return result;
      } finally {
        verifying--;
      }
    },
    async logout(context, res) {
      await transaction(pool, async (client) => {
        await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1', [
          context.session.id,
        ]);
        await audit(client, context.user, 'auth.logout', 'user', context.user.id);
      });
      res.setHeader('Set-Cookie', cookie('', 0));
      return { ok: true };
    },
    async changePassword(context, body, res) {
      keys(body, ['currentPassword', 'newPassword']);
      if (
        typeof body.currentPassword !== 'string' ||
        body.currentPassword.length > 256 ||
        typeof body.newPassword !== 'string' ||
        body.newPassword.length < 12 ||
        body.newPassword.length > 256 ||
        body.newPassword === body.currentPassword
      )
        throw failure('invalid_password', 'Use a different password with 12–256 characters.');
      const result = await transaction(pool, async (client) => {
        const user = (
          await client.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [
            context.user.id,
          ])
        ).rows[0];
        if (!(await verify(user.password_hash, body.currentPassword)))
          throw failure('invalid_password', 'Current password is incorrect.');
        await client.query(
          'UPDATE users SET password_hash=$2,must_change_password=false,updated_at=now(),version=version+1 WHERE id=$1',
          [context.user.id, await passwordHash(body.newPassword)],
        );
        await client.query(
          'UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
          [context.user.id],
        );
        await audit(client, context.user, 'auth.password_changed', 'user', context.user.id);
        return {
          user: await api.user(context.user.id, client),
          ...(await issue(client, context.user.id)),
        };
      });
      res.setHeader('Set-Cookie', result.sessionCookie);
      delete result.sessionCookie;
      return result;
    },
  };
  return api;
}

export function administration(pool, auth) {
  async function roles(client, codes) {
    if (
      !Array.isArray(codes) ||
      !codes.length ||
      codes.length > 6 ||
      codes.some((code) => typeof code !== 'string') ||
      new Set(codes).size !== codes.length
    )
      throw failure('invalid_roles', 'Select at least one distinct role.');
    if (
      (codes.includes('approver_l1') && codes.includes('approver_l2')) ||
      (codes.some((code) => ['operator', 'qc_officer'].includes(code)) &&
        codes.some((code) => ['approver_l1', 'approver_l2'].includes(code)))
    )
      throw failure(
        'separation_of_duties',
        'Capture/QC and approval roles must be separate; approval levels must also be separate.',
      );
    const rows = (
      await client.query('SELECT id,code FROM roles WHERE code=ANY($1::text[])', [codes])
    ).rows;
    if (rows.length !== codes.length) throw failure('invalid_roles', 'Unknown role.');
    return rows;
  }
  async function lock(client) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('digitalarch:administrators'))");
  }
  return {
    async list() {
      return {
        users: (await pool.query(`${userSelect} ORDER BY lower(u.username)`)).rows,
        roles: (await pool.query('SELECT code,display_name FROM roles ORDER BY display_name')).rows,
      };
    },
    async create(actor, body, bootstrap = false) {
      keys(body, ['username', 'displayName', 'roles']);
      const username = text(body.username, 64, 'Username');
      if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username))
        throw failure(
          'invalid_username',
          'Username needs 3–64 letters, digits, dots, dashes or underscores.',
        );
      const displayName = text(body.displayName, 120, 'Display name');
      const password = temporaryPassword();
      const result = await transaction(pool, async (client) => {
        await lock(client);
        if (
          bootstrap &&
          (
            await client.query(
              "SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.code='system_admin' LIMIT 1",
            )
          ).rowCount
        )
          throw failure(
            'already_bootstrapped',
            'An administrator already exists. Bootstrap refused.',
            409,
          );
        const assigned = await roles(client, body.roles);
        const id = (
          await client.query(
            'INSERT INTO users(username,display_name,password_hash) VALUES($1,$2,$3) RETURNING id',
            [username, displayName, await passwordHash(password)],
          )
        ).rows[0].id;
        for (const role of assigned)
          await client.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [
            id,
            role.id,
          ]);
        await audit(client, actor, 'user.created', 'user', id, { roles: body.roles, bootstrap });
        return auth.user(id, client);
      });
      return { user: result, temporaryPassword: password };
    },
    async update(actor, id, body) {
      uuid(id);
      keys(body, ['version', 'displayName', 'isActive', 'roles']);
      if (body.isActive !== undefined && typeof body.isActive !== 'boolean')
        throw failure('invalid_request', 'isActive must be boolean.');
      return transaction(pool, async (client) => {
        await lock(client);
        const current = await auth.user(id, client);
        if (!current) throw failure('not_found', 'User not found.', 404);
        if (current.version !== body.version)
          throw failure('conflict', 'This account changed. Reload before editing.', 409);
        const assigned = body.roles === undefined ? null : await roles(client, body.roles);
        const active = body.isActive ?? current.is_active;
        const nextRoles = body.roles ?? current.roles;
        if (actor.id === id && (!active || !nextRoles.includes('system_admin')))
          throw failure(
            'own_admin_access',
            'You cannot disable yourself or remove your administrative access.',
            409,
          );
        if (
          current.is_active &&
          current.roles.includes('system_admin') &&
          (!active || !nextRoles.includes('system_admin'))
        ) {
          const count = (
            await client.query(
              "SELECT count(*)::int FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.is_active AND r.code='system_admin'",
            )
          ).rows[0].count;
          if (count <= 1)
            throw failure(
              'last_admin',
              'The last active system administrator must remain enabled.',
              409,
            );
        }
        await client.query(
          'UPDATE users SET display_name=$2,is_active=$3,updated_at=now(),version=version+1 WHERE id=$1',
          [
            id,
            body.displayName === undefined
              ? current.display_name
              : text(body.displayName, 120, 'Display name'),
            active,
          ],
        );
        if (assigned) {
          await client.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
          for (const role of assigned)
            await client.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [
              id,
              role.id,
            ]);
          await audit(client, actor, 'user.roles_changed', 'user', id, {
            from: current.roles,
            to: nextRoles,
          });
        }
        await client.query(
          'UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
          [id],
        );
        await audit(client, actor, active ? 'user.updated' : 'user.disabled', 'user', id, {
          isActive: active,
        });
        return { user: await auth.user(id, client) };
      });
    },
    async reset(actor, id) {
      uuid(id);
      const password = temporaryPassword();
      await transaction(pool, async (client) => {
        if (
          !(
            await client.query(
              'UPDATE users SET password_hash=$2,must_change_password=true,updated_at=now(),version=version+1 WHERE id=$1 RETURNING id',
              [id, await passwordHash(password)],
            )
          ).rowCount
        )
          throw failure('not_found', 'User not found.', 404);
        await client.query(
          'UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
          [id],
        );
        await audit(client, actor, 'user.password_reset', 'user', id);
      });
      return { temporaryPassword: password };
    },
    async logs(limit = 100, offset = 0) {
      return {
        logs: (
          await pool.query(
            'SELECT a.*,u.username AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.id LIMIT $1 OFFSET $2',
            [limit, offset],
          )
        ).rows,
      };
    },
  };
}
