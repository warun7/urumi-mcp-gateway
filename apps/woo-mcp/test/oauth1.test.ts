import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pct, signOAuth1 } from '../src/woo/oauth1.js';

describe('pct (RFC 3986 encoding)', () => {
  it('encodes the characters encodeURIComponent leaves alone', () => {
    expect(pct("!*'()")).toBe('%21%2A%27%28%29');
  });
  it('keeps unreserved characters and encodes space as %20', () => {
    expect(pct('a-b.c_d~e f')).toBe('a-b.c_d~e%20f');
  });
});

describe('signOAuth1', () => {
  const base = {
    method: 'GET',
    baseUrl: 'http://shop.example/wp-json/wc/v3/orders',
    query: { after: '2026-10-09T23:59:59', per_page: '20' },
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    nonce: 'abc',
    timestamp: 1700000000,
  };

  it('matches a hand-built RFC 5849 base string (values with ":" are double-encoded in the base string)', () => {
    // Written out by hand, not by the code under test.
    const baseString =
      'GET&http%3A%2F%2Fshop.example%2Fwp-json%2Fwc%2Fv3%2Forders&' +
      'after%3D2026-10-09T23%253A59%253A59%26oauth_consumer_key%3Dck_test%26oauth_nonce%3Dabc%26' +
      'oauth_signature_method%3DHMAC-SHA256%26oauth_timestamp%3D1700000000%26per_page%3D20';
    const expected = createHmac('sha256', 'cs_test&').update(baseString).digest('base64');
    expect(signOAuth1(base).oauth_signature).toBe(expected);
  });

  it('returns the query plus all oauth_* params', () => {
    const out = signOAuth1(base);
    expect(Object.keys(out).sort()).toEqual(
      ['after', 'oauth_consumer_key', 'oauth_nonce', 'oauth_signature', 'oauth_signature_method', 'oauth_timestamp', 'per_page'],
    );
  });

  it('depends on the host: signing the Service URL gives a different signature (why we sign with the home URL)', () => {
    const a = signOAuth1(base).oauth_signature;
    const b = signOAuth1({ ...base, baseUrl: 'http://wordpress:8080/wp-json/wc/v3/orders' }).oauth_signature;
    expect(a).not.toBe(b);
  });

  it('uses a fresh nonce by default', () => {
    const { nonce: _n, ...rest } = base;
    expect(signOAuth1(rest).oauth_nonce).not.toBe(signOAuth1(rest).oauth_nonce);
  });
});
