import { describe, expect, it } from 'vitest';
import { friendly, LlmHttpError, providerMessage } from '../src/errors.js';

describe('friendly', () => {
  it("does not mistake the model provider's 401 for an expired chat session", () => {
    const m = friendly(new LlmHttpError(401, 'Authentication Fails, Your api key: ****abcd is invalid'));
    expect(m).toMatch(/rejected its API key/);
    expect(m).not.toMatch(/session expired/);
    expect(m).not.toContain('abcd'); // the provider echoes part of the key
  });

  it('says an empty balance is an empty balance', () => {
    expect(friendly(new LlmHttpError(402, 'Insufficient Balance'))).toBe('The language model account is out of credit. An admin needs to top it up. The provider said: "Insufficient Balance".');
  });

  it('separates rate limits and provider outages', () => {
    expect(friendly(new LlmHttpError(429, 'Rate limit reached'))).toMatch(/rate-limiting/);
    expect(friendly(new LlmHttpError(503, '<html>bad gateway</html>'))).toBe('The language model provider is having trouble (HTTP 503). Try again shortly.');
  });

  it('still reports an expired delegation token from the gateway as a session problem', () => {
    expect(friendly(new Error('HTTP 401: invalid_token'))).toMatch(/session expired/);
  });
});

describe('providerMessage', () => {
  it('pulls the message out of an OpenAI-style error body', () => {
    expect(providerMessage('{"error":{"message":"Insufficient Balance","type":"unknown_error"}}')).toBe('Insufficient Balance');
  });
  it('falls back to the raw body, trimmed', () => {
    expect(providerMessage('upstream connect error'.repeat(20))).toHaveLength(200);
  });
});
