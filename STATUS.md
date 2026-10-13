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
| Every negative scenario returns specified outcome with no LLM call | **PASSED** | `payment_decline_spike` (`not_an_incident`), `token_expiry_spike` (`not_an_incident`), `normal_deploy` (`not_an_incident`), `healthy` (`insufficient_evidence`), `unknown_errors` (`insufficient_evidence`), `supporting_only` (`insufficient_evidence`), `ambiguous` (`ambiguous_multiple_causes`), `redis_plus_independent_db` (`ambiguous_multiple_causes`), `compound` (`diagnosed`, compound, manual-only). All evaluated deterministically with 0 LLM calls. |
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
