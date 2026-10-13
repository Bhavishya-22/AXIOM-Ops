import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { simulatorState } from './state.js';
import { trafficSimulator } from './traffic.js';
import { scenarioEngine } from './engine.js';

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

  // 3. POST /control/trigger/:scenario
  app.post('/control/trigger/:scenario', requireControlToken, (req: Request, res: Response) => {
    const scenario = String(req.params.scenario);
    const skipBaselineCheck = req.query.skipBaselineCheck === 'true' || req.body?.skipBaselineCheck === true;

    try {
      const result = scenarioEngine.trigger(scenario, skipBaselineCheck);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 4. POST /control/fix/:action (supports ?mode=broken in dev)
  app.post('/control/fix/:action', requireControlToken, (req: Request, res: Response) => {
    const action = String(req.params.action);
    const scenarioRunId = (req.body?.scenarioRunId as string) || scenarioEngine.getCurrentRunId() || 'run-default';
    const attemptId = (req.body?.attemptId as string) || `attempt-${Date.now()}`;
    const brokenMode = req.query.mode === 'broken' || req.body?.mode === 'broken';

    const applied = scenarioEngine.fix(action, attemptId, brokenMode);
    res.status(200).json({
      action,
      attemptId,
      scenarioRunId,
      applied,
      mode: brokenMode ? 'broken' : 'normal',
      status: brokenMode ? 'fix_applied_mode_broken' : 'fix_applied',
    });
  });

  // 5. GET /control/fix-status/:runId/:action
  app.get('/control/fix-status/:runId/:action', requireControlToken, (req: Request, res: Response) => {
    const action = String(req.params.action);
    const ledger = simulatorState.loadLedger();

    // Find latest matching entry in ledger
    const matching = Object.values(ledger).find((e) => e.actionId === action);
    if (!matching) {
      return res.status(404).json({ error: 'Fix action record not found' });
    }

    res.status(200).json({
      scenarioRunId: req.params.runId,
      action: matching.actionId,
      attemptId: matching.attemptId,
      state: matching.state,
      updatedAt: matching.updatedAt,
    });
  });

  // 6. POST /control/reset (requires control token)
  app.post('/control/reset', requireControlToken, (_req: Request, res: Response) => {
    const newSessionId = simulatorState.resetSession();
    scenarioEngine.clearActiveScenario();
    scenarioEngine.resetBaseline();
    trafficSimulator.resetAllMetrics();

    res.status(200).json({
      status: 'reset_successful',
      sessionId: newSessionId,
    });
  });

  // 7. GET /control/ground-truth (localhost, NODE_ENV=dev only)
  app.get('/control/ground-truth', requireControlToken, (req: Request, res: Response) => {
    const isDev = process.env.NODE_ENV === 'dev' || process.env.NODE_ENV === 'development';
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';

    if (!isDev || !isLocalhost) {
      return res.status(403).json({ error: 'Ground truth is accessible only on localhost in dev mode' });
    }

    const active = scenarioEngine.getActiveScenario();
    res.status(200).json({
      scenario: active?.name ?? null,
      trueCause: active?.trueCause ?? null,
      trueAction: active?.trueAction ?? null,
      faultOnsetAt: scenarioEngine.getFaultOnsetAt(),
      runId: scenarioEngine.getCurrentRunId(),
    });
  });

  return app;
}
