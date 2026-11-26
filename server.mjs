import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError, normalizeDisplayName, passwordHash, readPasswordKey, tokenHash } from './lib/auth.mjs';
import { wishlists, itemIds, imagePaths, pagePaths } from './lib/catalogue.mjs';

const root = import.meta.dirname;
const assets = new Set(['/style.css', '/wishlist.js', '/favicon.svg', ...imagePaths]);
const pages = new Set(['/index.html', ...pagePaths]);

const production = process.env.NODE_ENV === 'production';
const origin = process.env.WISHLIST_ORIGIN;
const configuredPepper = process.env.WISHLIST_PIN_SECRET;
if (production && (!origin?.startsWith('https://') || !configuredPepper || configuredPepper.length < 43)) {
  throw new Error('Set WISHLIST_ORIGIN to the public HTTPS origin and WISHLIST_PIN_SECRET to a random 32-byte secret (base64url).');
}

const dbPath = resolve(process.env.WISHLIST_DB ?? resolve(root, '.wishlist-data', 'wishlist.sqlite'));
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
    salt BLOB NOT NULL, pin_hash BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES accounts(id),
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS carts (
    user_id INTEGER NOT NULL REFERENCES accounts(id),
    item_id TEXT NOT NULL, PRIMARY KEY (user_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS carts_item ON carts (item_id);
  CREATE TABLE IF NOT EXISTS attempts (
    bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL
  );
`);

const pepper = configuredPepper ?? localPepper();
const dummySalt = randomBytes(16);
const sessionLifetime = 12 * 60 * 60 * 1000;
const expiryWindow = 15 * 60 * 1000;
const instance = randomBytes(8).toString('hex');
let cartRevision = 0;
const streams = new Set();

const accountByName = db.prepare('SELECT * FROM accounts WHERE name_key = ?');
const addAccount = db.prepare('INSERT INTO accounts (name, name_key, salt, pin_hash) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');
const getSession = db.prepare(`
  SELECT accounts.id, accounts.name, sessions.expires
  FROM sessions JOIN accounts ON sessions.user_id = accounts.id
  WHERE token_hash = ? AND expires > ?
`);
const saveSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const sweepSessions = db.prepare('DELETE FROM sessions WHERE expires <= ?');
const sweepAttempts = db.prepare('DELETE FROM attempts WHERE reset_at <= ?');
const addAttempt = db.prepare(`
  INSERT INTO attempts VALUES (?, 1, ?)
  ON CONFLICT(bucket) DO UPDATE SET count = count + 1
  RETURNING count
`);
const clearAttempt = db.prepare('DELETE FROM attempts WHERE bucket = ?');
const getCartStatus = db.prepare(`
  SELECT carts.item_id, carts.user_id, accounts.name
  FROM carts JOIN accounts ON accounts.id = carts.user_id
  ORDER BY carts.item_id, accounts.name_key
`);
const insertItem = db.prepare(`
  INSERT INTO carts (user_id, item_id)
  SELECT ?, ? WHERE ? OR NOT EXISTS (SELECT 1 FROM carts WHERE item_id = ? AND user_id <> ?)
  ON CONFLICT DO NOTHING
`);
const ownItem = db.prepare('SELECT 1 FROM carts WHERE user_id = ? AND item_id = ?');
const removeItem = db.prepare('DELETE FROM carts WHERE user_id = ? AND item_id = ?');

function localPepper() {
  const file = dbPath + '.key';
  try {
    writeFileSync(file, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return readFileSync(file, 'utf8');
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Expected JSON.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
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

function cartStatus(userId) {
  const mine = [];
  const reserved = new Set();
  const owners = Object.create(null);
  for (const row of getCartStatus.all()) {
    if (!itemIds.has(row.item_id)) continue;
    (owners[row.item_id] ??= []).push(row.name);
    if (row.user_id === userId) mine.push(row.item_id);
    else reserved.add(row.item_id);
  }
  return { mine, reserved: [...reserved], owners, instance, revision: cartRevision };
}

function pushStatus() {
  for (const { res, user } of streams) {
    if (res.writableLength > 65536) {
      res.destroy();
      continue;
    }
    res.write(JSON.stringify(cartStatus(user.id)) + '\n');
  }
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function authenticate(req, res, signup) {
  // Older clients still send their PIN in a small JSON request. The current
  // form streams UTF-8 password bytes into the hash without a length limit.
  const plainText = req.headers['content-type']?.split(';')[0] === 'text/plain';
  let name;
  let legacyPassword;
  if (plainText) {
    try {
      name = decodeURIComponent(req.headers['x-wishlist-name'] ?? '');
    } catch {
      throw new HttpError(400, 'Enter a valid display name.');
    }
  } else {
    const credentials = await readJson(req);
    name = credentials.name;
    legacyPassword = credentials.pin;
  }
  const displayName = normalizeDisplayName(name);
  const nameKey = displayName.toLowerCase();
  const ip = production ? req.headers['x-wishlist-client-ip'] ?? req.socket.remoteAddress : req.socket.remoteAddress;
  const now = Date.now();
  sweepAttempts.run(now);
  const ipBucket = createHmac('sha256', pepper).update('ip:' + ip).digest('hex');
  const accountBucket = createHmac('sha256', pepper).update('account:' + nameKey).digest('hex');
  if (addAttempt.get(ipBucket, now + expiryWindow).count > 20 ||
      (!signup && addAttempt.get(accountBucket, now + expiryWindow).count > 8)) {
    res.setHeader('Retry-After', '900');
    throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  }

  if (!plainText && (typeof legacyPassword !== 'string' || [...legacyPassword].length < 4)) {
    throw new HttpError(400, 'Enter a password of at least 4 characters.');
  }
  const key = plainText ? await readPasswordKey(req, pepper) : createHmac('sha256', pepper).update(legacyPassword).digest();
  let id;
  if (signup) {
    const salt = randomBytes(16);
    const hash = await passwordHash(key, salt);
    const result = addAccount.run(displayName, nameKey, salt, hash);
    if (!result.changes) throw new HttpError(409, 'That display name is taken.');
    id = result.lastInsertRowid;
  } else {
    const account = accountByName.get(nameKey);
    const hash = await passwordHash(key, account?.salt ?? dummySalt);
    if (!account || !timingSafeEqual(hash, account.pin_hash)) {
      throw new HttpError(401, 'The display name or password is incorrect.');
    }
    id = account.id;
    clearAttempt.run(accountBucket);
  }
  const token = randomBytes(32).toString('base64url');
  sweepSessions.run(Date.now());
  saveSession.run(tokenHash(token), id, Date.now() + sessionLifetime);
  reply(res, signup ? 201 : 200, { token });
}

async function api(req, res, path) {
  if (req.headers.origin && req.headers.origin !== (origin ?? 'http://' + req.headers.host)) {
    throw new HttpError(403, 'Request origin is invalid.');
  }
  const method = req.method;
  if (method === 'POST' && (path === '/api/signup' || path === '/api/login')) {
    return authenticate(req, res, path === '/api/signup');
  }
  const auth = req.headers.authorization?.match(/^Bearer ([\w-]{43})$/);
  const hash = auth && tokenHash(auth[1]);
  const user = hash && getSession.get(hash, Date.now());
  if (!user) throw new HttpError(401, 'Sign in to view your wishlists.');

  if (path === '/api/catalogue' && method === 'GET') {
    return reply(res, 200, { name: user.name, wishlists, cart: cartStatus(user.id) });
  }
  if (path === '/api/cart/live' && method === 'GET') {
    if (streams.size >= 200) throw new HttpError(503, 'Cart updates are busy. Try again shortly.');
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
    const stream = { res, user, hash };
    streams.add(stream);
    res.on('close', () => streams.delete(stream));
    res.write(JSON.stringify(cartStatus(user.id)) + '\n');
    return;
  }
  if (path === '/api/logout' && method === 'POST') {
    deleteSession.run(hash);
    for (const stream of streams) {
      if (stream.hash === hash) stream.res.end();
    }
    return reply(res, 204);
  }
  if (path === '/api/cart' && method === 'POST') {
    const { itemId, action, continueAnyway } = await readJson(req);
    if (!itemIds.has(itemId) || !['add', 'remove'].includes(action)) {
      throw new HttpError(400, 'Choose a valid wishlist item.');
    }
    if (user.expires <= Date.now() || !getSession.get(hash, Date.now())) {
      throw new HttpError(401, 'Your session has ended. Sign in again.');
    }
    const result = action === 'add'
      ? insertItem.run(user.id, itemId, Number(continueAnyway === true), itemId, user.id)
      : removeItem.run(user.id, itemId);
    if (action === 'add' && !result.changes && !ownItem.get(user.id, itemId)) {
      return reply(res, 409, { error: 'This item is already in someone else’s cart.', cart: cartStatus(user.id) });
    }
    if (result.changes) {
      cartRevision += 1;
      pushStatus();
    }
    return reply(res, 200, cartStatus(user.id));
  }
  throw new HttpError(404, 'Page not found.');
}

const contentTypes = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml'
};

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (production) {
    if (req.headers['x-forwarded-proto'] !== 'https') return reply(res, 400, { error: 'HTTPS is required.' });
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/api/')) return await api(req, res, path);
    if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: 'Method not allowed.' });
    const pagePath = path.replace(/\/$/, '') || '/';
    const isPage = pages.has(pagePath) || (pagePath.endsWith('.html') && pages.has(pagePath.slice(0, -5)));
    if (!isPage && !assets.has(path)) return reply(res, 404, { error: 'Page not found.' });
    const file = isPage ? resolve(root, 'index.html') : resolve(root, '.' + path);
    const type = file.split('.').at(-1);
    const headers = { 'Content-Type': contentTypes[type] };
    if (type === 'webp' || type === 'jpg') headers['Cache-Control'] = 'public, max-age=3600';
    if (req.method === 'HEAD') {
      headers['Content-Length'] = (await stat(file)).size;
      res.writeHead(200, headers).end();
    } else {
      const body = await readFile(file);
      res.writeHead(200, headers).end(body);
    }
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    if (error instanceof HttpError) return reply(res, error.status, { error: error.message });
    if (error.code === 'ENOENT') return reply(res, 404, { error: 'Page not found.' });
    console.error(error);
    reply(res, 500, { error: 'Something went wrong. Try again shortly.' });
  }
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const { res, user } of streams) {
    if (res.writableLength > 65536) res.destroy();
    else if (user.expires <= now) res.end();
    else res.write('\n');
  }
  sweepSessions.run(now);
  sweepAttempts.run(now);
}, 15000).unref();

server.on('close', () => {
  clearInterval(heartbeat);
  db.close();
});

const port = Number(process.env.PORT ?? 3000);
server.on('error', error => {
  clearInterval(heartbeat);
  db.close();
  process.exitCode = 1;
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. If the wishlist is running, open http://127.0.0.1:${port}.`);
    console.error('If another app owns the port, set PORT to an available port and start again.');
    return;
  }
  console.error('Could not start the wishlist server.', error);
});

server.listen(port, '127.0.0.1', () => {
  console.log('Wishlist server at http://127.0.0.1:' + server.address().port);
});
