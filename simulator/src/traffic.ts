import { simulatorState } from './state.js';
import { SERVICES } from '@axiomops/shared';

export interface ServiceMetrics {
  requestsTotal: number;
  successesTotal: number;
  errorsTotal: number;
  businessOutcomesTotal: number;
  cacheHitsTotal: number;
  cacheLookupsTotal: number;
  gauges: Record<string, number>;
  latencyBuckets: Record<string, number>;
  scenarioCounters: Record<string, number>;
}

export interface SimulatorLogRow {
  ts: string;
  service: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  message: string;
  sessionId: string;
  serviceSeq: number;
  origin: string;
  // NEVER include signal or signalKind!
}

export class TrafficSimulator {
  private metrics: Map<string, ServiceMetrics> = new Map();
  private logBuffer: SimulatorLogRow[] = [];
  private trafficTimer: NodeJS.Timeout | null = null;
  private ingestTimer: NodeJS.Timeout | null = null;
  private ingestUrl: string;
  private ingestToken: string;

  constructor(
    ingestUrl: string = process.env.BACKEND_INGEST_URL || 'http://localhost:3000/ingest',
    ingestToken: string = process.env.INGEST_TOKEN || 'dev-ingest-token-123'
  ) {
    this.ingestUrl = ingestUrl;
    this.ingestToken = ingestToken;
    this.initMetrics();
  }

  public initMetrics(): void {
    for (const service of Object.keys(SERVICES)) {
      this.metrics.set(service, {
        requestsTotal: 0,
        successesTotal: 0,
        errorsTotal: 0,
        businessOutcomesTotal: 0,
        cacheHitsTotal: 0,
        cacheLookupsTotal: 0,
        gauges: {
          poolWait: service === 'orders-db' ? 2 : 0,
          activeConnections: service === 'orders-db' ? 6 : 0,
        },
        latencyBuckets: {
          le_50: 0,
          le_100: 0,
          le_250: 0,
          le_500: 0,
          le_1000: 0,
          le_2500: 0,
          le_Inf: 0,
        },
        scenarioCounters: {
          dbFallbackQueriesTotal: 0,
          authorizationsNewRouteTotal: 0,
          tokenValidationsOkTotal: 0,
          duplicateChargesTotal: 0,
          inflightStatusChecksTotal: 0,
        },
      });
    }
  }

  public getMetricsForService(service: string): ServiceMetrics {
    let m = this.metrics.get(service);
    if (!m) {
      m = {
        requestsTotal: 0,
        successesTotal: 0,
        errorsTotal: 0,
        businessOutcomesTotal: 0,
        cacheHitsTotal: 0,
        cacheLookupsTotal: 0,
        gauges: {},
        latencyBuckets: { le_50: 0, le_100: 0, le_250: 0, le_500: 0, le_1000: 0, le_2500: 0, le_Inf: 0 },
        scenarioCounters: {
          dbFallbackQueriesTotal: 0,
          authorizationsNewRouteTotal: 0,
          tokenValidationsOkTotal: 0,
          duplicateChargesTotal: 0,
          inflightStatusChecksTotal: 0,
        },
      };
      this.metrics.set(service, m);
    }
    return m;
  }

  private recordLatency(m: ServiceMetrics, latencyMs: number): void {
    const b = m.latencyBuckets;
    if (latencyMs <= 50) b.le_50++;
    if (latencyMs <= 100) b.le_100++;
    if (latencyMs <= 250) b.le_250++;
    if (latencyMs <= 500) b.le_500++;
    if (latencyMs <= 1000) b.le_1000++;
    if (latencyMs <= 2500) b.le_2500++;
    b.le_Inf++;
  }

  private emitLog(service: string, level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string): void {
    const sessionId = simulatorState.getSessionId();
    const serviceSeq = simulatorState.nextServiceSeq(service);

    this.logBuffer.push({
      ts: new Date().toISOString(),
      service,
      level,
      message,
      sessionId,
      serviceSeq,
      origin: 'simulator',
    });
  }

  /**
   * Simulate a single request outcome for a service.
   */
  public simulateRequest(service: 'checkout' | 'payments'): void {
    const m = this.getMetricsForService(service);
    m.requestsTotal++;

    // Random business outcome (~2%): card decline or token invalid
    const isBusinessOutcome = Math.random() < 0.02;

    if (isBusinessOutcome) {
      m.successesTotal++;
      m.businessOutcomesTotal++;
      this.recordLatency(m, 25);

      if (service === 'payments') {
        this.emitLog('payments', 'INFO', 'card declined: customer insufficient funds on transaction');
      } else {
        this.emitLog('checkout', 'INFO', 'token expired for session request, redirecting to login');
      }
    } else {
      // Normal technical success (98%)
      m.successesTotal++;
      if (service === 'checkout') {
        m.cacheHitsTotal += 1;
        m.cacheLookupsTotal += 1;
        this.recordLatency(m, 35);
        this.emitLog('checkout', 'INFO', 'checkout request processed successfully with 200 OK');
      } else {
        this.recordLatency(m, 45);
        this.emitLog('payments', 'INFO', 'payment captured successfully for authorization intent');
      }
    }
  }

  public simulateHealthPings(): void {
    // Health pings (INFO) for support services
    this.emitLog('redis-cache', 'INFO', 'ping ok');
    this.emitLog('orders-db', 'INFO', 'health check ok, connection pool available');
    this.emitLog('identity-provider', 'INFO', 'idp token validator health check ok');
    this.emitLog('payment-gateway', 'INFO', 'payment gateway health check ok');
  }

  public startTraffic(): void {
    if (this.trafficTimer) return;

    // Tick every ~300ms to produce ~3-5 logs per second
    let tickCount = 0;
    this.trafficTimer = setInterval(() => {
      tickCount++;

      // checkout request ~1/s (every 3 ticks)
      if (tickCount % 3 === 0) {
        this.simulateRequest('checkout');
      }

      // payments request ~1/s (every 3 ticks, staggered)
      if (tickCount % 3 === 1) {
        this.simulateRequest('payments');
      }

      // health pings every 3s (every 10 ticks)
      if (tickCount % 10 === 0) {
        this.simulateHealthPings();
      }

      // occasional harmless warning every 15s
      if (tickCount % 50 === 0) {
        this.emitLog('checkout', 'WARN', 'routine cache eviction on cold item');
      }
    }, 300);

    // Flush logs every 2s
    this.ingestTimer = setInterval(async () => {
      await this.flushLogsToBackend();
    }, 2000);
  }

  public stopTraffic(): void {
    if (this.trafficTimer) {
      clearInterval(this.trafficTimer);
      this.trafficTimer = null;
    }
    if (this.ingestTimer) {
      clearInterval(this.ingestTimer);
      this.ingestTimer = null;
    }
  }

  public async flushLogsToBackend(): Promise<void> {
    if (this.logBuffer.length === 0) return;

    const batch = [...this.logBuffer];
    this.logBuffer = [];

    try {
      const response = await fetch(this.ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.ingestToken}`,
        },
        body: JSON.stringify({
          source: 'simulator',
          logs: batch,
        }),
      });

      if (!response.ok) {
        console.warn(`[Simulator] Batch ingest returned status ${response.status}`);
      }
    } catch {
      // Backend may be starting up; buffer drops gracefully
    } finally {
      simulatorState.persistSeqState();
    }
  }

  public resetAllMetrics(): void {
    this.initMetrics();
    this.logBuffer = [];
  }
}

export const trafficSimulator = new TrafficSimulator();
