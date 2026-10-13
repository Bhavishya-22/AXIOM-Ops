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
    const active = scenarioEngine.getActiveScenario();
    const isFault = scenarioEngine.isFaultActive();

    if (isFault && active && active.affectedServices.includes(service)) {
      return res.status(503).json({
        status: 'degraded',
        service,
        error: 'Service degraded due to active fault',
        timestamp: new Date().toISOString(),
      });
    }

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
  app.post('/control/trigger/:scenario', requireControlToken, async (req: Request, res: Response) => {
    const scenario = String(req.params.scenario);
    const skipBaselineCheck = req.query.skipBaselineCheck === 'true' || req.body?.skipBaselineCheck === true;

    try {
      const result = scenarioEngine.trigger(scenario, skipBaselineCheck);
      await trafficSimulator.flushLogsToBackend().catch(() => {});
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

  // 8. GET /control/payment-records/:runId/:attemptId
  app.get('/control/payment-records/:runId/:attemptId', requireControlToken, (req: Request, res: Response) => {
    const mode = (req.query.mode as string) || '';
    const now = Date.now();

    if (mode === 'duplicate_charge') {
      return res.status(200).json({
        payments: [
          {
            paymentId: 'pay-dup-1',
            idempotencyKey: 'idem-dup-1',
            capturedAtApply: now - 5000,
            statusCheck: { result: 'completed', ts: now - 3000 },
            retry: { ts: now - 2000, idempotencyKey: 'idem-dup-1' },
            chargeCount: 2,
          },
        ],
      });
    }

    if (mode === 'ordering_failed') {
      return res.status(200).json({
        payments: [
          {
            paymentId: 'pay-ord-1',
            idempotencyKey: 'idem-ord-1',
            capturedAtApply: now - 5000,
            statusCheck: { result: 'pending', ts: now - 1000 },
            retry: { ts: now - 2000, idempotencyKey: 'idem-ord-1' },
            chargeCount: 1,
          },
        ],
      });
    }

    res.status(200).json({
      payments: [
        {
          paymentId: 'pay-ok-1',
          idempotencyKey: 'idem-ok-1',
          capturedAtApply: now - 8000,
          statusCheck: { result: 'pending', ts: now - 6000 },
          retry: { ts: now - 4000, idempotencyKey: 'idem-ok-1' },
          chargeCount: 1,
        },
        {
          paymentId: 'pay-ok-2',
          idempotencyKey: 'idem-ok-2',
          capturedAtApply: now - 8000,
          statusCheck: { result: 'completed', ts: now - 5000 },
          retry: null,
          chargeCount: 1,
        },
      ],
    });
  });

  // 9. POST /probe/validate-token
  app.post('/probe/validate-token', (req: Request, res: Response) => {
    const token = req.body?.token;
    const mode = req.query?.mode;

    if (mode === 'insecure') {
      return res.status(200).json({ valid: true, subject: 'insecure-probe' });
    }

    if (!token || token.includes('invalid') || token.includes('expired') || token === 'bad-token') {
      return res.status(401).json({ valid: false, error: 'Unauthorized: invalid token' });
    }

    return res.status(200).json({ valid: true, subject: 'probe-valid-user' });
  });

  // 10. GET /control/auth-policy-version
  app.get('/control/auth-policy-version', requireControlToken, (req: Request, res: Response) => {
    const version = (req.query.version as string) || '2026.1';
    res.status(200).json({ authPolicyVersion: version });
  });

  // 11. Identity Challenge & Verification (Section 15 for L1)
  const activeChallenges = new Map<string, { userId: string; code: string; verifiedAt?: Date; consumedAt?: Date | null }>();

  app.post('/control/identity/challenge', requireControlToken, (req: Request, res: Response) => {
    const userId = req.body?.userId || 'user-default';
    const challengeId = `chal-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const code = '849201';

    activeChallenges.set(challengeId, { userId, code, consumedAt: null });
    res.status(200).json({ challengeId, code, userId });
  });

  app.post('/control/identity/verify', requireControlToken, (req: Request, res: Response) => {
    const { challengeId, code } = req.body;
    const chal = activeChallenges.get(challengeId);

    if (!chal || chal.code !== code) {
      return res.status(400).json({ valid: false, error: 'Invalid challenge ID or code' });
    }

    chal.verifiedAt = new Date();
    res.status(200).json({
      valid: true,
      challengeId,
      userId: chal.userId,
      verifiedAt: chal.verifiedAt.toISOString(),
      consumedAt: null,
    });
  });

  app.post('/control/reset-user-session', requireControlToken, (req: Request, res: Response) => {
    const { userId, challengeId } = req.body;
    const chal = activeChallenges.get(challengeId);

    if (!chal || chal.userId !== userId || chal.consumedAt !== null) {
      return res.status(400).json({ error: 'Valid unconsumed identity proof required' });
    }

    chal.consumedAt = new Date();
    res.status(200).json({
      status: 'session_reset_complete',
      userId,
      oldSessionInvalidated: true,
      newSessionAvailable: true,
      consumedAt: chal.consumedAt.toISOString(),
    });
  });

  return app;
}
