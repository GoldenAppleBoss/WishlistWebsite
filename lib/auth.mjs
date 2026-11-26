import { createHash, createHmac, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
let activeDerivations = 0;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizeDisplayName(name) {
  const displayName = typeof name === 'string' ? name.normalize('NFKC').trim().replace(/ +/g, ' ') : '';
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\p{M} _.'’-]{1,31}$/u.test(displayName)) {
    throw new HttpError(400, 'Enter a display name of 2–32 characters.');
  }
  return displayName;
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function passwordHash(key, salt) {
  if (activeDerivations >= 3) throw new HttpError(503, 'Sign-in is busy. Try again shortly.');
  activeDerivations += 1;
  try {
    return await deriveKey(key, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
  } finally {
    activeDerivations -= 1;
  }
}

export async function readPasswordKey(body, pepper) {
  const hmac = createHmac('sha256', pepper);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let characters = 0;
  function count(text) {
    if (characters >= 4) return;
    for (const character of text) {
      characters += 1;
      if (characters === 4) return;
    }
  }
  try {
    for await (const chunk of body) {
      hmac.update(chunk);
      count(decoder.decode(chunk, { stream: true }));
    }
    count(decoder.decode());
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new HttpError(400, 'Enter a valid password.');
  }
  if (characters < 4) throw new HttpError(400, 'Enter a password of at least 4 characters.');
  return hmac.digest();
}
