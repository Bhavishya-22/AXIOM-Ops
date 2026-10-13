import 'dotenv/config';
import { createServer } from './server.js';
import { startRetentionJob } from './retention.js';
import { startMetricPoller } from './metric-poller.js';
import { incidentDetector } from './detector.js';
import { startupInvestigationSweep } from './investigation-pipeline.js';
import { seedHistoricalCases } from './history.js';

const app = createServer();
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, async () => {
  console.log(`[AxiomOps Backend] Listening on http://localhost:${PORT}`);

  try {
    // 1. Sweep stale running investigations
    const swept = await startupInvestigationSweep();
    if (swept > 0) {
      console.log(`[AxiomOps Backend] Startup sweep: failed ${swept} stale running investigations.`);
    }

    // 2. Seed verified historical cases
    await seedHistoricalCases();
  } catch (err) {
    console.error('[AxiomOps Backend] Startup tasks error:', err);
  }

  // 3. Start background processes
  startRetentionJob();
  startMetricPoller();
  incidentDetector.start();
});

export { app, server };
