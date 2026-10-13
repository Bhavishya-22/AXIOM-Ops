-- Custom SQL migration for one active remediation partial unique index per Section 12
CREATE UNIQUE INDEX IF NOT EXISTS one_active_remediation
  ON "RemediationRun" ("incidentId") WHERE status = 'in_progress';
