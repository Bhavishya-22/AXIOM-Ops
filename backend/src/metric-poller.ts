import { prisma } from './prisma.js';
import { SERVICES } from '@axiomops/shared';

export interface ServiceMetricsPayload {
  service: string;
  sessionId: string;
  requestsTotal: number;
  successesTotal: number;
  errorsTotal: number;
  businessOutcomesTotal: number;
  cacheHitsTotal?: number;
  cacheLookupsTotal?: number;
  gauges?: Record<string, unknown>;
  latencyBuckets?: Record<string, number>;
  scenarioCounters?: Record<string, number>;
}

export async function pollServiceMetrics(
  service: string,
  simulatorBaseUrl: string = process.env.SIMULATOR_URL || 'http://localhost:4000'
): Promise<void> {
  const url = `${simulatorBaseUrl}/metrics/${service}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(2500),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch metrics from ${url}: status ${response.status}`);
  }

  const data = (await response.json()) as ServiceMetricsPayload;

  await prisma.metricSample.create({
    data: {
      ts: new Date(),
      sessionId: data.sessionId,
      service: data.service || service,
      requestsTotal: data.requestsTotal,
      successesTotal: data.successesTotal,
      errorsTotal: data.errorsTotal,
      businessOutcomesTotal: data.businessOutcomesTotal,
      cacheHitsTotal: data.cacheHitsTotal ?? 0,
      cacheLookupsTotal: data.cacheLookupsTotal ?? 0,
      gauges: (data.gauges as object) ?? null,
      latencyBucketsJson: (data.latencyBuckets as object) ?? null,
      scenarioCountersJson: (data.scenarioCounters as object) ?? null,
    },
  });
}

export async function pollAllServicesMetrics(
  simulatorBaseUrl?: string
): Promise<void> {
  const serviceList = Object.keys(SERVICES);
  await Promise.allSettled(
    serviceList.map((svc) => pollServiceMetrics(svc, simulatorBaseUrl).catch(() => {}))
  );
}

let pollerTimer: NodeJS.Timeout | null = null;

export function startMetricPoller(
  intervalMs: number = 3000,
  simulatorBaseUrl?: string
): void {
  if (pollerTimer) return;

  pollerTimer = setInterval(async () => {
    try {
      await pollAllServicesMetrics(simulatorBaseUrl);
    } catch {
      // Simulator may not be active; continue polling quietly
    }
  }, intervalMs);
}

export function stopMetricPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
}
