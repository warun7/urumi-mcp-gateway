import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// OWASP Password Storage Cheat Sheet: scrypt N=2^17, r=8, p=1. Needs ~128 MiB, hence maxmem.
const N = 2 ** 17, r = 8, p = 1, KEYLEN = 32, MAXMEM = 256 * 1024 * 1024;

const derive = (password: string, salt: Buffer, n = N, rr = r, pp = p) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r: rr, p: pp, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** Self-describing format so parameters can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, rr, pp, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(rr), Number(pp));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A precomputed hash so "unknown email" takes as long as "wrong password" (no user enumeration by timing). */
let dummy: string | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummy);
}
