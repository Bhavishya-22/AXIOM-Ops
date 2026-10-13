import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { sanitizeMessage, redactSecrets, computeMessageHash } from '../redaction.js';
import { gapTracker } from '../gap-tracker.js';
import { matchSignal, SERVICES } from '@axiomops/shared';

export const ingestRouter = Router();

const LogItemSchema = z.object({
  ts: z.union([z.string(), z.number(), z.date()]).transform((val) => new Date(val)),
  service: z.string().min(1),
  category: z.string().optional(),
  team: z.string().optional(),
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']),
  message: z.string().max(1000),
  sessionId: z.string().min(1),
  serviceSeq: z.number().int().positive(),
  origin: z.string().default('simulator'),
  serviceVersion: z.string().optional(),
  requestId: z.string().optional(),
  traceId: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
  // Ignore any incoming signal fields
  signal: z.unknown().optional(),
  signalKind: z.unknown().optional(),
});

const IngestPayloadSchema = z.object({
  source: z.string().min(1),
  logs: z.array(LogItemSchema).min(1).max(500),
});

const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB

ingestRouter.post('/', async (req: Request, res: Response) => {
  // 1. Authenticate Ingest Token
  const expectedToken = process.env.INGEST_TOKEN;
  const authHeader = req.headers.authorization;
  const headerToken = req.headers['x-ingest-token'];
  const providedToken = headerToken || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);

  if (!expectedToken || providedToken !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid ingest token' });
  }

  const rawSource = typeof req.body?.source === 'string' ? req.body.source : 'simulator';

  // 2. Validate payload size
  const rawBodySize = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
  if (rawBodySize > MAX_PAYLOAD_BYTES) {
    await gapTracker.recordRejectedBatch(rawSource);
    return res.status(400).json({ error: 'Payload exceeds maximum size limit of 256 KB' });
  }

  // 3. Validate Zod Schema
  const parseResult = IngestPayloadSchema.safeParse(req.body);
  if (!parseResult.success) {
    await gapTracker.recordRejectedBatch(rawSource);
    return res.status(400).json({ error: 'Invalid batch payload schema', details: parseResult.error.format() });
  }

  const { source, logs } = parseResult.data;

  // 4. Validate timestamp bounds: within 5 minutes past and 30 seconds future
  const now = Date.now();
  const minTs = now - 5 * 60 * 1000;
  const maxTs = now + 30 * 1000;

  for (const log of logs) {
    const time = log.ts.getTime();
    if (isNaN(time) || time < minTs || time > maxTs) {
      await gapTracker.recordRejectedBatch(source);
      return res.status(400).json({
        error: `Timestamp out of acceptable window [now - 5m, now + 30s]: ${log.ts.toISOString()}`,
      });
    }
  }

  // 5. Retention configuration
  const routineMs = (parseInt(process.env.ROUTINE_RETENTION_MINUTES || '30', 10)) * 60 * 1000;
  const notableMs = (parseInt(process.env.NOTABLE_RETENTION_HOURS || '24', 10)) * 60 * 60 * 1000;

  // 6. Process logs with backend-only signal tagging and secret redaction
  const logsToInsert = [];

  for (const item of logs) {
    const sanitized = sanitizeMessage(item.message);
    const redacted = redactSecrets(sanitized);
    const messageHash = computeMessageHash(redacted);

    // Backend-only signal tagging from shared SIGNAL_RULES
    const matched = matchSignal(item.service, sanitized);
    const signal = matched?.signal ?? null;
    const signalKind = matched?.kind ?? null;

    // Category and Team fallback from shared SERVICES definition if omitted
    const serviceDef = SERVICES[item.service];
    const category = item.category || serviceDef?.category || 'general';
    const team = item.team || serviceDef?.team || 'Core';

    // Retention class assignment
    const isRoutine = item.level === 'INFO' && !signal;
    const retentionClass = isRoutine ? 'routine' : 'notable';
    const expiresAt = new Date(now + (isRoutine ? routineMs : notableMs));

    logsToInsert.push({
      ts: item.ts,
      service: item.service,
      category,
      team,
      level: item.level,
      message: redacted,
      signal,
      signalKind,
      ruleVersion: '2026-10-r3',
      messageHash,
      sessionId: item.sessionId,
      serviceSeq: item.serviceSeq,
      class: retentionClass,
      expiresAt,
      pinnedByIncidentId: null,
      serviceVersion: item.serviceVersion ?? null,
      requestId: item.requestId ?? null,
      traceId: item.traceId ?? null,
      origin: item.origin || source,
      meta: (item.meta as object) ?? null,
    });

    // Track sequence and detect missing gaps
    await gapTracker.trackSequence(source, item.sessionId, item.service, item.serviceSeq, item.ts);
  }

  // 7. Idempotent database insert
  try {
    const result = await prisma.log.createMany({
      data: logsToInsert,
      skipDuplicates: true,
    });

    const accepted = result.count;
    const duplicates = logsToInsert.length - accepted;

    return res.status(200).json({
      accepted,
      duplicates,
      gapsCreated: 0,
    });
  } catch (err: unknown) {
    console.error('Failed to insert logs:', err);
    await gapTracker.recordRejectedBatch(source);
    return res.status(500).json({ error: 'Internal server error while inserting logs' });
  }
});
