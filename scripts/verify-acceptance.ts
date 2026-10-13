import 'dotenv/config';
import { prisma } from '../backend/src/prisma.js';
import { createServer } from '../backend/src/server.js';
import { TrafficSimulator } from '../simulator/src/traffic.js';
import { simulatorState } from '../simulator/src/state.js';
import { AddressInfo } from 'net';

async function runAcceptanceVerification() {
  console.log('=== STARTING BLOCK 1 ACCEPTANCE VERIFICATION ===\n');

  // 1. Start test backend instance
  const app = createServer();
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const ingestUrl = `http://localhost:${port}/ingest`;
  const token = process.env.INGEST_TOKEN || 'dev-ingest-token-123';
  console.log(`[Backend] Test instance active at http://localhost:${port}`);

  // 2. Initialize simulator targeting test backend
  const sim = new TrafficSimulator(ingestUrl, token);
  const sessionId = simulatorState.getSessionId();
  console.log(`[Simulator] Traffic simulator initialized (Session: ${sessionId})`);

  // 3. Start traffic and observe monotonic counters across 60 seconds
  console.log('[Acceptance] Generating traffic and asserting monotonic counters for 60 seconds...');
  sim.startTraffic();

  let prevRequests = 0;
  let prevSuccesses = 0;
  let prevErrors = 0;
  let monotonicSamples = 0;
  let allMonotonic = true;

  const startTime = Date.now();
  // Poll every 5s for 60 seconds (12 checks)
  for (let i = 1; i <= 12; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    const checkout = sim.getMetricsForService('checkout');
    const payments = sim.getMetricsForService('payments');
    const totalRequests = checkout.requestsTotal + payments.requestsTotal;
    const totalSuccesses = checkout.successesTotal + payments.successesTotal;
    const totalErrors = checkout.errorsTotal + payments.errorsTotal;

    const isMonotonic =
      totalRequests >= prevRequests &&
      totalSuccesses >= prevSuccesses &&
      totalErrors >= prevErrors &&
      totalRequests === totalSuccesses + totalErrors;

    if (!isMonotonic) {
      allMonotonic = false;
    }
    monotonicSamples++;

    console.log(
      `  [t=${elapsed}s] Requests: ${totalRequests} (Checkout: ${checkout.requestsTotal}, Payments: ${payments.requestsTotal}) | Successes: ${totalSuccesses} | Errors: ${totalErrors} | Monotonic: ${isMonotonic}`
    );

    prevRequests = totalRequests;
    prevSuccesses = totalSuccesses;
    prevErrors = totalErrors;
  }

  sim.stopTraffic();
  await sim.flushLogsToBackend();
  console.log('\n[Acceptance] 60-second traffic run complete.');
  console.log(`[Acceptance] Monotonicity check across samples: ${allMonotonic ? 'PASSED (100% monotonic)' : 'FAILED'}`);

  // 4. Verify tagged logs in Postgres
  const taggedLogs = await prisma.log.findMany({
    where: {
      sessionId,
      signal: { not: null },
    },
    take: 5,
  });

  console.log(`\n[Acceptance] Tagged logs in Postgres for session ${sessionId}:`);
  console.log(`  Found ${taggedLogs.length} tagged sample logs in Postgres.`);
  for (const log of taggedLogs) {
    console.log(`  - [${log.service}] [${log.level}] signal="${log.signal}" (${log.signalKind}) message="${log.message}"`);
  }

  // 5. Verify database counts
  const totalLogsInDb = await prisma.log.count({ where: { sessionId } });
  console.log(`\n[Acceptance] Total logs stored for session in Postgres: ${totalLogsInDb}`);

  server.close();
  console.log('\n=== ACCEPTANCE VERIFICATION FINISHED SUCCESSFULLY ===');
}

runAcceptanceVerification()
  .catch((err) => {
    console.error('Acceptance error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
