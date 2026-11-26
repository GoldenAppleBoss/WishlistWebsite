import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { HttpError, normalizeDisplayName, passwordHash, readPasswordKey, tokenHash } from './auth.mjs';
import { wishlists, itemIds } from './catalogue.mjs';

const attemptWindow = 15 * 60 * 1000;
const sessionLifetime = 12 * 60 * 60 * 1000;
const dummySalt = randomBytes(16);
const sessionQuery = `
  SELECT accounts.id, accounts.name, cart_revision.instance, cart_revision.revision
  FROM sessions JOIN accounts ON accounts.id = sessions.user_id
  CROSS JOIN cart_revision
  WHERE token_hash = $1 AND expires > $2
`;

function reply(status, body, headers = {}) {
  const options = { status, headers: { 'Cache-Control': 'private, no-store', ...headers } };
  return body === undefined ? new Response(null, options) : Response.json(body, options);
}

async function readCartChange(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Expected JSON.');
  }
  if (!request.body) throw new HttpError(400, 'Invalid request.');
  const chunks = [];
  let length = 0;
  for await (const chunk of request.body) {
    length += chunk.byteLength;
    if (length > 2048) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Invalid request.');
  }
}

async function countAttempt(sql, bucket, now) {
  const [{ count }] = await sql.query(`
    INSERT INTO attempts (bucket, count, reset_at) VALUES ($1, 1, $2)
    ON CONFLICT (bucket) DO UPDATE SET
      count = CASE WHEN attempts.reset_at <= $3 THEN 1 ELSE LEAST(attempts.count + 1, 21) END,
      reset_at = CASE WHEN attempts.reset_at <= $3 THEN excluded.reset_at ELSE attempts.reset_at END
    RETURNING count
  `, [bucket, now + attemptWindow, now]);
  return count;
}

async function authenticate(request, sql, pepper, signup) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'text/plain') {
    throw new HttpError(415, 'Expected a text password.');
  }
  let name;
  try {
    name = decodeURIComponent(request.headers.get('x-wishlist-name') ?? '');
  } catch {
    throw new HttpError(400, 'Enter a valid display name.');
  }
  const displayName = normalizeDisplayName(name);
  const nameKey = displayName.toLowerCase();
  const ip = request.headers.get('x-vercel-forwarded-for') ?? 'local';
  const bucket = value => createHmac('sha256', pepper).update(value).digest('hex');
  const now = Date.now();
  const accountBucket = bucket('account:' + nameKey);
  if (await countAttempt(sql, bucket('ip:' + ip), now) > 20 ||
      (!signup && await countAttempt(sql, accountBucket, now) > 8)) {
    return reply(429, { error: 'Too many attempts. Try again in 15 minutes.' }, { 'Retry-After': '900' });
  }
  if (!request.body) throw new HttpError(400, 'Enter a password of at least 4 characters.');
  const key = await readPasswordKey(request.body, pepper);
  const token = randomBytes(32).toString('base64url');
  const hash = tokenHash(token);
  const expires = Date.now() + sessionLifetime;
  const cleanup = [
    sql.query('DELETE FROM attempts WHERE reset_at <= $1', [now]),
    sql.query('DELETE FROM sessions WHERE expires <= $1', [now])
  ];
  if (signup) {
    const salt = randomBytes(16);
    const password = await passwordHash(key, salt);
    const [created] = await sql.transaction([
      sql.query(`
        WITH new_account AS (
          INSERT INTO accounts (name, name_key, salt, password_hash) VALUES ($1, $2, $3, $4)
          ON CONFLICT (name_key) DO NOTHING RETURNING id
        )
        INSERT INTO sessions (token_hash, user_id, expires)
        SELECT $5, id, $6 FROM new_account RETURNING user_id
      `, [displayName, nameKey, salt.toString('hex'), password.toString('hex'), hash, expires]),
      ...cleanup
    ]);
    if (!created.length) throw new HttpError(409, 'That display name is taken.');
  } else {
    const [account] = await sql.query('SELECT id, salt, password_hash FROM accounts WHERE name_key = $1', [nameKey]);
    const salt = account ? Buffer.from(account.salt, 'hex') : dummySalt;
    const expected = account ? Buffer.from(account.password_hash, 'hex') : Buffer.alloc(32);
    const actual = await passwordHash(key, salt);
    if (!timingSafeEqual(actual, expected) || !account) {
      throw new HttpError(401, 'The display name or password is incorrect.');
    }
    await sql.transaction([
      sql.query('INSERT INTO sessions (token_hash, user_id, expires) VALUES ($1, $2, $3)', [hash, account.id, expires]),
      sql.query('DELETE FROM attempts WHERE bucket = $1', [accountBucket]),
      ...cleanup
    ]);
  }
  return reply(signup ? 201 : 200, { token });
}

async function cartStatus(sql, userId) {
  const rows = await sql.query(`
    SELECT r.instance, r.revision, c.item_id, a.name, c.user_id = $1 AS mine
    FROM cart_revision r
    LEFT JOIN carts c ON TRUE
    LEFT JOIN accounts a ON a.id = c.user_id
    ORDER BY c.item_id, a.name_key
  `, [userId]);
  const mine = [];
  const reserved = new Set();
  const owners = Object.create(null);
  for (const row of rows) {
    if (!itemIds.has(row.item_id)) continue;
    (owners[row.item_id] ??= []).push(row.name);
    if (row.mine) mine.push(row.item_id);
    else reserved.add(row.item_id);
  }
  return { mine, reserved: [...reserved], owners, instance: rows[0].instance, revision: Number(rows[0].revision) };
}

async function changeCart(request, sql, user, hash) {
  const { itemId, action, continueAnyway } = await readCartChange(request);
  if (!itemIds.has(itemId) || !['add', 'remove'].includes(action)) {
    throw new HttpError(400, 'Choose a valid wishlist item.');
  }
  const validSession = 'EXISTS (SELECT 1 FROM sessions WHERE token_hash = $3 AND expires > $4)';
  const change = action === 'add'
    ? `INSERT INTO carts (user_id, item_id)
       SELECT $1::integer, $2::text WHERE ${validSession}
         AND ($5::boolean OR NOT EXISTS (
           SELECT 1 FROM carts WHERE item_id = $2 AND user_id <> $1
         ))
       ON CONFLICT DO NOTHING RETURNING item_id`
    : `DELETE FROM carts WHERE user_id = $1 AND item_id = $2 AND ${validSession} RETURNING item_id`;
  const params = [user.id, itemId, hash, Date.now()];
  if (action === 'add') params.push(continueAnyway === true);
  // Take the lock in its own statement. Under READ COMMITTED, the subsequent
  // duplicate check sees the last completed cart change from any instance.
  const [, changed] = await sql.transaction([
    sql.query('SELECT revision FROM cart_revision WHERE id = 1 FOR UPDATE'),
    sql.query(`
      WITH changed AS (${change})
      UPDATE cart_revision SET revision = revision + 1
      WHERE id = 1 AND EXISTS (SELECT 1 FROM changed)
      RETURNING revision
    `, params)
  ], { isolationLevel: 'ReadCommitted' });
  if (!changed.length && !(await sql.query(sessionQuery, [hash, Date.now()])).length) {
    throw new HttpError(401, 'Your session has ended. Sign in again.');
  }
  const cart = await cartStatus(sql, user.id);
  if (action === 'add' && !changed.length && !cart.mine.includes(itemId)) {
    return reply(409, { error: 'This item is already in someone else’s cart.', cart });
  }
  return reply(200, cart);
}

export function wishlistHandler(action, { env = process.env, database = neon } = {}) {
  return async request => {
    try {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'Request origin is invalid.');
      const connectionString = env.DATABASE_URL;
      const pepper = env.WISHLIST_PASSWORD_SECRET;
      if (!connectionString || !/^[A-Za-z0-9_-]{43}$/.test(pepper ?? '')) {
        throw new HttpError(503, 'The wishlist database is still being set up.');
      }
      const sql = database(connectionString);
      if (action === 'signup' || action === 'login') return await authenticate(request, sql, pepper, action === 'signup');
      const auth = request.headers.get('authorization')?.match(/^Bearer ([\w-]{43})$/);
      if (!auth) throw new HttpError(401, 'Sign in to view your wishlists.');
      const hash = tokenHash(auth[1]);
      const [user] = await sql.query(sessionQuery, [hash, Date.now()]);
      if (!user) throw new HttpError(401, 'Sign in to view your wishlists.');
      if (action === 'catalogue') {
        return reply(200, { name: user.name, wishlists, cart: await cartStatus(sql, user.id) });
      }
      if (action === 'live') {
        if (url.searchParams.get('since') === String(user.revision) &&
            url.searchParams.get('instance') === user.instance) return reply(204);
        return reply(200, await cartStatus(sql, user.id));
      }
      if (action === 'cart') return await changeCart(request, sql, user, hash);
      if (action === 'logout') {
        await sql.query('DELETE FROM sessions WHERE token_hash = $1', [hash]);
        return reply(204);
      }
      throw new HttpError(404, 'Page not found.');
    } catch (error) {
      if (error instanceof HttpError) return reply(error.status, { error: error.message });
      console.error('Wishlist request failed', error.code ?? error.name);
      return reply(500, { error: 'Something went wrong. Try again shortly.' });
    }
  };
}
