# AxiomOps-AI: Implementation Status (Task A - Blocks 2 and 3)

## 1. Overview & Summary
Task A (Plan sections 4, 7, 9, 10, 11, 13, 16) has been completed on branch `branch-2`.
All 18 Vitest test suites (106 tests total) are passing, including all Section 20 assertions and the end-to-end acceptance suite.
The shared contracts in `shared/` were preserved without modification. Frontend (`frontend/`) was not touched.

---

## 2. What Is Done

### Simulator (Sections 4 & 9, Items 1–3)
- **Scenario Engine (`simulator/src/scenarios.ts`, `simulator/src/engine.ts`)**:
  - Implemented all 5 fault families:
    - Cache: `redis_down` (emits `cache_fallback_to_db` mechanism event and `dbFallbackQueriesTotal` counter reaches >= 20 before DB pool exhaustion).
    - Database: `db_pool_exhausted` (without cache fallback mechanism).
    - Deployment: `bad_deploy` (schema incompatibility on payments).
    - Payment: `payment_gateway_down` (gateway latency and unreachable errors).
    - Authentication: `idp_down` (JWKS and IdP unreachable).
    - Regulated Variant: `idp_down_regulated` (IdP down with downstream `batch-record-service` failure).
  - Implemented all negative scenarios:
    - `payment_decline_spike` (`not_an_incident`)
    - `token_expiry_spike` (`not_an_incident`)
    - `normal_deploy` (`not_an_incident`)
    - `healthy` / warnings-only (`insufficient_evidence`)
    - `unknown_errors` (`insufficient_evidence`)
    - `supporting_only` (`insufficient_evidence`)
    - `ambiguous` (`ambiguous_multiple_causes`)
    - `redis_plus_independent_db` (`ambiguous_multiple_causes`)
    - `redis_with_unexplained_cluster` (`diagnosed`, manual-only, `unexplained_error_cluster`, Weak level)
    - `compound` (`diagnosed`, `compound`, manual-only)
- **Engine Invariants**:
  - Event timelines with bounded jitter (max ±300 ms) preventing inverted event ordering.
  - 2–3 message variants per event.
  - Sustained failures during active faults (`failureRate >= 40%`) guaranteeing detector breaches.
  - Synchronized request outcomes generating matching logs and metrics.
- **Control Endpoints (`simulator/src/server.ts`)**:
  - `POST /control/trigger/:scenario`: Refuses injection unless baseline healthy (>= 60s and >= 30 req/service); records `faultOnsetAt` (eval only); returns `runId` and `sessionId`.
  - `POST /control/fix/:action`: Idempotent action execution with durable intent-first ledger; supports `?mode=broken` in dev mode.
  - `GET /control/fix-status/:runId/:action`: Returns action application status.
  - `POST /control/reset`: Starts new session, resets counters and state.
  - `GET /control/ground-truth`: Localhost/dev-only endpoint exposing ground-truth labels.

### Backend (Sections 10, 11, 13, 16, Items 4–11)
- **Incident Lifecycle & Detector (Item 4)**:
  - `backend/src/incident-lifecycle.ts`: Transactional creation of `Incident`, auto-`Ticket`, and auto-`Investigation` in one database transaction enforcing `openSlot = 1`, `Ticket.autoKey = incident.id`, and `Investigation.autoKey = ticket.id`. Returns existing open incident on unique violation.
  - `backend/src/detector.ts`: Mode A detector polling every 10s for technical error rate >= 20% with >= 10 requests over 60s window. Requires 2 consecutive breaches. Session-keyed cooldowns (`${sessionId}:${service}`). Business outcomes (`businessOutcomesTotal`) never count as errors. Mode B supported with manual `/incidents/report`.
- **Evidence Window & Pinning (Item 5)**:
  - `backend/src/window.ts`: Computes windowStart with 5-minute lookback margin, bounded by recent `DeployEvent` and bounded strictly by previous incident's `resolvedAt`. Gap-aware completeness checking for overlapping `IngestGap` records. One-step window expansion (`expandEvidenceWindow`). Pinned incident log preservation (`pinIncidentLogs`).
- **Evidence Builder (Item 6)**:
  - `backend/src/evidence-builder.ts`: Bidirectional service dependency traversal to depth 3 from ticket services. Session-scoped log filtering. Semantic compression into 30s buckets. Node cap of 60 prioritizing diagnostic signals (diagnostic nodes are never dropped). Compact prompt nodes holding at most 3 representative log IDs while server holds full `nodeId -> allLogIds` mapping.
- **Hypothesis Scorer (Item 7)**:
  - `backend/src/scorer.ts`: Deterministic decision table (rows 1–8). Candidate-specific exclusion by sustained health overlapping failure window. Cascade collapse verifying mechanism ordering (`A.onset < mechanism <= B.onset`) and counter threshold (`dbFallbackQueriesTotal >= 20`). Independence rule for compound causes requiring private support signals. Cycles and all-suppressed safety rules returning ambiguous. Unresolved cluster accounting forcing manual-only for unexplained clusters >= 3 instances.
- **Diagnosis & Server Validation (Items 8 & 9)**:
  - `backend/src/diagnosis.ts`: Deadline-aware LLM execution (9s first call, 20s total deadline, 1 retry if >= 8s remain). Deterministic explanation generator for multi-candidate/negative/offline scenarios. Full 6-check server validation against Section 11 rules. Qualitative evidence level calculation (`Strong`, `Moderate`, `Weak`) with explicit rationales.
- **Historical Cases (Item 10)**:
  - `backend/src/history.ts`: Seeds verified historical cases for all 5 fault families plus an unverified/proposed distractor case. Top-3 retrieval scored by signal and service overlap, strictly filtering on `status: 'verified'`.
- **API & Pipeline (Item 11)**:
  - `backend/src/investigation-pipeline.ts`: End-to-end orchestration linking evidence builder, scorer, historical retrieval, validation, regulatory hold check, and audit trail.
  - `backend/src/server.ts`: Mounted routes:
    - `POST /scenarios/:name/trigger`
    - `GET /incidents/active`
    - `POST /incidents/report` (Mode B)
    - `POST /tickets`, `GET /tickets`, `GET /tickets/:id`
    - `POST /tickets/:id/investigate`
    - `GET /investigations/:id`
    - `GET /incidents/:id/audit`
  - Append-only `AuditEvent` logged at every stage.
  - Startup sweep (`startupInvestigationSweep`) failing stale running investigations on boot.

### Test Suite & Acceptance (Section 20)
- Implemented and passing 18 Vitest test suites (106 tests):
  1. `tests/traversal.test.ts` (3 tests)
  2. `tests/signal-rules.test.ts` (26 tests)
  3. `tests/evidence-builder.test.ts` (1 test)
  4. `tests/scorer.test.ts` (12 tests)
  5. `tests/unexplained-errors.test.ts` (2 tests)
  6. `tests/bad-deploy.test.ts` (3 tests)
  7. `tests/exclusion-timing.test.ts` (3 tests)
  8. `tests/validation.test.ts` (6 tests)
  9. `tests/validity-matrix.test.ts` (20 tests)
  10. `tests/session-isolation.test.ts` (1 test)
  11. `tests/detector.test.ts` (3 tests)
  12. `tests/mode-isolation.test.ts` (1 test)
  13. `tests/window.test.ts` (2 tests)
  14. `tests/metrics.test.ts` (6 tests)
  15. `tests/retention.test.ts` (1 test)
  16. `tests/simulator-state.test.ts` (3 tests)
  17. `tests/ingest.test.ts` (9 tests)
  18. `tests/acceptance-task-a.test.ts` (4 tests)

---

## 3. Acceptance Criteria Verification Results

| Requirement | Result | Evidence / Details |
|---|---|---|
| One trigger of `redis_down` creates exactly one incident, ticket, investigation with no click | **PASSED** | Mode A detector detected 2 consecutive breaches and created exactly 1 Incident (`openSlot: 1`), 1 Ticket (`autoKey`), 1 Investigation (`autoKey`). Also verified across 3 consecutive resets. |
| Redis diagnosed with DB pool exhaustion recorded as suppressed, evidence cited | **PASSED** | Scorer collapsed DB pool cascade into Redis using `cache_fallback_to_db` mechanism and `dbFallbackQueriesTotal >= 20`. DB pool recorded in `suppressed` with reason `collapsed_by_redis_unavailable_mechanism_proven`. Evidence cited points to valid nodes. |
---

## 4. Phase 1: Remediation and Guard (Items 1–8)

### What Is Done:
- **Item 1 (Commit `299fa2e`)**: Demo authentication (`backend/src/auth/demo-auth.ts`) deriving `approverRole` strictly from `DemoUser` table (`operator-1`, `operator-2`, `sme-1`). Caller-supplied roles are ignored.
- **Item 2 (Commit `83b49be`)**: Shared execution guard (`backend/src/policy/execution-guard.ts`):
  - `buildExecutionContext` built from stored database rows only.
  - Evidence-derived `effectiveImpactServices` combining ticket services, error-emitting services in pack, action target service, and cause symptom signatures.
  - Fail-closed guard asserting separate L2 and L1 prerequisites.
  - Regulated service hold for both L2 and L1 actions.
  - Called independently by Approve API, remediation executor, and L1 runbook engine immediately before touching simulator.
- **Item 3 (Commit `fd49170`)**: `POST /investigations/:id/approve`:
  - `idempotencyKey` unique handling returning existing run on replay.
  - Partial unique index `one_active_remediation` (`CREATE UNIQUE INDEX one_active_remediation ON "RemediationRun" ("incidentId") WHERE status = 'in_progress'`) deployed via custom SQL migration.
  - Catches Prisma unique violation `P2002` and returns active run.
  - 409 responses for unlinked tickets, outdated investigations, Weak level, evidence gaps, material unresolved clusters, and regulated holds.
  - Rejected approvals are logged to `AuditEvent`.
- **Item 4 (Commit `caa7d52`)**: Execution state machine:
  - Sequence: `pending` -> `apply_sent` -> `apply_confirmed` -> `verifying` -> `finished`.
  - Persists `apply_sent` before calling simulator fix endpoint.
  - `attemptId = RemediationRun.id`.
  - `startupRemediationReconciliation` implements Section 12 reconciliation table on reboot.
- **Item 5 (Commit `73dc5f3`)**: Verifier engine & Simulator endpoints:
  - `backend/src/verify/thresholds.ts` and `backend/src/verify/verifier.ts` implementing all 5 fault family check lists:
    - `restart_redis`: 3 consecutive health polls, `redis_restored` log, >= 5 cache successes, no new conn refused, cache hit & p95 thresholds with floors.
    - `increase_db_pool`: pool wait, active connections < 80%, `db_pool_resized` log, >= 5 DB successes, no pool exhausted.
    - `rollback_deploy`: rollback log, 5xx rate delta <= 1%, validation errors cleared, >= 5 successes.
    - `failover_gateway`: gateway health, `gateway_failover_done` log, >= 5 authorizations, per-payment ordering (status-check timestamp <= retry timestamp) and zero duplicate charges.
    - `failover_idp`: IdP health, `idp_failover_done` log, >= 5 token validations, negative token probe returning 401, unchanged `authPolicyVersion`.
  - Metric counter deltas evaluated since apply snapshot.
  - 3 metric snapshots (`appliedCountersJson`, `incidentMetricsJson`, `afterMetricsJson`).
  - Outcomes: `resolved`, `partially_recovered`, `verification_failed`, `verification_inconclusive`.
- **Item 6 (Commit `a63569f`)**: Lifecycle resolution rules:
  - Incident and ticket close only on `resolved`.
  - Linked tickets resolve with same evidence.
  - Maximum 1 extra attempt allowed, followed by escalation `AuditEvent`.
- **Item 7 (Commit `10a8fc6`)**: Regulated Service Invariant (`idp_down_regulated`):
  - Execution guard halts execution (`regulated_service_requires_change_control`).
  - Audit timeline records `change_control_required` event with diagnosis, evidence IDs, impact services, recommended action, and owning team.
  - `regulatedHold = true`, 0 calls reach simulator fix endpoint, API returns 409.
- **Item 8 (Commit `2a72bc9`)**: `GET /remediations/:id` mounted in `backend/src/server.ts`.

### Status Summary:
- **Done**: Items 1, 2, 3, 4, 5, 6, 7, 8.
- **Partial**: None.
- **Assumptions**: None.
- **Not Completed**: None in Phase 1.

---

## 5. Phase 2: L1 Ticket Handling (Items 9–11)

### What Is Done:
- **Item 9 (Commit `1ae27c8`)**: Classifier and triage:
  - `backend/src/l1/classifier.ts`: Keyword & intent matcher categorizing tickets into `how_to`, `access_request`, `known_issue`, `not_an_incident`, and `incident_report`.
  - 7 seed runbooks (`backend/src/l1/runbooks.ts`):
    - 3 how-tos: `how_to_clear_browser_cache`, `how_to_update_payment_method`, `how_to_verify_mfa_device`.
    - 1 access request: `reset_user_session`.
    - 1 known issue: `known_issue_scheduled_maintenance`.
    - 2 expected business outcome explanations: `payment_decline_explanation` and `expired_token_explanation` (`not_an_incident` with deterministic explanations and auto-resolution).
  - `backend/src/l1/duplicate-linker.ts`: Conservative duplicate linking requiring (1) service overlap with incident scoped services, (2) ticket creation timestamp inside incident window, and (3) text or evidence match against diagnostic/supporting signals. Otherwise categorized strictly as `possible_duplicate` and kept separate.
- **Item 10 (Commit `ada3d79`)**: Self-service session reset (`reset_user_session`):
  - `backend/src/l1/session-reset.ts`:
    - Simulated one-time-code identity proof requesting challenge via `POST /control/identity/challenge` and verification via `POST /control/identity/verify`. Proof is single-use and consumed atomically upon reset.
    - Evaluates shared execution guard (held if impact touches regulated services).
    - Calls simulator `POST /control/reset-user-session`.
    - Verifies old session is invalidated and new session login succeeds.
    - Resolves ticket with zero human intervention and logs `runbook_executed` audit event.
  - Endpoints: `POST /tickets/:id/identity-challenge` and `POST /tickets/:id/run-runbook`.
- **Item 11 (Commit `6544a95`)**: Escalation and History Write-Back:
  - `backend/src/l1/escalation.ts`: Generates structured escalation packet containing owning team, cited evidence IDs, candidate causes, separating evidence, and recommended manual actions when engine abstains or diagnosis requires manual review. Attached to `investigation.resultJson.escalationPacket`.
  - `backend/src/history.ts`: Implemented `writeProposedHistoricalCase` writing verified recoveries to `HistoricalCase` table with `status: 'proposed'`. Proposed cases are strictly excluded from automated retrieval until a reviewer promotes them via `confirmHistoricalCase`.

### Status Summary:
- **Done**: Items 9, 10, 11.
- **Partial**: None.
- **Assumptions**: None.
- **Not Completed**: None in Phase 2.

| All 4 other fault families diagnose correctly | **PASSED** | `db_pool_exhausted`, `bad_deploy`, `payment_gateway_down`, and `idp_down` all diagnose their respective causes accurately. `idp_down_regulated` sets `regulatedHold: true` and flags `dispositionReason: 'regulated_service_requires_change_control'`. |
| `redis_with_unexplained_cluster` is manual-only | **PASSED** | Material cluster (3 instances of novel payments error) forced `actionDisposition: 'manual_recommended'`, `dispositionReason: 'unexplained_error_cluster'`, and `evidenceLevel: 'Weak'`. |
| All tests pass | **PASSED** | 18 test files, 106 tests passing in Vitest. |

---

## 4. What Is Partial / Assumptions
- **LLM Integration**: Live external LLM calls use `executeLlmDiagnosis` which falls back to the deterministic explanation engine if `LLM_API_KEY` is unset or default. The deterministic explanation generates valid JSON conforming 100% to the Section 6 validity matrix and Section 11 server validation rules.
- **Remediation Execution Engine (Section 12)**: Part A Remediation state machine (`pending -> apply_sent -> apply_confirmed -> verifying -> finished`) and the 5 scenario multi-poll verifiers will be connected in Block 4/5.
- **Shared Contracts**: `shared/` contracts were preserved without modification.

---

## 5. How to Run

### Run Test Suite
```bash
npm test
```
Runs all 106 unit, integration, invariant, and acceptance tests across workspaces.

### Run Simulator
```bash
npm run dev --workspace=@axiomops/simulator
# Or from simulator/
cd simulator && npm run dev
```
Simulator listens on port 4000.

### Run Backend
```bash
npm run dev --workspace=@axiomops/backend
# Or from backend/
cd backend && npm run dev
```
Backend listens on port 3000. Mode A detector starts automatically.

---

## 6. Items Not Completed
- Frontend UI (`frontend/` was deliberately not touched per user instruction).
- Section 12 Remediation verification engine and approval execution loops (scheduled for subsequent Part A blocks).
