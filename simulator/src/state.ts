import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export interface AppliedActionRecord {
  actionId: string;
  attemptId: string;
  scenarioRunId?: string;
  appliedAt: string;
}

export interface SimulatorState {
  stateVersion: number;
  sessionId: string;
  serviceSeq: Record<string, number>;
  activeScenario: string | null;
  faultFlags: Record<string, boolean>;
  appliedActions: AppliedActionRecord[];
}

export interface LedgerEntry {
  scenarioRunId: string;
  actionId: string;
  attemptId: string;
  state: 'intended' | 'applied';
  stateVersionBefore: number;
  updatedAt: string;
}

export class SimulatorStateManager {
  private stateFilePath: string;
  private ledgerFilePath: string;
  private state: SimulatorState;

  constructor(baseDir: string = path.resolve(process.cwd(), 'simulator')) {
    this.stateFilePath = path.join(baseDir, 'state.json');
    this.ledgerFilePath = path.join(baseDir, 'ledger.json');
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
    this.state = this.loadOrInitState();
  }

  private loadOrInitState(): SimulatorState {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        return JSON.parse(raw);
      } catch (e) {
        console.warn('[SimulatorState] Failed to read state.json, initializing fresh state:', e);
      }
    }

    const fresh: SimulatorState = {
      stateVersion: 1,
      sessionId: `session-${randomUUID().slice(0, 8)}`,
      serviceSeq: {},
      activeScenario: null,
      faultFlags: {},
      appliedActions: [],
    };
    this.atomicSaveState(fresh);
    return fresh;
  }

  public getState(): SimulatorState {
    return this.state;
  }

  public getSessionId(): string {
    return this.state.sessionId;
  }

  public nextServiceSeq(service: string): number {
    const current = this.state.serviceSeq[service] ?? 0;
    const next = current + 1;
    this.state.serviceSeq[service] = next;
    // We update in-memory and write atomically periodically or on critical changes
    return next;
  }

  public persistSeqState(): void {
    this.state.stateVersion += 1;
    this.atomicSaveState(this.state);
  }

  /**
   * Atomically write state to state.json using write-temp + fsync + rename.
   */
  public atomicSaveState(newState: SimulatorState): void {
    const tempFile = `${this.stateFilePath}.tmp.${Date.now()}`;
    const data = JSON.stringify(newState, null, 2);

    const fd = fs.openSync(tempFile, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // Windows atomic replace
    if (fs.existsSync(this.stateFilePath)) {
      fs.unlinkSync(this.stateFilePath);
    }
    fs.renameSync(tempFile, this.stateFilePath);
    this.state = newState;
  }

  // --- Intent-first action ledger ---

  public loadLedger(): Record<string, LedgerEntry> {
    if (fs.existsSync(this.ledgerFilePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.ledgerFilePath, 'utf8'));
      } catch {
        return {};
      }
    }
    return {};
  }

  public saveLedger(ledger: Record<string, LedgerEntry>): void {
    const tempFile = `${this.ledgerFilePath}.tmp.${Date.now()}`;
    const data = JSON.stringify(ledger, null, 2);

    const fd = fs.openSync(tempFile, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    if (fs.existsSync(this.ledgerFilePath)) {
      fs.unlinkSync(this.ledgerFilePath);
    }
    fs.renameSync(tempFile, this.ledgerFilePath);
  }

  private ledgerKey(actionId: string, attemptId: string): string {
    return `${actionId}:${attemptId}`;
  }

  /**
   * Step 1: Persist action intent.
   */
  public recordIntent(scenarioRunId: string, actionId: string, attemptId: string): void {
    const ledger = this.loadLedger();
    const key = this.ledgerKey(actionId, attemptId);
    ledger[key] = {
      scenarioRunId,
      actionId,
      attemptId,
      state: 'intended',
      stateVersionBefore: this.state.stateVersion,
      updatedAt: new Date().toISOString(),
    };
    this.saveLedger(ledger);
  }

  /**
   * Step 2 & 3: Apply action and write receipt.
   */
  public applyActionWithReceipt(
    scenarioRunId: string,
    actionId: string,
    attemptId: string,
    effectFn?: () => void
  ): boolean {
    const key = this.ledgerKey(actionId, attemptId);
    const ledger = this.loadLedger();

    // If already applied, return immediately (idempotent)
    const alreadyApplied = this.state.appliedActions.some(
      (a) => a.actionId === actionId && a.attemptId === attemptId
    );
    if (alreadyApplied) {
      if (ledger[key] && ledger[key].state !== 'applied') {
        ledger[key].state = 'applied';
        ledger[key].updatedAt = new Date().toISOString();
        this.saveLedger(ledger);
      }
      return false; // did not re-apply
    }

    // Ensure intent was written
    if (!ledger[key]) {
      this.recordIntent(scenarioRunId, actionId, attemptId);
    }

    // Execute effect
    if (effectFn) {
      effectFn();
    }

    // Atomic state update containing the applied action effect
    const updatedState: SimulatorState = {
      ...this.state,
      stateVersion: this.state.stateVersion + 1,
      appliedActions: [
        ...this.state.appliedActions,
        {
          actionId,
          attemptId,
          scenarioRunId,
          appliedAt: new Date().toISOString(),
        },
      ],
    };
    this.atomicSaveState(updatedState);

    // Write receipt
    const updatedLedger = this.loadLedger();
    updatedLedger[key] = {
      scenarioRunId,
      actionId,
      attemptId,
      state: 'applied',
      stateVersionBefore: this.state.stateVersion - 1,
      updatedAt: new Date().toISOString(),
    };
    this.saveLedger(updatedLedger);
    return true;
  }

  /**
   * Startup reconciliation: reconcile ledger against state.json.
   */
  public reconcileOnStartup(applyHandler?: (actionId: string, attemptId: string) => void): void {
    const ledger = this.loadLedger();
    let ledgerModified = false;

    for (const [key, entry] of Object.entries(ledger)) {
      const isAppliedInState = this.state.appliedActions.some(
        (a) => a.actionId === entry.actionId && a.attemptId === entry.attemptId
      );

      if (entry.state === 'intended') {
        if (isAppliedInState) {
          // Applied, but receipt was missing -> write receipt, do not re-apply
          entry.state = 'applied';
          entry.updatedAt = new Date().toISOString();
          ledgerModified = true;
        } else {
          // Intent with no applied entry -> apply exactly once
          if (applyHandler) {
            applyHandler(entry.actionId, entry.attemptId);
          }
          this.applyActionWithReceipt(entry.scenarioRunId, entry.actionId, entry.attemptId);
        }
      } else if (entry.state === 'applied' && !isAppliedInState) {
        // Invariant recovery: mark applied in state
        this.state.appliedActions.push({
          actionId: entry.actionId,
          attemptId: entry.attemptId,
          scenarioRunId: entry.scenarioRunId,
          appliedAt: new Date().toISOString(),
        });
        this.atomicSaveState(this.state);
      }
    }

    if (ledgerModified) {
      this.saveLedger(ledger);
    }
  }

  /**
   * Start a new session: resets sessionId and serviceSeq counters to 1.
   */
  public resetSession(): string {
    const newSessionId = `session-${randomUUID().slice(0, 8)}`;
    const nextState: SimulatorState = {
      stateVersion: this.state.stateVersion + 1,
      sessionId: newSessionId,
      serviceSeq: {},
      activeScenario: null,
      faultFlags: {},
      appliedActions: [],
    };
    this.atomicSaveState(nextState);
    return newSessionId;
  }
}

export const simulatorState = new SimulatorStateManager();
