import 'dotenv/config';
import { createSimulatorApp } from './server.js';
import { simulatorState } from './state.js';
import { trafficSimulator } from './traffic.js';

const app = createSimulatorApp();
const PORT = process.env.PORT || 4000;

// Startup reconciliation for intent ledger
simulatorState.reconcileOnStartup();

// Start healthy traffic generation
trafficSimulator.startTraffic();

const server = app.listen(PORT, () => {
  console.log(`[Simulator Engine] Listening on http://localhost:${PORT}`);
});

export { app, server };
