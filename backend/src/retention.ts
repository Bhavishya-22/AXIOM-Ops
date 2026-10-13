import { prisma } from './prisma.js';

export async function runRetentionCleanup(): Promise<{ deletedCount: number }> {
  const now = new Date();

  // Delete expired rows that are NOT pinned by any incident
  // Pinned rows must survive regardless of expiration timestamp
  const result = await prisma.log.deleteMany({
    where: {
      pinnedByIncidentId: null,
      expiresAt: {
        lte: now,
      },
    },
  });

  return { deletedCount: result.count };
}

let retentionTimer: NodeJS.Timeout | null = null;

export function startRetentionJob(intervalMs: number = 3 * 60 * 1000): void {
  if (retentionTimer) return;

  retentionTimer = setInterval(async () => {
    try {
      const { deletedCount } = await runRetentionCleanup();
      if (deletedCount > 0) {
        console.log(`[Retention] Purged ${deletedCount} expired unpinned log rows.`);
      }
    } catch (err) {
      console.error('[Retention] Error during retention cleanup:', err);
    }
  }, intervalMs);
}

export function stopRetentionJob(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
