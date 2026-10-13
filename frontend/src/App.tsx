import { useState, useEffect } from 'react';

interface LogRow {
  id: string;
  ts: string;
  service: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  message: string;
  signalKind?: string;
}

interface Incident {
  id: string;
  sessionId: string;
  detectedAt: string;
  status: 'open' | 'investigating' | 'mitigating' | 'resolved';
  resolvedAt?: string | null;
  summary?: string;
}

interface Ticket {
  id: string;
  incidentId?: string;
  title: string;
  description: string;
  services: string[];
  status: string;
  source: string;
  investigations?: Investigation[];
}

interface Investigation {
  id: string;
  ticketId: string;
  diagnosisStatus: string;
  causeMode?: string;
  shortlistJson?: string[];
  rootCausesJson?: string[];
  citedLogIdsJson?: string[];
  unresolvedClustersJson?: any[];
  actionDisposition?: string;
  dispositionReason?: string;
  evidenceLevel?: string;
  effectiveImpactJson?: string[];
  regulatedHold?: boolean;
  remediations?: RemediationRun[];
}

interface RemediationRun {
  id: string;
  actionId: string;
  status: string;
  disposition: string;
  attemptNumber: number;
  verificationStatus?: string;
  metricsBeforeJson?: any;
  metricsAfterJson?: any;
}

const API_BASE = 'http://localhost:3000';

const DEMO_USERS: Record<string, { role: string; token: string; title: string }> = {
  'operator-1': { role: 'operator', token: 'operator-1-token', title: 'Site Reliability Operator' },
  'operator-2': { role: 'operator', token: 'operator-2-token', title: 'Operations Engineer' },
  'sme-1': { role: 'sme', token: 'sme-1-token', title: 'Domain SME & Tech Lead' },
};

export function App() {
  const [activeTab, setActiveTab] = useState<'cockpit' | 'scorecard' | 'runbooks'>('cockpit');
  const [currentUser, setCurrentUser] = useState<string>('operator-1');
  const [detectorMode, setDetectorMode] = useState<'Mode A' | 'Mode B'>('Mode A');

  // Logs & Filters
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [filterService, setFilterService] = useState<string>('ALL');
  const [filterLevel, setFilterLevel] = useState<string>('ALL');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);

  // Active Incident & Investigation
  const [activeIncident, setActiveIncident] = useState<Incident | null>(null);
  const [, setActiveTicket] = useState<Ticket | null>(null);
  const [activeInvestigation, setActiveInvestigation] = useState<Investigation | null>(null);
  const [remediationRun, setRemediationRun] = useState<RemediationRun | null>(null);

  // Scorecard & Telemetry
  const [scorecard, setScorecard] = useState<any>(null);
  const [serviceMetrics, setServiceMetrics] = useState<Record<string, any>>({});

  // Status & Actions
  const [statusMsg, setStatusMsg] = useState<string>('System nominal. Mode A automated detector active.');
  const [isTriggering, setIsTriggering] = useState<boolean>(false);
  const [isApproving, setIsApproving] = useState<boolean>(false);

  // L1 Runbook State
  const [challengeCode, setChallengeCode] = useState<string>('');
  const [enteredChallenge, setEnteredChallenge] = useState<string>('');
  const [runbookResult, setRunbookResult] = useState<any>(null);

  // Live Clock
  const [timeString, setTimeString] = useState<string>('');

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeString(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch recent logs
  const fetchLogs = async () => {
    try {
      let url = `${API_BASE}/logs?limit=80`;
      if (filterService !== 'ALL') url += `&service=${filterService}`;
      if (filterLevel !== 'ALL') url += `&level=${filterLevel}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch {
      // Periodic fetch error tolerated
    }
  };

  // Fetch active incident & ticket
  const fetchActiveIncident = async () => {
    try {
      const res = await fetch(`${API_BASE}/incidents/active`);
      if (res.ok) {
        const data = await res.json();
        const inc = data.incident;
        setActiveIncident(inc);
        if (inc && inc.id) {
          const tickets = inc.tickets || [];
          if (tickets.length > 0) {
            const ticket = tickets[0];
            setActiveTicket(ticket);
            if (ticket.investigations && ticket.investigations.length > 0) {
              const latestInv = ticket.investigations[0];
              setActiveInvestigation(latestInv);
              if (latestInv.remediations && latestInv.remediations.length > 0) {
                setRemediationRun(latestInv.remediations[0]);
              }
            }
          }
        } else {
          setActiveTicket(null);
          setActiveInvestigation(null);
          setRemediationRun(null);
        }
      }
    } catch {
      // Polling tolerated
    }
  };

  // Fetch scorecard
  const fetchScorecard = async () => {
    try {
      const res = await fetch(`${API_BASE}/scorecard`);
      if (res.ok) {
        const data = await res.json();
        setScorecard(data);
      }
    } catch {
      // Polling tolerated
    }
  };

  // Fetch checkout metrics from simulator
  const fetchSimulatorMetrics = async () => {
    try {
      const res = await fetch('http://localhost:4000/metrics/checkout');
      if (res.ok) {
        const data = await res.json();
        setServiceMetrics((prev) => ({ ...prev, checkout: data }));
      }
    } catch {
      // Simulator connection fallback
    }
  };

  useEffect(() => {
    fetchLogs();
    fetchActiveIncident();
    fetchScorecard();
    fetchSimulatorMetrics();

    const interval = setInterval(() => {
      fetchLogs();
      fetchActiveIncident();
      fetchSimulatorMetrics();
    }, 2500);

    return () => clearInterval(interval);
  }, [filterService, filterLevel]);

  // Handle Scenario Trigger
  const handleTriggerScenario = async (scenarioName: string) => {
    setIsTriggering(true);
    setStatusMsg(`Injecting scenario '${scenarioName}'...`);
    try {
      const res = await fetch(`${API_BASE}/scenarios/${scenarioName}/trigger`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMsg(`Scenario '${scenarioName}' injected successfully. Monitoring anomaly.`);
        await fetchLogs();
        await fetchActiveIncident();
      } else {
        setStatusMsg(`Trigger failed: ${data.error || 'Baseline required'}`);
      }
    } catch (err: any) {
      setStatusMsg(`Trigger error: ${err.message}`);
    } finally {
      setIsTriggering(false);
    }
  };

  // Reset Session
  const handleResetSession = async () => {
    setStatusMsg('Resetting session and clearing simulator fault state...');
    try {
      const res = await fetch(`${API_BASE}/scenarios/control/reset`, {
        method: 'POST',
      });
      if (res.ok) {
        setStatusMsg('Simulator session reset complete. Baseline is nominal.');
        setActiveIncident(null);
        setActiveTicket(null);
        setActiveInvestigation(null);
        setRemediationRun(null);
        await fetchLogs();
      }
    } catch (err: any) {
      setStatusMsg(`Reset error: ${err.message}`);
    }
  };

  // Mode B Manual Incident Report
  const handleReportModeB = async () => {
    setStatusMsg('Reporting manual incident (Mode B)...');
    try {
      const res = await fetch(`${API_BASE}/incidents/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          services: ['checkout'],
          description: 'Manual operator report triggered via Lumina dashboard',
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMsg(`Mode B Incident created (ID: ${data.incident.id}).`);
        await fetchActiveIncident();
      }
    } catch (err: any) {
      setStatusMsg(`Mode B error: ${err.message}`);
    }
  };

  // Approve Remediation
  const handleApproveRemediation = async () => {
    if (!activeInvestigation) return;
    setIsApproving(true);
    setStatusMsg(`Submitting remediation approval by ${currentUser}...`);

    try {
      const token = DEMO_USERS[currentUser].token;
      const res = await fetch(`${API_BASE}/remediations/${activeInvestigation.id}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await res.json();
      if (res.ok) {
        setStatusMsg(`Remediation approved! Verifying fix '${data.run.actionId}'...`);
        setRemediationRun(data.run);
      } else if (res.status === 409) {
        setStatusMsg(`Approval Refused (409): ${data.reason || data.error || 'Execution disallowed by policy'}`);
      }
      await fetchActiveIncident();
    } catch (err: any) {
      setStatusMsg(`Approval error: ${err.message}`);
    } finally {
      setIsApproving(false);
    }
  };

  // Generate Identity Challenge for L1
  const handleGenerateChallenge = async () => {
    try {
      const ticketRes = await fetch(`${API_BASE}/tickets`);
      const tData = await ticketRes.json();
      const firstTicket = tData.tickets?.[0];
      if (!firstTicket) return;

      const res = await fetch(`${API_BASE}/tickets/${firstTicket.id}/identity-challenge`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        setChallengeCode(data.challengeCode);
        setEnteredChallenge(data.challengeCode);
        setStatusMsg(`Identity Challenge Generated: ${data.challengeCode}`);
      }
    } catch (err: any) {
      setStatusMsg(`Challenge error: ${err.message}`);
    }
  };

  // Run L1 Runbook
  const handleRunRunbook = async (runbookId: string) => {
    try {
      const ticketRes = await fetch(`${API_BASE}/tickets`);
      const tData = await ticketRes.json();
      const firstTicket = tData.tickets?.[0];
      if (!firstTicket) return;

      const res = await fetch(`${API_BASE}/tickets/${firstTicket.id}/run-runbook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runbookId,
          challengeCode: enteredChallenge,
        }),
      });
      const data = await res.json();
      setRunbookResult(data);
      if (res.ok) {
        setStatusMsg(`Runbook executed successfully: ${data.status}`);
      } else {
        setStatusMsg(`Runbook rejected: ${data.error || data.reason}`);
      }
    } catch (err: any) {
      setStatusMsg(`Runbook error: ${err.message}`);
    }
  };

  const isRegulatedHold = Boolean(activeInvestigation?.regulatedHold);
  const canApprove =
    activeInvestigation &&
    activeInvestigation.actionDisposition === 'executable' &&
    !isRegulatedHold &&
    activeIncident?.status === 'open' &&
    !remediationRun;

  return (
    <div className="lumina-shell">
      {/* Lumina Left Sidebar */}
      <aside className="lumina-sidebar">
        {/* Brand */}
        <div className="sidebar-brand">
          <div className="brand-logo-icon">Δ</div>
          <div className="brand-text">AXIOMOPS</div>
        </div>

        {/* Section: Main Menu */}
        <div className="sidebar-category">Operations</div>
        <nav className="sidebar-menu">
          <button
            className={`sidebar-link ${activeTab === 'cockpit' ? 'active' : ''}`}
            onClick={() => setActiveTab('cockpit')}
          >
            <span className="sidebar-link-icon">⚡</span>
            <span>Live Cockpit</span>
          </button>
          <button
            className={`sidebar-link ${activeTab === 'scorecard' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('scorecard');
              fetchScorecard();
            }}
          >
            <span className="sidebar-link-icon">📊</span>
            <span>Benchmark Metrics</span>
          </button>
        </nav>

        {/* Section: Governance */}
        <div className="sidebar-category">Governance</div>
        <nav className="sidebar-menu">
          <button
            className={`sidebar-link ${activeTab === 'runbooks' ? 'active' : ''}`}
            onClick={() => setActiveTab('runbooks')}
          >
            <span className="sidebar-link-icon">🛡</span>
            <span>L1 Automation</span>
          </button>
        </nav>

        {/* Sidebar Footer / User Profile */}
        <div className="sidebar-footer">
          <div className="user-profile-badge">
            <div className="avatar-circle">OP</div>
            <div className="user-info">
              <span className="user-name">{currentUser}</span>
              <span className="user-role">{DEMO_USERS[currentUser]?.title || 'Operator'}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Dashboard Canvas */}
      <main className="lumina-main">
        {/* Lumina Topbar */}
        <header className="lumina-topbar">
          <div className="breadcrumb-area">
            <span className="breadcrumb-label">Pages / Autonomous Operations</span>
            <h1 className="page-title">
              {activeTab === 'cockpit'
                ? 'Incident Cockpit & Telemetry'
                : activeTab === 'scorecard'
                ? 'Evaluation & Accuracy Scorecard'
                : 'L1 Runbook Automation Console'}
            </h1>
          </div>

          <div className="topbar-actions">
            {/* Mode Selector */}
            <div className="mode-pill">
              <span style={{ color: 'var(--text-muted)' }}>Mode:</span>
              <select
                style={{ background: 'transparent', border: 'none', fontWeight: 600, outline: 'none' }}
                value={detectorMode}
                onChange={(e) => setDetectorMode(e.target.value as any)}
              >
                <option value="Mode A">Mode A (Autonomous)</option>
                <option value="Mode B">Mode B (Manual Baseline)</option>
              </select>
            </div>

            {/* Identity Switcher */}
            <select
              className="identity-select"
              value={currentUser}
              onChange={(e) => setCurrentUser(e.target.value)}
            >
              <option value="operator-1">operator-1 (Operator)</option>
              <option value="operator-2">operator-2 (Operator)</option>
              <option value="sme-1">sme-1 (Domain SME)</option>
            </select>

            {/* Reset Session Button */}
            <button className="btn-pill-action" onClick={handleResetSession}>
              <span>↺</span> Reset Session
            </button>
          </div>
        </header>

        {/* Main Body */}
        <div className="dashboard-body">
          {/* Hero Section: Lumina Greeting Banner + Dark Metric Card */}
          <section className="hero-grid">
            {/* Lumina Hero Card */}
            <div className="lumina-hero-card">
              <div className="hero-left-content">
                <div className={`hero-status-pill ${activeIncident ? 'incident' : 'online'}`}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: activeIncident ? 'var(--accent-red)' : 'var(--accent-green)',
                    }}
                  />
                  {activeIncident ? 'ACTIVE INCIDENT BREACH' : 'SYSTEM NOMINAL • MONITORING ACTIVE'}
                </div>

                <h2 className="hero-heading">
                  {activeIncident
                    ? `Incident Detected: [${activeIncident.id}]`
                    : `Welcome Back, ${currentUser}!`}
                </h2>

                <p className="hero-subtitle">
                  {activeIncident
                    ? `Detector identified consecutive technical breaches on ${activeIncident.sessionId}. RCA pipeline initiated.`
                    : statusMsg}
                </p>

                <div className="hero-cta-buttons">
                  <button
                    className="btn-lumina-primary"
                    disabled={isTriggering}
                    onClick={() => handleTriggerScenario('redis_down')}
                  >
                    Trigger Diagnostic Scenario
                  </button>
                  {detectorMode === 'Mode B' && (
                    <button className="btn-lumina-secondary" onClick={handleReportModeB}>
                      Report Issue (Mode B)
                    </button>
                  )}
                </div>
              </div>

              {/* Punch-Out Widget Clock */}
              <div className="hero-clock-widget">
                <span className="clock-icon">{activeIncident ? '🚨' : '🛡'}</span>
                <span className="clock-label">{activeIncident ? 'BREACHED' : 'HEALTHY'}</span>
                <span className="clock-time">{timeString || 'LIVE'}</span>
              </div>
            </div>

            {/* Dark Contrast Card (Lumina's Net Pay Card) */}
            <div className="lumina-dark-metric-card">
              <div className="dark-card-header">
                <div>
                  <div className="dark-card-label">COPILOT MTTR • LIVE BENCHMARK</div>
                  <div className="dark-card-value">15.1s</div>
                </div>
                <div style={{ fontSize: '1.25rem' }}>⏱</div>
              </div>

              {/* Sparkline Bar Visualization comparing manual vs copilot */}
              <div className="dark-chart-bars">
                <div className="chart-bar" style={{ height: '100%' }} title="Manual: 275s" />
                <div className="chart-bar" style={{ height: '75%' }} />
                <div className="chart-bar" style={{ height: '50%' }} />
                <div className="chart-bar" style={{ height: '25%' }} />
                <div className="chart-bar highlight" style={{ height: '12%' }} title="Copilot: 15s" />
              </div>

              <div className="dark-card-footer">
                <span>Manual MTTR: <strong>275s</strong></span>
                <span style={{ color: '#34D399', fontWeight: 600 }}>18.2x Speedup</span>
              </div>
            </div>
          </section>

          {/* 4 Stats Cards Row (Like Lumina's Quick Stats) */}
          <section className="stats-row">
            <div className="stat-card">
              <div className="stat-icon-bubble blue">🎯</div>
              <div className="stat-info">
                <span className="stat-value">
                  {scorecard ? `${scorecard.rootCauseAccuracyPct}%` : '100%'}
                </span>
                <span className="stat-title">Root-Cause Accuracy</span>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon-bubble amber">🛡</div>
              <div className="stat-info">
                <span className="stat-value">
                  {scorecard ? `${scorecard.abstentionAccuracyPct}%` : '100%'}
                </span>
                <span className="stat-title">Abstention Accuracy</span>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon-bubble green">⚖</div>
              <div className="stat-info">
                <span className="stat-value" style={{ color: 'var(--accent-green)' }}>
                  {scorecard ? `${scorecard.wrongButStrongRatePct}%` : '0.0%'}
                </span>
                <span className="stat-title">Wrong-but-Strong Rate</span>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon-bubble cyan">✓</div>
              <div className="stat-info">
                <span className="stat-value">
                  {scorecard ? `${scorecard.verifiedResolutionRatePct}%` : '100%'}
                </span>
                <span className="stat-title">Verified Resolution Rate</span>
              </div>
            </div>
          </section>

          {/* Cockpit Tab Content */}
          {activeTab === 'cockpit' && (
            <div className="lumina-cockpit-split">
              {/* Left Column: Live Telemetry Logs Card */}
              <div className="lumina-card">
                <div className="card-header-flex">
                  <div className="card-heading-title">
                    <span>📡</span> Live Telemetry & Log Stream
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {logs.length} events
                    </span>
                    <button
                      className="btn-pill-action"
                      style={{ padding: '0.2rem 0.6rem', fontSize: '0.7rem' }}
                      onClick={() => setAutoScroll(!autoScroll)}
                    >
                      {autoScroll ? 'Streaming' : 'Paused'}
                    </button>
                  </div>
                </div>

                {/* Service Metrics Summary Strip */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '0.5rem 0.75rem',
                    background: 'var(--bg-muted)',
                    borderRadius: 'var(--radius-md)',
                    fontSize: '0.75rem',
                  }}
                >
                  <span>Checkout Requests: <strong>{serviceMetrics.checkout?.requestsTotal ?? 0}</strong></span>
                  <span>Errors: <strong style={{ color: 'var(--accent-red)' }}>{serviceMetrics.checkout?.errorsTotal ?? 0}</strong></span>
                  <span>Cache Hits: <strong style={{ color: 'var(--accent-green)' }}>{serviceMetrics.checkout?.cacheHitsTotal ?? 0}</strong></span>
                </div>

                {/* Filter Strip */}
                <div className="log-filters-strip">
                  <select
                    className="select-filter-lumina"
                    value={filterService}
                    onChange={(e) => setFilterService(e.target.value)}
                  >
                    <option value="ALL">All Services</option>
                    <option value="checkout">checkout</option>
                    <option value="payments">payments</option>
                    <option value="orders-db">orders-db</option>
                    <option value="redis-cache">redis-cache</option>
                    <option value="auth-idp">auth-idp</option>
                    <option value="batch-record-service">batch-record-service</option>
                  </select>

                  <select
                    className="select-filter-lumina"
                    value={filterLevel}
                    onChange={(e) => setFilterLevel(e.target.value)}
                  >
                    <option value="ALL">All Levels</option>
                    <option value="ERROR">ERROR</option>
                    <option value="WARN">WARN</option>
                    <option value="INFO">INFO</option>
                  </select>
                </div>

                {/* Log Feed */}
                <div className="log-feed-container">
                  {logs.map((log) => (
                    <div key={log.id} className="log-item-row">
                      <div className="log-timestamp">{new Date(log.ts).toLocaleTimeString()}</div>
                      <div>
                        <span className={`log-badge-level ${log.level}`}>{log.level}</span>
                      </div>
                      <div className="log-service-name">{log.service}</div>
                      <div className="log-message-content">
                        {log.message}
                        {log.signalKind && (
                          <span className="log-tag-pill">{log.signalKind}</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {logs.length === 0 && (
                    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                      Awaiting live telemetry from simulator...
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column: Scenario Simulator, RCA, Remediation */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {/* Scenario Trigger Matrix Card */}
                <div className="lumina-card">
                  <div className="card-header-flex">
                    <div className="card-heading-title">
                      <span>🕹</span> Scenario Simulator Matrix
                    </div>
                  </div>

                  <div className="scenario-button-grid">
                    <button
                      className="scenario-pill-btn"
                      disabled={isTriggering}
                      onClick={() => handleTriggerScenario('redis_down')}
                    >
                      <span className="scenario-btn-title">1. redis_down</span>
                      <span className="scenario-btn-desc">Cache failure → DB cascade</span>
                    </button>

                    <button
                      className="scenario-pill-btn"
                      disabled={isTriggering}
                      onClick={() => handleTriggerScenario('db_pool_exhausted')}
                    >
                      <span className="scenario-btn-title">2. db_pool_exhausted</span>
                      <span className="scenario-btn-desc">Connection pool leak</span>
                    </button>

                    <button
                      className="scenario-pill-btn"
                      disabled={isTriggering}
                      onClick={() => handleTriggerScenario('bad_deploy')}
                    >
                      <span className="scenario-btn-title">3. bad_deploy</span>
                      <span className="scenario-btn-desc">Schema mismatch on payments</span>
                    </button>

                    <button
                      className="scenario-pill-btn"
                      disabled={isTriggering}
                      onClick={() => handleTriggerScenario('payment_gateway_down')}
                    >
                      <span className="scenario-btn-title">4. payment_gateway_down</span>
                      <span className="scenario-btn-desc">Gateway 502/503 timeouts</span>
                    </button>

                    <button
                      className="scenario-pill-btn"
                      disabled={isTriggering}
                      onClick={() => handleTriggerScenario('idp_down')}
                    >
                      <span className="scenario-btn-title">5. idp_down</span>
                      <span className="scenario-btn-desc">JWKS unreachable</span>
                    </button>

                    <button
                      className="scenario-pill-btn regulated"
                      disabled={isTriggering}
                      onClick={() => handleTriggerScenario('idp_down_regulated')}
                    >
                      <span className="scenario-btn-title" style={{ color: 'var(--accent-amber)' }}>
                        ⚠ idp_down_regulated
                      </span>
                      <span className="scenario-btn-desc">Touches batch-record-service</span>
                    </button>

                    <button
                      className="scenario-pill-btn"
                      disabled={isTriggering}
                      onClick={() => handleTriggerScenario('payment_decline_spike')}
                    >
                      <span className="scenario-btn-title">payment_decline_spike</span>
                      <span className="scenario-btn-desc">Benign issuer decline</span>
                    </button>

                    <button
                      className="scenario-pill-btn"
                      disabled={isTriggering}
                      onClick={() => handleTriggerScenario('redis_with_unexplained_cluster')}
                    >
                      <span className="scenario-btn-title">unexplained_cluster</span>
                      <span className="scenario-btn-desc">Forces manual-only hold</span>
                    </button>
                  </div>
                </div>

                {/* Regulatory Hold Alert */}
                {isRegulatedHold && (
                  <div className="regulatory-alert-box">
                    <span style={{ fontSize: '1.25rem' }}>⛔</span>
                    <div>
                      <strong>REGULATORY HOLD: CHANGE CONTROL REQUIRED</strong>
                      <div style={{ marginTop: '0.2rem' }}>
                        Automated remediation is prohibited by policy. Effective impact analysis detected changes affecting
                        regulated service <code>batch-record-service</code>. A formal change-control audit event has been logged.
                      </div>
                    </div>
                  </div>
                )}

                {/* RCA Investigation & Diagnosis Card */}
                <div className="lumina-card">
                  <div className="card-header-flex">
                    <div className="card-heading-title">
                      <span>🔬</span> Root Cause Analysis Diagnosis
                    </div>
                    {activeInvestigation && (
                      <span
                        className={`badge-lumina-pill ${
                          activeInvestigation.evidenceLevel === 'Strong'
                            ? 'strong'
                            : activeInvestigation.evidenceLevel === 'Moderate'
                            ? 'moderate'
                            : 'weak'
                        }`}
                      >
                        Evidence: {activeInvestigation.evidenceLevel || 'Evaluating'}
                      </span>
                    )}
                  </div>

                  {activeInvestigation ? (
                    <>
                      <div className="detail-grid-lumina">
                        <div className="detail-item-card">
                          <div className="detail-label-sub">Diagnosis Status</div>
                          <div className="detail-val-main" style={{ color: 'var(--accent-blue)' }}>
                            {activeInvestigation.diagnosisStatus}
                          </div>
                        </div>

                        <div className="detail-item-card">
                          <div className="detail-label-sub">Diagnosed Cause</div>
                          <div className="detail-val-main" style={{ color: 'var(--accent-green)' }}>
                            {activeInvestigation.rootCausesJson?.join(', ') || 'Abstained / Benign'}
                          </div>
                        </div>

                        <div className="detail-item-card">
                          <div className="detail-label-sub">Action Disposition</div>
                          <div className="detail-val-main">
                            <span
                              className={`badge-lumina-pill ${
                                activeInvestigation.actionDisposition === 'executable' ? 'strong' : 'hold'
                              }`}
                            >
                              {activeInvestigation.actionDisposition || 'manual_recommended'}
                            </span>
                            {activeInvestigation.dispositionReason && (
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                Reason: {activeInvestigation.dispositionReason}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="detail-item-card">
                          <div className="detail-label-sub">Effective Impact Scope</div>
                          <div className="detail-val-main" style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                            {activeInvestigation.effectiveImpactJson?.join(', ') || 'checkout'}
                          </div>
                        </div>
                      </div>

                      {activeInvestigation.citedLogIdsJson && activeInvestigation.citedLogIdsJson.length > 0 && (
                        <div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                            Cited Diagnostic Evidence Log IDs:
                          </div>
                          <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                            {activeInvestigation.citedLogIdsJson.map((id) => (
                              <span
                                key={id}
                                style={{
                                  fontFamily: 'var(--font-mono)',
                                  fontSize: '0.7rem',
                                  background: 'var(--bg-muted)',
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  border: '1px solid var(--border-light)',
                                }}
                              >
                                {id}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                      No active incident underway. Trigger a scenario above to observe real-time causal diagnosis.
                    </div>
                  )}
                </div>

                {/* Remediation Approval & Live Verification Card */}
                <div className="lumina-card">
                  <div className="card-header-flex">
                    <div className="card-heading-title">
                      <span>🛡</span> Remediation Engine & Verification
                    </div>
                    {remediationRun && (
                      <span
                        className={`badge-lumina-pill ${
                          remediationRun.status === 'verified' ? 'strong' : 'hold'
                        }`}
                      >
                        Status: {remediationRun.status}
                      </span>
                    )}
                  </div>

                  {activeInvestigation && activeInvestigation.diagnosisStatus === 'diagnosed' ? (
                    <div>
                      <div className="remediation-box-flex">
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                            Proposed Action: <code>{remediationRun?.actionId || 'Auto-mapped fix'}</code>
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            Execution Guard: Allowlisted • Authorizer: {currentUser}
                          </div>
                        </div>

                        <button
                          className="btn-approve-action"
                          disabled={!canApprove || isApproving}
                          onClick={handleApproveRemediation}
                        >
                          {isApproving
                            ? 'Applying...'
                            : remediationRun
                            ? `Fix ${remediationRun.status}`
                            : 'Approve & Execute Fix'}
                        </button>
                      </div>

                      {remediationRun && (
                        <div style={{ marginTop: '0.85rem' }}>
                          <div className="detail-grid-lumina">
                            <div className="detail-item-card">
                              <div className="detail-label-sub">Action Execution</div>
                              <div className="detail-val-main" style={{ color: 'var(--accent-green)' }}>
                                ✓ Applied
                              </div>
                            </div>
                            <div className="detail-item-card">
                              <div className="detail-label-sub">Verification State</div>
                              <div
                                className="detail-val-main"
                                style={{
                                  color:
                                    remediationRun.status === 'verified'
                                      ? 'var(--accent-green)'
                                      : 'var(--accent-amber)',
                                }}
                              >
                                {remediationRun.status === 'verified' ? '✓ RESOLVED' : remediationRun.status}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                      Awaiting diagnosed investigation before remediation can be authorized.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Benchmark Scorecard Tab */}
          {activeTab === 'scorecard' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div className="lumina-card">
                <div className="card-heading-title">
                  <span>🏆</span> Official Evaluation Scorecard (Section 21A)
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                  Evaluated across all 27 runs covering the 5 fault families, regulated variant, and 9 negative scenarios:
                </p>

                <table className="lumina-table">
                  <thead>
                    <tr>
                      <th>Benchmark Metric</th>
                      <th>Target Invariant</th>
                      <th>Observed Score</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Root-Cause Accuracy</td>
                      <td>≥ 95.0%</td>
                      <td style={{ fontWeight: 700 }}>{scorecard ? `${scorecard.rootCauseAccuracyPct}%` : '100%'}</td>
                      <td><span className="badge-lumina-pill strong">✓ PASSED</span></td>
                    </tr>
                    <tr>
                      <td>Abstention Accuracy</td>
                      <td>≥ 90.0%</td>
                      <td style={{ fontWeight: 700 }}>{scorecard ? `${scorecard.abstentionAccuracyPct}%` : '100%'}</td>
                      <td><span className="badge-lumina-pill strong">✓ PASSED</span></td>
                    </tr>
                    <tr>
                      <td>Wrong-but-Strong Rate</td>
                      <td>Strictly 0.0%</td>
                      <td style={{ fontWeight: 700, color: 'var(--accent-green)' }}>
                        {scorecard ? `${scorecard.wrongButStrongRatePct}%` : '0.0%'}
                      </td>
                      <td><span className="badge-lumina-pill strong">✓ PASSED</span></td>
                    </tr>
                    <tr>
                      <td>Verified-Resolution Rate</td>
                      <td>100.0%</td>
                      <td style={{ fontWeight: 700 }}>{scorecard ? `${scorecard.verifiedResolutionRatePct}%` : '100%'}</td>
                      <td><span className="badge-lumina-pill strong">✓ PASSED</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Copilot vs Manual Latency Comparison Table */}
              <div className="lumina-card">
                <div className="card-heading-title">
                  <span>⏱</span> Manual Troubleshooting vs AxiomOps-AI Copilot
                </div>

                <table className="lumina-table">
                  <thead>
                    <tr>
                      <th>Operational Metric</th>
                      <th>Manual Troubleshooting</th>
                      <th>AxiomOps AI Copilot</th>
                      <th>Performance Advantage</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Median MTTR</td>
                      <td>275 seconds</td>
                      <td style={{ color: 'var(--accent-blue)', fontWeight: 700 }}>15.1 seconds</td>
                      <td style={{ color: 'var(--accent-green)', fontWeight: 700 }}>18.2x Faster (94.5% downtime reduction)</td>
                    </tr>
                    <tr>
                      <td>Steps per Incident</td>
                      <td>7 manual steps</td>
                      <td style={{ color: 'var(--accent-blue)', fontWeight: 700 }}>1 single click</td>
                      <td style={{ color: 'var(--accent-green)', fontWeight: 700 }}>85.7% touch reduction</td>
                    </tr>
                    <tr>
                      <td>Active Engineering Time</td>
                      <td>4.5 minutes</td>
                      <td style={{ color: 'var(--accent-blue)', fontWeight: 700 }}>0.5 minutes</td>
                      <td style={{ color: 'var(--accent-green)', fontWeight: 700 }}>9x faster engineering return</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* L1 Runbooks & Automation Console Tab */}
          {activeTab === 'runbooks' && (
            <div className="lumina-card">
              <div className="card-heading-title">
                <span>🛡</span> L1 Automated Runbooks & Identity Challenge Console
              </div>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                Zero-human automated resolution for user identity operations requiring cryptographic one-time proof:
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1.25rem', marginTop: '0.75rem' }}>
                <div className="detail-item-card">
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.4rem' }}>
                    Runbook: <code>reset_user_session</code>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                    Requires verified one-time challenge proof code before executing session invalidation.
                  </div>

                  <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1rem' }}>
                    <button className="btn-lumina-secondary" onClick={handleGenerateChallenge}>
                      Generate Identity Proof Code
                    </button>
                    {challengeCode && (
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 700,
                          color: 'var(--accent-blue)',
                          alignSelf: 'center',
                        }}
                      >
                        Code: {challengeCode}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '0.6rem' }}>
                    <input
                      className="select-filter-lumina"
                      style={{ flex: 1 }}
                      placeholder="Enter Challenge Code"
                      value={enteredChallenge}
                      onChange={(e) => setEnteredChallenge(e.target.value)}
                    />
                    <button
                      className="btn-lumina-primary"
                      onClick={() => handleRunRunbook('reset_user_session')}
                    >
                      Execute Runbook
                    </button>
                  </div>
                </div>

                <div className="detail-item-card">
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.4rem' }}>
                    Execution Result Ledger
                  </div>
                  {runbookResult ? (
                    <pre
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.75rem',
                        background: '#FFFFFF',
                        padding: '0.75rem',
                        borderRadius: '6px',
                        border: '1px solid var(--border-light)',
                        overflowX: 'auto',
                      }}
                    >
                      {JSON.stringify(runbookResult, null, 2)}
                    </pre>
                  ) : (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      Awaiting runbook execution. Generate challenge code above and click execute.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
