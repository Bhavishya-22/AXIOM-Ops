import { prisma } from './prisma.js';
import { createIncidentTransaction } from './incident-lifecycle.js';
import { SERVICES } from '@axiomops/shared';

export class IncidentDetector {
  private consecutiveBreaches = new Map<string, number>(); // key: `${sessionId}:${service}` -> breachCount
  private serviceCooldowns = new Map<string, number>(); // key: `${sessionId}:${service}` -> timestampMs
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number = 10000;
  private isEvaluating: boolean = false;

  public async evaluateOnce(targetSessionId?: string): Promise<{ breached: boolean; service?: string }> {
    if (this.isEvaluating) return { breached: false };
    this.isEvaluating = true;

    try {
      // Find latest sessionId if not explicitly provided
      let sessionId = targetSessionId;
      if (!sessionId) {
        const latestSample = await prisma.metricSample.findFirst({
          orderBy: { ts: 'desc' },
          select: { sessionId: true },
        });
        sessionId = latestSample?.sessionId;
      }

      if (!sessionId) {
        return { breached: false };
      }

      // Check if an open incident already exists
      const existingOpen = await prisma.incident.findFirst({
        where: { openSlot: 1 },
      });
      if (existingOpen) {
        return { breached: false };
      }

      const now = new Date();
      const sixtySecAgo = new Date(now.getTime() - 60000);

      // Check each service in registry
      for (const service of Object.keys(SERVICES)) {
        const cooldownKey = `${sessionId}:${service}`;
        const lastCooldown = this.serviceCooldowns.get(cooldownKey) ?? 0;
        if (now.getTime() - lastCooldown < 5 * 60 * 1000) {
          // Cooldown active for this service in this session
          continue;
        }

        // Fetch earliest and latest samples within last 60s
        const earliest = await prisma.metricSample.findFirst({
          where: {
            sessionId,
            service,
            ts: { gte: sixtySecAgo },
          },
          orderBy: { ts: 'asc' },
        });

        const latest = await prisma.metricSample.findFirst({
          where: {
            sessionId,
            service,
            ts: { gte: sixtySecAgo },
          },
          orderBy: { ts: 'desc' },
        });

        if (!earliest || !latest || earliest.id === latest.id) {
          continue;
        }

        const requestsDelta = latest.requestsTotal - earliest.requestsTotal;
        const errorsDelta = latest.errorsTotal - earliest.errorsTotal;

        // Condition: >= 10 requests in window and technical error rate >= 20%
        if (requestsDelta >= 10) {
          const errorRate = errorsDelta / requestsDelta;
          if (errorRate >= 0.20) {
            const currentBreaches = (this.consecutiveBreaches.get(cooldownKey) ?? 0) + 1;
            this.consecutiveBreaches.set(cooldownKey, currentBreaches);

            // Requires TWO consecutive breaches
            if (currentBreaches >= 2) {
              console.log(
                `[Detector] TWO consecutive breaches detected on service '${service}' (Error Rate: ${(errorRate * 100).toFixed(1)}%, Requests: ${requestsDelta}). Triggering incident.`
              );

              // Set cooldown
              this.serviceCooldowns.set(cooldownKey, now.getTime());
              this.consecutiveBreaches.delete(cooldownKey);

              // Capture baseline metrics if available
              const baselineSamples = await prisma.metricSample.findMany({
                where: {
                  sessionId,
                  ts: { lte: sixtySecAgo },
                },
                take: 10,
                orderBy: { ts: 'desc' },
              });

              // Create Incident, auto-ticket and auto-investigation
              const incidentResult = await createIncidentTransaction({
                sessionId,
                services: [service, 'checkout'],
                detectedAt: now,
                baselineMetricsJson: baselineSamples,
              });

              // Trigger background investigation
              if (!incidentResult.isExisting && incidentResult.investigation) {
                // Background investigation execution hook
                const { runInvestigationPipeline } = await import('./investigation-pipeline.js');
                runInvestigationPipeline(incidentResult.investigation.id).catch((e) =>
                  console.error('[Detector] Background investigation error:', e)
                );
              }

              return { breached: true, service };
            }
          } else {
            this.consecutiveBreaches.delete(cooldownKey);
          }
        }
      }

      return { breached: false };
    } finally {
      this.isEvaluating = false;
    }
  }

  public start(): void {
    const mode = process.env.DETECTOR_MODE || 'A';
    if (mode === 'B') {
      console.log('[Detector] Mode B active (Manual benchmark). Automatic detection is disabled.');
      return;
    }

    if (this.timer) return;

    this.timer = setInterval(async () => {
      try {
        await this.evaluateOnce();
      } catch (err) {
        console.error('[Detector] Evaluation error:', err);
      }
    }, this.intervalMs);

    console.log('[Detector] Mode A active. Polling technical error rates every 10s.');
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public resetCooldowns(): void {
    this.consecutiveBreaches.clear();
    this.serviceCooldowns.clear();
  }
}

export const incidentDetector = new IncidentDetector();
