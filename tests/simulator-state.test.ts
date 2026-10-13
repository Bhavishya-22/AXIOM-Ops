import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SimulatorStateManager } from '../simulator/src/state.js';

describe('Simulator Durable State & Crash Recovery (Item 9)', () => {
  const testDir = path.resolve(process.cwd(), 'tests', 'scratch_state');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('performs atomic writes and increments stateVersion on state changes', () => {
    const sm = new SimulatorStateManager(testDir);
    const initialVersion = sm.getState().stateVersion;

    const seq1 = sm.nextServiceSeq('checkout');
    expect(seq1).toBe(1);

    sm.persistSeqState();
    expect(sm.getState().stateVersion).toBe(initialVersion + 1);

    // Verify state.json was written to disk
    const stateFile = path.join(testDir, 'state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    const diskState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(diskState.serviceSeq['checkout']).toBe(1);
  });

  it('crash recovery: intent with no applied entry applies exactly once on startup', () => {
    const sm = new SimulatorStateManager(testDir);
    const scenarioRunId = 'run-crash-test';
    const actionId = 'restart_redis';
    const attemptId = 'attempt-1';

    // Step 1: Simulator records intent before crash
    sm.recordIntent(scenarioRunId, actionId, attemptId);

    // Verify ledger has 'intended' and state.appliedActions is still empty
    const ledger = sm.loadLedger();
    expect(ledger[`${actionId}:${attemptId}`]?.state).toBe('intended');
    expect(sm.getState().appliedActions).toHaveLength(0);

    // SIMULATE CRASH & RESTART:
    // Create new SimulatorStateManager instance pointing to same dir
    let appliedCallCount = 0;
    const smRestart = new SimulatorStateManager(testDir);
    smRestart.reconcileOnStartup((act, att) => {
      if (act === actionId && att === attemptId) {
        appliedCallCount++;
      }
    });

    // Reconcile should have executed the action exactly once
    expect(appliedCallCount).toBe(1);
    expect(smRestart.getState().appliedActions.some((a) => a.actionId === actionId && a.attemptId === attemptId)).toBe(true);
    expect(smRestart.loadLedger()[`${actionId}:${attemptId}`]?.state).toBe('applied');

    // A second restart should NOT re-apply
    let secondRestartCount = 0;
    const smSecondRestart = new SimulatorStateManager(testDir);
    smSecondRestart.reconcileOnStartup(() => {
      secondRestartCount++;
    });
    expect(secondRestartCount).toBe(0);
  });

  it('crash recovery: applied entry with missing receipt writes receipt without re-applying', () => {
    const sm = new SimulatorStateManager(testDir);
    const scenarioRunId = 'run-missing-receipt';
    const actionId = 'increase_db_pool';
    const attemptId = 'attempt-2';

    // Step 1: Intent recorded
    sm.recordIntent(scenarioRunId, actionId, attemptId);

    // Step 2: Action applied in state, but process crashed before ledger receipt was written
    const stateWithApplied = {
      ...sm.getState(),
      stateVersion: sm.getState().stateVersion + 1,
      appliedActions: [
        {
          actionId,
          attemptId,
          scenarioRunId,
          appliedAt: new Date().toISOString(),
        },
      ],
    };
    sm.atomicSaveState(stateWithApplied);

    // Verify ledger still says 'intended' while state has the applied action
    expect(sm.loadLedger()[`${actionId}:${attemptId}`]?.state).toBe('intended');

    // SIMULATE RESTART:
    let reapplyCount = 0;
    const smRestart = new SimulatorStateManager(testDir);
    smRestart.reconcileOnStartup(() => {
      reapplyCount++;
    });

    // Must NOT re-apply, but MUST write receipt 'applied'
    expect(reapplyCount).toBe(0);
    const recoveredLedger = smRestart.loadLedger();
    expect(recoveredLedger[`${actionId}:${attemptId}`]?.state).toBe('applied');
  });
});
