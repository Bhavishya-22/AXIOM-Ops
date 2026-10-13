import { z } from 'zod';

// Clean log message by stripping control characters and newlines (prevent log injection)
export function sanitizeLogMessage(msg: string): string {
  return msg.replace(/[\r\n\x00-\x1F\x7F]/g, ' ').slice(0, 1000);
}

export const LogLevelEnum = z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']);
export type LogLevel = z.infer<typeof LogLevelEnum>;

export const LogRowInputSchema = z.object({
  ts: z
    .union([z.string(), z.date(), z.number()])
    .transform((val) => new Date(val))
    .refine(
      (d) => !isNaN(d.getTime()),
      { message: 'Invalid timestamp' }
    ),
  service: z.string().min(1),
  category: z.string().optional(),
  team: z.string().optional(),
  level: LogLevelEnum,
  message: z.string().max(1000).transform(sanitizeLogMessage),
  sessionId: z.string().min(1),
  serviceSeq: z.number().int().positive(),
  origin: z.string().default('simulator'),
  serviceVersion: z.string().optional(),
  requestId: z.string().optional(),
  traceId: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
});

export type LogRowInput = z.infer<typeof LogRowInputSchema>;

export const IngestBatchSchema = z.object({
  source: z.string().min(1),
  logs: z.array(LogRowInputSchema).min(1).max(500),
});

export type IngestBatch = z.infer<typeof IngestBatchSchema>;

/**
 * Validate that log timestamps fall within [now - 5 min, now + 30 sec] window
 */
export function isTimestampInValidWindow(ts: Date, now: Date = new Date()): boolean {
  const t = ts.getTime();
  const n = now.getTime();
  const fiveMinPast = n - 5 * 60 * 1000;
  const thirtySecFuture = n + 30 * 1000;
  return t >= fiveMinPast && t <= thirtySecFuture;
}
