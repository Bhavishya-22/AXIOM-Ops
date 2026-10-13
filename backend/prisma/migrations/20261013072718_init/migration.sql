-- CreateTable
CREATE TABLE "Log" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "service" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "signal" TEXT,
    "signalKind" TEXT,
    "ruleVersion" TEXT,
    "messageHash" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "serviceSeq" INTEGER NOT NULL,
    "class" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "pinnedByIncidentId" TEXT,
    "serviceVersion" TEXT,
    "requestId" TEXT,
    "traceId" TEXT,
    "origin" TEXT NOT NULL,
    "meta" JSONB,

    CONSTRAINT "Log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestGap" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "services" TEXT[],
    "fromTs" TIMESTAMP(3) NOT NULL,
    "toTs" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricSample" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "sessionId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "requestsTotal" INTEGER NOT NULL,
    "successesTotal" INTEGER NOT NULL,
    "errorsTotal" INTEGER NOT NULL,
    "businessOutcomesTotal" INTEGER NOT NULL,
    "cacheHitsTotal" INTEGER NOT NULL DEFAULT 0,
    "cacheLookupsTotal" INTEGER NOT NULL DEFAULT 0,
    "gauges" JSONB,
    "latencyBucketsJson" JSONB,
    "scenarioCountersJson" JSONB,

    CONSTRAINT "MetricSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "scenarioRunId" TEXT,
    "sessionId" TEXT NOT NULL,
    "openSlot" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "baselineMetricsJson" JSONB,
    "humanDetectedAt" TIMESTAMP(3),

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "services" TEXT[],
    "ticketType" TEXT NOT NULL DEFAULT 'incident_report',
    "status" TEXT NOT NULL DEFAULT 'open',
    "incidentId" TEXT,
    "linkStatus" TEXT NOT NULL DEFAULT 'none',
    "source" TEXT NOT NULL DEFAULT 'auto',
    "autoKey" TEXT,
    "requesterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Investigation" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "classification" TEXT,
    "diagnosisStatus" TEXT,
    "causeMode" TEXT,
    "actionDisposition" TEXT,
    "dispositionReason" TEXT,
    "rootCauses" TEXT[],
    "suppressedJson" JSONB,
    "unresolvedClustersJson" JSONB,
    "effectiveImpactJson" JSONB,
    "regulatedHold" BOOLEAN NOT NULL DEFAULT false,
    "evidenceComplete" BOOLEAN NOT NULL DEFAULT true,
    "evidenceLevel" TEXT,
    "levelReasonsJson" JSONB,
    "evidenceSnapshotJson" JSONB,
    "resultJson" JSONB,
    "timingsJson" JSONB,
    "investigationStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcomeAt" TIMESTAMP(3),
    "autoKey" TEXT,

    CONSTRAINT "Investigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemediationRun" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "executionState" TEXT NOT NULL DEFAULT 'pending',
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "activeIncidentId" TEXT,
    "approvedBy" TEXT NOT NULL,
    "approverRole" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "appliedCountersJson" JSONB,
    "incidentMetricsJson" JSONB,
    "afterMetricsJson" JSONB,
    "verificationJson" JSONB,
    "outcome" TEXT,

    CONSTRAINT "RemediationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoUser" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeployEvent" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "service" TEXT NOT NULL,
    "fromVersion" TEXT NOT NULL,
    "toVersion" TEXT NOT NULL,
    "schemaCompatibleRollback" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DeployEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "incidentId" TEXT,
    "ticketId" TEXT,
    "investigationId" TEXT,
    "remediationRunId" TEXT,
    "actor" TEXT NOT NULL,
    "actorRole" TEXT,
    "type" TEXT NOT NULL,
    "evidenceLogIds" TEXT[],
    "payloadJson" JSONB,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalCase" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "symptoms" TEXT[],
    "signals" TEXT[],
    "services" TEXT[],
    "categories" TEXT[],
    "rootCause" TEXT NOT NULL,
    "resolutionSteps" TEXT[],
    "actionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "provenanceJson" JSONB,
    "evidenceHash" TEXT,

    CONSTRAINT "HistoricalCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expectedLabel" TEXT NOT NULL,
    "predictedLabel" TEXT NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "evidenceConsistent" BOOLEAN NOT NULL,
    "actionCorrect" BOOLEAN NOT NULL,
    "unsafeAction" BOOLEAN NOT NULL,
    "resolved" BOOLEAN NOT NULL,
    "timingsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Log_service_ts_idx" ON "Log"("service", "ts");

-- CreateIndex
CREATE INDEX "Log_category_ts_idx" ON "Log"("category", "ts");

-- CreateIndex
CREATE INDEX "Log_signal_ts_idx" ON "Log"("signal", "ts");

-- CreateIndex
CREATE INDEX "Log_sessionId_ts_idx" ON "Log"("sessionId", "ts");

-- CreateIndex
CREATE INDEX "Log_messageHash_idx" ON "Log"("messageHash");

-- CreateIndex
CREATE UNIQUE INDEX "Log_origin_sessionId_service_serviceSeq_key" ON "Log"("origin", "sessionId", "service", "serviceSeq");

-- CreateIndex
CREATE INDEX "MetricSample_sessionId_service_ts_idx" ON "MetricSample"("sessionId", "service", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_openSlot_key" ON "Incident"("openSlot");

-- CreateIndex
CREATE INDEX "Incident_sessionId_idx" ON "Incident"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_autoKey_key" ON "Ticket"("autoKey");

-- CreateIndex
CREATE UNIQUE INDEX "Investigation_autoKey_key" ON "Investigation"("autoKey");

-- CreateIndex
CREATE UNIQUE INDEX "RemediationRun_idempotencyKey_key" ON "RemediationRun"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RemediationRun_activeIncidentId_key" ON "RemediationRun"("activeIncidentId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investigation" ADD CONSTRAINT "Investigation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemediationRun" ADD CONSTRAINT "RemediationRun_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemediationRun" ADD CONSTRAINT "RemediationRun_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_remediationRunId_fkey" FOREIGN KEY ("remediationRunId") REFERENCES "RemediationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
