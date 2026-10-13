import { prisma } from './prisma.js';

interface MissingSeqRecord {
  service: string;
  source: string;
  sessionId: string;
  seq: number;
  detectedAt: number;
  ts: Date;
}

export class GapTracker {
  private highestSeq = new Map<string, number>(); // key: `${source}:${sessionId}:${service}` -> maxSeq
  private pendingMissing = new Map<string, MissingSeqRecord>(); // key: `${source}:${sessionId}:${service}:${seq}` -> record
  private readonly reorderWindowMs: number;

  constructor(reorderWindowMs: number = 10000) {
    this.reorderWindowMs = reorderWindowMs;
  }

  private makeKey(source: string, sessionId: string, service: string): string {
    return `${source}:${sessionId}:${service}`;
  }

  /**
   * Process a sequence number for a given service and track gaps.
   */
  public async trackSequence(
    source: string,
    sessionId: string,
    service: string,
    seq: number,
    logTs: Date
  ): Promise<void> {
    const key = this.makeKey(source, sessionId, service);
    const pendingKey = `${key}:${seq}`;

    // If this sequence was previously recorded as missing, it arrived out-of-order within tolerance!
    if (this.pendingMissing.has(pendingKey)) {
      this.pendingMissing.delete(pendingKey);
    }

    const currentMax = this.highestSeq.get(key) ?? 0;

    if (seq > currentMax + 1) {
      // Detected potential gap for sequences in (currentMax, seq)
      const now = Date.now();
      for (let missing = currentMax + 1; missing < seq; missing++) {
        const mKey = `${key}:${missing}`;
        if (!this.pendingMissing.has(mKey)) {
          this.pendingMissing.set(mKey, {
            service,
            source,
            sessionId,
            seq: missing,
            detectedAt: now,
            ts: logTs,
          });
        }
      }
      this.highestSeq.set(key, seq);
    } else if (seq > currentMax) {
      this.highestSeq.set(key, seq);
    }

    // Flush any pending missing sequences that exceeded the reorder window
    await this.flushExpiredGaps();
  }

  /**
   * Check for any missing sequences older than reorderWindowMs and write IngestGap records.
   */
  public async flushExpiredGaps(): Promise<void> {
    const now = Date.now();
    const expiredByGroup = new Map<string, { service: string; source: string; minTs: Date; maxTs: Date }>();

    for (const [key, record] of Array.from(this.pendingMissing.entries())) {
      if (now - record.detectedAt >= this.reorderWindowMs) {
        this.pendingMissing.delete(key);

        const groupKey = `${record.source}:${record.service}`;
        const existing = expiredByGroup.get(groupKey);
        if (!existing) {
          expiredByGroup.set(groupKey, {
            service: record.service,
            source: record.source,
            minTs: record.ts,
            maxTs: record.ts,
          });
        } else {
          if (record.ts < existing.minTs) existing.minTs = record.ts;
          if (record.ts > existing.maxTs) existing.maxTs = record.ts;
        }
      }
    }

    for (const group of Array.from(expiredByGroup.values())) {
      await prisma.ingestGap.create({
        data: {
          source: group.source,
          services: [group.service],
          fromTs: group.minTs,
          toTs: group.maxTs,
          reason: 'missing_sequence',
        },
      });
    }
  }

  /**
   * Record a rejected batch gap affecting all services of the source.
   */
  public async recordRejectedBatch(source: string): Promise<void> {
    const now = new Date();
    await prisma.ingestGap.create({
      data: {
        source,
        services: ['*'],
        fromTs: new Date(now.getTime() - 5000),
        toTs: now,
        reason: 'rejected_batch',
      },
    });
  }

  /**
   * Reset tracking state (useful for tests or session resets).
   */
  public reset(): void {
    this.highestSeq.clear();
    this.pendingMissing.clear();
  }
}

export const gapTracker = new GapTracker();
