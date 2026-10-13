# AxiomOps-AI: Live Demonstration & Interview Walkthrough Guide

Use this step-by-step walkthrough to showcase **AxiomOps-AI** to recruiters, hiring managers, and interviewers during technical interviews or portfolio reviews.

---

## ⏱️ Quick 5-Minute Demo Flow

### Pre-Demo Check (Make sure all 3 services are running)
1. **Backend**: `npm run dev:backend` (running on `http://localhost:3000`)
2. **Simulator**: `npm run dev:simulator` (running on `http://localhost:4000`)
3. **Frontend**: `npm run dev:frontend` (running on `http://localhost:5173`)
4. Open your browser to **`http://localhost:5173`**.

---

### Step 1: Present the Architecture & Baseline State (30 seconds)
- **What to say**:
  > *"AxiomOps-AI is an autonomous SRE copilot designed to solve a huge problem in microservices: cascading failures. In modern architectures, when an upstream cache fails, downstream databases get saturated, and top-level checkout APIs fail. Traditional monitoring throws dozens of alerts, and standard LLMs hallucinate the symptom as the cause. AxiomOps solves this with deterministic evidence graphs and closed-loop verification."*
- **What to point out on screen**:
  - Show the clean Lumina dashboard layout.
  - Point to the live telemetry stream in the left pane showing continuous nominal logs across `edge-router`, `checkout`, `orders`, `inventory`, `payments`, and `auth`.
  - Highlight the top status badge: `ONLINE • Monitoring Active`.

---

### Step 2: Trigger a Cascading Fault (`1. redis_down`) (45 seconds)
- **What to do**:
  - Under **Scenario Trigger Matrix**, click the button **`1. redis_down`**.
- **What to say**:
  > *"I am now injecting a cache outage on our Redis cluster. Notice how within 1-2 seconds, our continuous sliding-window detector detects the breach and automatically builds a depth-3 directed dependency graph."*
- **What to observe**:
  - The telemetry stream immediately logs Redis timeouts followed by fallback DB queries and checkout 500 errors.
  - The right pane displays the active incident card with status `OPEN • Investigating`.

---

### Step 3: Inspect the Root Cause & Cascade Suppression (60 seconds)
- **What to say**:
  > *"Notice what the Copilot diagnosed: it identified `redis_unavailable` with a qualitative evidence level of **Strong (0.95)**. Even though the database connection pool was exhausted, AxiomOps detected that the `cache_fallback_to_db` mechanism event fired before the DB saturation. It automatically suppressed the database alert as a cascade symptom and zeroed in on the exact root cause."*
- **What to point out on screen**:
  - **Identified Root Cause**: `redis_unavailable`.
  - **Evidence Level**: `Strong (0.95)`.
  - **Suppressed Candidates**: `db_pool_exhausted (suppressed as cascade)`.
  - **Cited Log IDs**: Clickable log citations proving the decision is grounded in verifiable evidence, not hallucinated.

---

### Step 4: Closed-Loop Remediation & In-Flight Verification (60 seconds)
- **What to do**:
  - In the Remediation card, click **`Approve & Execute Fix`**.
- **What to say**:
  > *"When I approve the recommended fix (`restart_redis`), AxiomOps doesn't just run a script and assume everything is fine. It enters an in-flight verification state. It takes a pre-fix baseline metric snapshot, polls counter deltas over 3-30 seconds, verifies error rates drop below documented absolute floors, and runs ping sweeps. Only when the verification checklist passes does it mark the incident as RESOLVED."*
- **What to observe**:
  - The button pulses `Applying Fix...` -> `Verifying Recovery...`.
  - The verification checklist displays passing checks.
  - The status updates to **`✓ RESOLVED • Verified`** with green highlights.

---

### Step 5: Test Session Reset (15 seconds)
- **What to do**:
  - Click the **`Reset Session`** button in the top navigation bar.
- **What to say**:
  > *"Clicking Reset clears active incidents and returns the simulator to nominal baseline traffic."*
- **What to observe**:
  - Dashboard returns to clean nominal baseline (`ONLINE • Monitoring Active`).

---

### Step 6: Showcase the Regulatory Policy Guard (`⚠ idp_down_regulated`) (60 seconds)
- **What to do**:
  - Under Scenario Matrix, click **`⚠ idp_down_regulated`**.
- **What to say**:
  > *"In enterprise environments, AI agents must never perform unapproved changes on compliance-critical systems. Here, I triggered an Identity Provider failure that affects downstream `batch-record-service`—which is flagged as a REGULATED service under financial compliance."*
- **What to observe**:
  - A bright amber/crimson banner appears:
    `REGULATORY HOLD ACTIVE: CHANGE CONTROL REQUIRED`
  - The system explains that automated remediation is prohibited.
  - The approve button is disabled with `Execution Blocked by Regulatory Policy`.
- **What to say**:
  > *"Even if an attacker or rogue script calls the backend remediation API directly, our Execution Guard evaluates the transitive impact graph and rejects the request with HTTP 409 Conflict."*

---

### Step 7: Benchmark Metrics & Scorecard (45 seconds)
- **What to do**:
  - Click **`Benchmark Metrics`** in the left sidebar navigation.
- **What to say**:
  > *"We evaluated AxiomOps across 27 comprehensive production benchmark runs in Mode A. Here are the audited results: 100% root-cause accuracy, 100% abstention accuracy on negative scenarios, and 0.0% wrong-but-strong hallucinations. Most importantly, it reduces MTTR from 275 seconds for an on-call human to 15.1 seconds for the Copilot—an 18.2x operational acceleration."*
- **What to point out on screen**:
  - The 4 metric highlight cards (100% Accuracy, 0.0% Hallucination, 15.1s MTTR, 18.2x Speedup).
  - The comparison breakdown table showing individual fault families.

---

### Step 8: L1 Runbook Automation with Identity Proof (30 seconds)
- **What to do**:
  - Click **`L1 Automation`** in the left sidebar navigation.
  - Click **`Generate One-Time Proof`**.
  - Click **`Execute Runbook: reset_user_session`**.
- **What to say**:
  > *"For routine L1 support requests like user session resets, AxiomOps automates zero-human triage while enforcing cryptographic one-time challenge codes to prevent session-hijacking attacks. Once verified, the runbook executes atomically and updates the audit ledger."*
- **What to observe**:
  - Challenge code generated (`PRF-XXXX`).
  - Runbook executed with output `Session invalidated and token revoked successfully.`.

---

## 🎯 High-Impact Interview Questions & Answers

**Q: How does AxiomOps avoid LLM hallucinations during high-severity outages?**
> *"AxiomOps decouples hypothesis scoring from text generation. The hypothesis scoring is handled by a deterministic decision table and graph traversal engine that verifies private supporting signals and cascade ordering. The LLM is only used for structured natural language explanation, and its output is strictly validated server-side by 6 integrity checks. If evidence is ambiguous, the system enforces automated abstention."*

**Q: How do you prevent remediation scripts from causing worse damage?**
> *"Through three layers of defense: first, the Execution Guard enforces role-based approvals and regulatory holds. Second, remediation uses an idempotent, intent-first state machine. Third, closed-loop verifiers require counter deltas and negative security probes to pass before declaring success. If verification fails, the system triggers automated rollback and notifies the SME."*

**Q: How did you benchmark the 18.2x MTTR reduction?**
> *"We implemented a dual-mode benchmarking engine. In Mode B (manual operator baseline), we measured the time required for human triage, log inspection, hypothesis testing, and manual runbook execution—averaging 275 seconds. In Mode A (AxiomOps autonomous copilot), end-to-end detection, cascade-suppressed diagnosis, and verified remediation resolved the incident in a median of 15.1 seconds across 15 consecutive runs."*
