import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { simulatorState } from './state.js';
import { trafficSimulator } from './traffic.js';

export function createSimulatorApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Control token verification middleware
  const requireControlToken = (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env.CONTROL_TOKEN || 'dev-control-token-456';
    const authHeader = req.headers.authorization;
    const headerToken = req.headers['x-control-token'];
    const token = headerToken || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);

    if (token !== expected) {
      return res.status(401).json({ error: 'Unauthorized: invalid or missing control token' });
    }
    next();
  };

  // 1. GET /health/:service
  app.get('/health/:service', (req: Request, res: Response) => {
    const service = String(req.params.service);
    res.status(200).json({
      status: 'ok',
      service,
      timestamp: new Date().toISOString(),
    });
  });

  // 2. GET /metrics/:service
  app.get('/metrics/:service', (req: Request, res: Response) => {
    const service = String(req.params.service);
    const metrics = trafficSimulator.getMetricsForService(service);
    res.status(200).json({
      service,
      sessionId: simulatorState.getSessionId(),
      ...metrics,
    });
  });

  // 3. POST /control/reset (requires control token)
  app.post('/control/reset', requireControlToken, (_req: Request, res: Response) => {
    const newSessionId = simulatorState.resetSession();
    trafficSimulator.resetAllMetrics();
    res.status(200).json({
      status: 'reset_successful',
      sessionId: newSessionId,
    });
  });

  // 4. Stub action fix endpoint for testing intent ledger
  app.post('/control/fix/:action', requireControlToken, (req: Request, res: Response) => {
    const action = String(req.params.action);
    const scenarioRunId = (req.body?.scenarioRunId as string) || 'test-run-1';
    const attemptId = (req.body?.attemptId as string) || `attempt-${Date.now()}`;

    const applied = simulatorState.applyActionWithReceipt(scenarioRunId, action, attemptId);
    res.status(200).json({
      action,
      attemptId,
      applied,
      status: 'action_processed',
    });
  });

  return app;
}
