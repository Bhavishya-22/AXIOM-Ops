import { SCENARIOS, ScenarioDefinition } from './scenarios.js';
import { trafficSimulator } from './traffic.js';
import { simulatorState } from './state.js';

export interface TriggerResult {
  runId: string;
  sessionId: string;
  scenario: string;
  faultOnsetAt: number;
}

export class ScenarioEngine {
  private activeScenario: ScenarioDefinition | null = null;
  private faultOnsetAt: number | null = null;
  private currentRunId: string | null = null;
  private activeTimeouts: NodeJS.Timeout[] = [];
  private faultActive: boolean = false;
  private baselineStartedAt: number = Date.now();

  public getActiveScenario(): ScenarioDefinition | null {
    return this.activeScenario;
  }

  public isFaultActive(): boolean {
    return this.faultActive;
  }

  public getFaultOnsetAt(): number | null {
    return this.faultOnsetAt;
  }

  public getCurrentRunId(): string | null {
    return this.currentRunId;
  }

  /**
   * Check whether the session has accumulated a healthy baseline:
   * at least 60 seconds elapsed and at least 30 requests per verified service (checkout, payments).
   */
  public hasHealthyBaseline(): boolean {
    const elapsed = Date.now() - this.baselineStartedAt;
    if (elapsed < 60000) return false;

    const checkout = trafficSimulator.getMetricsForService('checkout');
    const payments = trafficSimulator.getMetricsForService('payments');
    return checkout.requestsTotal >= 30 && payments.requestsTotal >= 30;
  }

  public resetBaseline(): void {
    this.baselineStartedAt = Date.now();
  }

  /**
   * Trigger a scenario with timeline events and bounded jitter.
   */
  public trigger(scenarioName: string, skipBaselineCheck: boolean = false): TriggerResult {
    const scenario = SCENARIOS[scenarioName];
    if (!scenario) {
      throw new Error(`Unknown scenario: ${scenarioName}`);
    }

    if (!skipBaselineCheck && !this.hasHealthyBaseline()) {
      throw new Error(
        'Baseline invariant violated: requires at least 60 seconds and 30 requests per verified service'
      );
    }

    this.clearActiveScenario();

    const now = Date.now();
    const runId = `run-${scenarioName}-${now}`;
    this.activeScenario = scenario;
    this.faultOnsetAt = now;
    this.currentRunId = runId;
    this.faultActive = true;

    // Schedule timeline events with bounded jitter (+-300ms)
    for (const evt of scenario.timeline) {
      const jitter = Math.floor(Math.random() * 600) - 300; // -300 to +300 ms
      const delay = Math.max(0, evt.at + jitter);

      const timer = setTimeout(() => {
        if (!this.faultActive || this.activeScenario?.name !== scenarioName) return;

        // Pick variant
        const variant = evt.variants[Math.floor(Math.random() * evt.variants.length)];
        trafficSimulator.emitCustomLog(evt.service, evt.level, variant);

        // Update counters if specified in event
        if (evt.counter) {
          const m = trafficSimulator.getMetricsForService(evt.service);
          for (const [cKey, cCfg] of Object.entries(evt.counter)) {
            if (cKey === 'dbFallbackQueriesTotal') {
              m.scenarioCounters.dbFallbackQueriesTotal = Math.max(
                m.scenarioCounters.dbFallbackQueriesTotal,
                25 // ensure it reaches the >= 20 threshold
              );
            }
          }
        }
      }, delay);

      this.activeTimeouts.push(timer);
    }

    return {
      runId,
      sessionId: simulatorState.getSessionId(),
      scenario: scenarioName,
      faultOnsetAt: now,
    };
  }

  /**
   * Apply an action fix. If brokenMode is true, action is marked applied but fault remains active.
   */
  public fix(actionName: string, attemptId: string, brokenMode: boolean = false): boolean {
    if (!this.activeScenario) {
      return false;
    }

    const scenarioRunId = this.currentRunId || 'run-default';

    // Apply with durable intent ledger
    const applied = simulatorState.applyActionWithReceipt(scenarioRunId, actionName, attemptId, () => {
      if (brokenMode) {
        console.log(`[ScenarioEngine] Fix ${actionName} applied in BROKEN mode; fault remains active.`);
        return;
      }

      // Schedule recovery
      const fixConfig = this.activeScenario?.fix;
      const recoversAfterMs = fixConfig?.recoversAfterMs ?? 8000;

      setTimeout(() => {
        this.faultActive = false;
        // Emit recovery logs
        if (fixConfig?.emits) {
          for (const msg of fixConfig.emits) {
            const targetSvc = this.activeScenario?.affectedServices[0] || 'checkout';
            trafficSimulator.emitCustomLog(targetSvc, 'INFO', msg);
          }
        }
        console.log(`[ScenarioEngine] Fault ${this.activeScenario?.name} recovered successfully after ${recoversAfterMs}ms.`);
      }, recoversAfterMs);
    });

    return applied;
  }

  public clearActiveScenario(): void {
    for (const t of this.activeTimeouts) {
      clearTimeout(t);
    }
    this.activeTimeouts = [];
    this.activeScenario = null;
    this.faultOnsetAt = null;
    this.currentRunId = null;
    this.faultActive = false;
  }
}

export const scenarioEngine = new ScenarioEngine();

trafficSimulator.setFaultChecker(() => ({
  isFaultActive: scenarioEngine.isFaultActive(),
  activeScenario: scenarioEngine.getActiveScenario(),
}));
