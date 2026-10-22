import { pino } from 'pino';

/**
 * Redaction is a safety net, not the plan: code never logs credentials on purpose.
 * These paths catch accidents (e.g. logging a whole request or upstream row).
 */
export const createLogger = (level: string) =>
  pino({
    level,
    base: { svc: 'gateway' },
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie',
        '*.password', '*.credential', '*.token', '*.secret', '*.apiKey', 'credential', 'password', 'token',
      ],
      censor: '[redacted]',
    },
  });
export type Logger = ReturnType<typeof createLogger>;
