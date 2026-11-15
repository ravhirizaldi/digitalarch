import { hash, verify, Algorithm } from '@node-rs/argon2';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { transaction } from './db.mjs';
import { failure } from './errors.mjs';
import { isViewer, viewerAudit } from './viewer-audit.mjs';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
const csrfFor = (token) =>
  createHmac('sha256', token).update('digitalarch:csrf').digest('base64url');
export const temporaryPassword = () => randomBytes(24).toString('base64url');
function accountPassword(value) {
  if (value === undefined) return temporaryPassword();
  if (typeof value !== 'string' || value.length < 12 || value.length > 256 || !value.trim())
    throw failure('invalid_password', 'Use a temporary password with 12–256 characters.');
  return value;
}
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

const userSelect = `SELECT u.id,u.username,u.display_name,u.is_active,u.must_change_password,u.version,u.created_at,u.last_login_at,u.deleted_at,u.viewer_registration_status,
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
          'SELECT id,user_id,csrf_hash,revoked_at,expires_at FROM auth_sessions WHERE token_hash=$1',
          [digest(token)],
        )
      ).rows[0];
      const user = session && (await api.user(session.user_id));
      if (
        !user?.is_active ||
        session.revoked_at ||
        new Date(session.expires_at) <= new Date() ||
        (user.viewer_registration_status && user.viewer_registration_status !== 'approved')
      ) {
        if (isViewer(user))
          await viewerAudit(
            pool,
            'access',
            { ...user, correlationId: req.correlationId },
            'session_denied',
          );
        throw failure(
          'unauthenticated',
          'Your session expired or was revoked. Sign in again.',
          401,
        );
      }
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
              'SELECT id,password_hash,is_active,deleted_at,viewer_registration_status FROM users WHERE lower(username)=$1 FOR UPDATE',
              [username],
            )
          ).rows[0];
          const valid = await verify(account?.password_hash || (await dummyHash), body.password);
          const details = account && (await api.user(account.id, client));
          if (
            valid &&
            account &&
            !account.deleted_at &&
            ['pending', 'rejected'].includes(account.viewer_registration_status)
          ) {
            await client.query('DELETE FROM auth_login_attempts WHERE username=$1', [username]);
            await viewerAudit(
              client,
              'access',
              { ...details, correlationId },
              'registration_status',
              {
                subjectId: account.id,
                metadata: { status: account.viewer_registration_status },
              },
            );
            return { registrationStatus: account.viewer_registration_status };
          }
          if (!valid || !account?.is_active) {
            await client.query(
              `INSERT INTO auth_login_attempts(username,attempts) VALUES($1,1) ON CONFLICT(username) DO UPDATE SET
              attempts=CASE WHEN auth_login_attempts.window_started_at < now()-interval '15 minutes' THEN 1 ELSE auth_login_attempts.attempts+1 END,
              window_started_at=CASE WHEN auth_login_attempts.window_started_at < now()-interval '15 minutes' THEN now() ELSE auth_login_attempts.window_started_at END`,
              [username],
            );
            if (isViewer(details))
              await viewerAudit(client, 'access', { ...details, correlationId }, 'login_failed');
            return null;
          }
          await client.query('DELETE FROM auth_login_attempts WHERE username=$1', [username]);
          await client.query('UPDATE users SET last_login_at=now() WHERE id=$1', [account.id]);
          await audit(client, account, 'auth.login', 'user', account.id, {}, null, correlationId);
          if (isViewer(details))
            await viewerAudit(client, 'access', { ...details, correlationId }, 'login');
          return { user: await api.user(account.id, client), ...(await issue(client, account.id)) };
        });
        if (!result) throw failure('invalid_credentials', 'Invalid username or password.', 401);
        if (result.sessionCookie) res.setHeader('Set-Cookie', result.sessionCookie);
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
        if (isViewer(context.user)) await viewerAudit(client, 'access', context.user, 'logout');
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
        if (isViewer(context.user))
          await viewerAudit(client, 'access', context.user, 'password_changed');
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
  async function currentAccount(client, id, version) {
    if (
      !(
        await client.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
          id,
        ])
      ).rowCount
    )
      throw failure('not_found', 'User not found or already deleted.', 404);
    const current = await auth.user(id, client);
    if (version !== undefined && current.version !== version)
      throw failure('conflict', `${current.username} changed. Refresh before trying again.`, 409);
    return current;
  }
  async function protectAdmin(client, actor, current, active, nextRoles) {
    if (actor.id === current.id && (!active || !nextRoles.includes('system_admin')))
      throw failure(
        'own_admin_access',
        'You cannot delete/disable yourself or remove your administrative access.',
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
  }
  async function resetAccount(client, actor, account, password) {
    await client.query(
      'UPDATE users SET password_hash=$2,must_change_password=true,updated_at=now(),version=version+1 WHERE id=$1',
      [account.id, await passwordHash(password)],
    );
    await client.query(
      'UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
      [account.id],
    );
    await audit(client, actor, 'user.password_reset', 'user', account.id);
    if (isViewer(account))
      await viewerAudit(client, 'access', actor, 'password_reset', { subjectId: account.id });
    return { username: account.username, password };
  }
  return {
    async list() {
      return {
        users: (
          await pool.query(
            `${userSelect} WHERE u.deleted_at IS NULL AND (u.viewer_registration_status IS NULL OR u.viewer_registration_status='approved') ORDER BY lower(u.username)`,
          )
        ).rows,
        roles: (await pool.query('SELECT code,display_name FROM roles ORDER BY display_name')).rows,
      };
    },
    async create(actor, body, bootstrap = false) {
      keys(body, ['username', 'displayName', 'roles', ...(bootstrap ? [] : ['password'])]);
      const username = text(body.username, 64, 'Username');
      if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username))
        throw failure(
          'invalid_username',
          'Username needs 3–64 letters, digits, dots, dashes or underscores.',
        );
      const displayName = text(body.displayName, 120, 'Display name');
      const password = accountPassword(body.password);
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
        if (body.roles.includes('archive_viewer'))
          await viewerAudit(client, 'registration', actor, 'admin_created', { subjectId: id });
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
        const current = await currentAccount(client, id, body.version);
        if (['pending', 'rejected'].includes(current.viewer_registration_status))
          throw failure(
            'registration_pending',
            'Use Viewer registrations to decide this request.',
            409,
          );
        if (current.version !== body.version)
          throw failure('conflict', 'This account changed. Reload before editing.', 409);
        const assigned = body.roles === undefined ? null : await roles(client, body.roles);
        const active = body.isActive ?? current.is_active;
        const nextRoles = body.roles ?? current.roles;
        await protectAdmin(client, actor, current, active, nextRoles);
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
        if (isViewer(current) || nextRoles.includes('archive_viewer'))
          await viewerAudit(
            client,
            'registration',
            actor,
            active ? 'account_updated' : 'disabled',
            { subjectId: id, metadata: { isActive: active, roles: nextRoles } },
          );
        return { user: await auth.user(id, client) };
      });
    },
    async reset(actor, id, body = {}) {
      uuid(id);
      keys(body, ['password', 'version']);
      if (!Number.isSafeInteger(body.version) || body.version < 1)
        throw failure('invalid_request', 'The current user version is required.');
      const password = accountPassword(body.password);
      await transaction(pool, async (client) => {
        await lock(client);
        await resetAccount(client, actor, await currentAccount(client, id, body.version), password);
      });
      return { temporaryPassword: password };
    },
    async bulk(actor, body) {
      keys(body, ['action', 'users', ...(body?.action === 'reset-password' ? ['password'] : [])]);
      if (
        !['delete', 'reset-password'].includes(body.action) ||
        !Array.isArray(body.users) ||
        !body.users.length ||
        body.users.length > 100
      )
        throw failure('invalid_request', 'Select 1–100 users and a supported action.');
      for (const target of body.users) {
        keys(target, ['id', 'version']);
        uuid(target.id);
        if (!Number.isSafeInteger(target.version) || target.version < 1)
          throw failure('invalid_request', 'Each selected user needs its current version.');
      }
      if (new Set(body.users.map(({ id }) => id.toLowerCase())).size !== body.users.length)
        throw failure('invalid_request', 'Select distinct users.');
      const sharedPassword =
        body.password === undefined ? undefined : accountPassword(body.password);
      return transaction(pool, async (client) => {
        await lock(client);
        const credentials = [];
        for (const target of [...body.users].sort((a, b) => a.id.localeCompare(b.id))) {
          const account = await currentAccount(client, target.id, target.version);
          if (body.action === 'delete') {
            await protectAdmin(client, actor, account, false, account.roles);
            await client.query(
              'UPDATE users SET is_active=false,deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1',
              [account.id],
            );
            await client.query(
              'UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
              [account.id],
            );
            await audit(client, actor, 'user.deleted', 'user', account.id);
            if (isViewer(account))
              await viewerAudit(client, 'registration', actor, 'deleted', {
                subjectId: account.id,
              });
          } else {
            credentials.push(
              await resetAccount(client, actor, account, sharedPassword ?? temporaryPassword()),
            );
          }
        }
        return { affected: body.users.length, credentials };
      });
    },
    async logs(limit = 100, offset = 0, { category = 'all', search = '' } = {}) {
      if (
        typeof category !== 'string' ||
        (category !== 'all' && !/^[a-z][a-z0-9_]{0,63}$/.test(category))
      )
        throw failure('invalid_request', 'Invalid audit category.');
      if (typeof search !== 'string' || search.length > 240)
        throw failure('invalid_request', 'Search must contain at most 240 characters.');
      const query = search.trim();
      const from = `FROM all_audit_logs a LEFT JOIN users u ON u.id=a.actor_id
        WHERE ($1='all' OR split_part(a.action,'.',1)=$1)
          AND ($2='' OR strpos(lower(concat_ws(' ',a.action,u.username,a.entity_type,a.entity_id::text)),lower($2))>0)`;
      const values = [category, query];
      return {
        logs: (
          await pool.query(
            `SELECT a.*,u.username AS actor ${from} ORDER BY a.created_at DESC,a.id LIMIT $3 OFFSET $4`,
            [...values, limit, offset],
          )
        ).rows,
        total: (await pool.query(`SELECT count(*)::int AS total ${from}`, values)).rows[0].total,
        counts: Object.fromEntries(
          (
            await pool.query(
              "SELECT split_part(action,'.',1) AS category,count(*)::int AS total FROM all_audit_logs GROUP BY 1 ORDER BY 1",
            )
          ).rows.map(({ category, total }) => [category, total]),
        ),
      };
    },
  };
}
