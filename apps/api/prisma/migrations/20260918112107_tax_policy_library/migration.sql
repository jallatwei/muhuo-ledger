-- CreateTable
CREATE TABLE "tax_policy_fetch_run" (
    "id" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "sourcesTried" INTEGER NOT NULL DEFAULT 0,
    "sourcesFailed" INTEGER NOT NULL DEFAULT 0,
    "policiesFound" INTEGER NOT NULL DEFAULT 0,
    "policiesNew" INTEGER NOT NULL DEFAULT 0,
    "policiesChanged" INTEGER NOT NULL DEFAULT 0,
    "sourceResults" JSONB,
    "warnings" JSONB,
    "errorMessage" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_policy_fetch_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_policy_record" (
    "id" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "issuer" TEXT,
    "title" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceName" TEXT,
    "documentNo" TEXT,
    "publishedAt" DATE,
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "rawExcerpt" TEXT,
    "rawContent" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPCOMING',
    "taxTypes" TEXT[],
    "keywords" TEXT[],
    "needsReview" BOOLEAN NOT NULL DEFAULT true,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_policy_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_policy_fetch_run_jurisdiction_startedAt_idx" ON "tax_policy_fetch_run"("jurisdiction", "startedAt");

-- CreateIndex
CREATE INDEX "tax_policy_record_jurisdiction_effectiveFrom_idx" ON "tax_policy_record"("jurisdiction", "effectiveFrom");

-- CreateIndex
CREATE INDEX "tax_policy_record_status_effectiveFrom_idx" ON "tax_policy_record"("status", "effectiveFrom");

-- CreateIndex
CREATE INDEX "tax_policy_record_needsReview_idx" ON "tax_policy_record"("needsReview");

-- CreateIndex
CREATE UNIQUE INDEX "tax_policy_record_jurisdiction_sourceUrl_key" ON "tax_policy_record"("jurisdiction", "sourceUrl");

-- RenameIndex
ALTER INDEX "journal_voucher_no_lookup" RENAME TO "journal_voucher_entityId_voucherWord_periodYear_periodMonth_idx";
