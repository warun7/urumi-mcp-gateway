import { pino } from 'pino';

export const createLogger = (level: string) =>
  pino({
    level,
    base: { svc: 'provisioner' },
    redact: { paths: ['*.token', '*.password', 'token', 'password', 'headers.authorization'], censor: '[redacted]' },
  });
export type Logger = ReturnType<typeof createLogger>;
