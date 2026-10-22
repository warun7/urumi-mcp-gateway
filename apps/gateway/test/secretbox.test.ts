import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../src/crypto/secretbox.js';

const k1 = randomBytes(32);
const k2 = randomBytes(32);

describe('SecretBox', () => {
  it('round-trips and records the key id', () => {
    const box = new SecretBox(new Map([['k1', k1]]), 'k1');
    const s = box.seal('ghp_secret', 'upstream-a');
    expect(s.kid).toBe('k1');
    expect(s.ct.toString('utf8')).not.toContain('ghp_secret');
    expect(box.open(s, 'upstream-a')).toBe('ghp_secret');
  });

  it('binds the ciphertext to its row: copied onto another upstream it fails', () => {
    const box = new SecretBox(new Map([['k1', k1]]), 'k1');
    expect(() => box.open(box.seal('ghp_secret', 'upstream-a'), 'upstream-b')).toThrow();
  });

  it('detects tampering', () => {
    const box = new SecretBox(new Map([['k1', k1]]), 'k1');
    const s = box.seal('ghp_secret', 'upstream-a');
    s.ct[0]! ^= 1;
    expect(() => box.open(s, 'upstream-a')).toThrow();
  });

  it('rotation: a box holding both keys opens old rows and seals new ones under the active key', () => {
    const before = new SecretBox(new Map([['k1', k1]]), 'k1').seal('ghp_secret', 'u');
    const during = new SecretBox(new Map([['k1', k1], ['k2', k2]]), 'k2');
    const resealed = during.seal(during.open(before, 'u'), 'u');
    expect(resealed.kid).toBe('k2');
    const after = new SecretBox(new Map([['k2', k2]]), 'k2');
    expect(after.open(resealed, 'u')).toBe('ghp_secret');
    expect(() => after.open(before, 'u')).toThrow(/unknown key id k1/);
  });
});
