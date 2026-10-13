import 'dotenv/config';
import { createServer } from './server.js';
import { startRetentionJob } from './retention.js';
import { startMetricPoller } from './metric-poller.js';

const app = createServer();
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`[AxiomOps Backend] Listening on http://localhost:${PORT}`);

  // Start background processes
  startRetentionJob();
  startMetricPoller();
});

export { app, server };
