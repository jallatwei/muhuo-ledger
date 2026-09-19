-- CreateEnum
CREATE TYPE "TaxpayerType" AS ENUM ('GENERAL', 'SMALL_SCALE');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSING', 'CLOSED');

-- CreateEnum
CREATE TYPE "AccountCategory" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'COST', 'PROFIT_LOSS');

-- CreateEnum
CREATE TYPE "BalanceDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "AuxDimension" AS ENUM ('CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'PROJECT', 'DEPARTMENT', 'CONTRACT');

-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('DRAFT', 'REVIEWING', 'APPROVED', 'POSTED', 'REVERSED', 'VOID');

-- CreateEnum
CREATE TYPE "VoucherSource" AS ENUM ('MANUAL', 'INVOICE', 'BANK', 'PAYROLL', 'CLOSING', 'OPENING');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('INVOICE_SALES', 'INVOICE_PURCHASE', 'BANK_SLIP', 'BANK_STATEMENT', 'CONTRACT', 'RECEIPT', 'OTHER');

-- CreateEnum
CREATE TYPE "DocSource" AS ENUM ('UPLOAD', 'WATCH_FOLDER', 'EMAIL', 'SCAN');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'EXTRACTING', 'EXTRACTED', 'REVIEW_REQUIRED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PartnerRole" AS ENUM ('CUSTOMER', 'SUPPLIER', 'BOTH', 'EMPLOYEE', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceDirection" AS ENUM ('OUTPUT', 'INPUT');

-- CreateEnum
CREATE TYPE "InvoiceCategory" AS ENUM ('SPECIAL_VAT', 'GENERAL_VAT', 'E_INVOICE', 'TRAIN', 'AIR', 'TOLL', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('IMPORTED', 'AUTO_DRAFTED', 'POSTED', 'MATCHED', 'RECONCILED', 'IGNORED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "RuleTrigger" AS ENUM ('INVOICE_INPUT', 'INVOICE_OUTPUT', 'BANK_IN', 'BANK_OUT', 'BANK_FEE', 'BANK_INTEREST', 'SALARY_ACCRUAL', 'SALARY_PAYMENT', 'DEPRECIATION', 'AMORTIZATION', 'TAX_PAYMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskCategory" AS ENUM ('TAX', 'ACCOUNTING', 'FRAUD', 'COMPLIANCE', 'AI');

-- CreateEnum
CREATE TYPE "RiskAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "CloseRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'REVERTED');

-- CreateTable
CREATE TABLE "entity" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unifiedSocialCreditCode" TEXT,
    "taxpayerType" "TaxpayerType" NOT NULL DEFAULT 'GENERAL',
    "accountingStandard" TEXT NOT NULL DEFAULT 'SMALL_ENTERPRISE_2013',
    "baseCurrency" TEXT NOT NULL DEFAULT 'CNY',
    "taxAuthority" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "legalPerson" TEXT,
    "accountantName" TEXT,
    "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 1,
    "bookkeepingEnforced" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "period" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "reopenedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_year" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "fiscal_year_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "parentId" TEXT,
    "level" INTEGER NOT NULL,
    "category" "AccountCategory" NOT NULL,
    "direction" "BalanceDirection" NOT NULL,
    "isLeaf" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "reportItem" TEXT,
    "cashflowTag" TEXT,
    "taxTag" TEXT,
    "auxRequired" "AuxDimension"[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "docType" "DocType" NOT NULL,
    "detectedType" "DocType",
    "source" "DocSource" NOT NULL DEFAULT 'UPLOAD',
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "pageCount" INTEGER,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rawNames" TEXT[],
    "role" "PartnerRole"[],
    "taxNo" TEXT,
    "bankName" TEXT,
    "bankAccount" TEXT,
    "addressPhone" TEXT,
    "defaultAccountId" TEXT,
    "defaultArApAccountId" TEXT,
    "riskLevel" TEXT NOT NULL DEFAULT 'NORMAL',
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "contractNo" TEXT,
    "name" TEXT NOT NULL,
    "counterpartyId" TEXT,
    "direction" TEXT NOT NULL,
    "amountInclTax" DECIMAL(18,2) NOT NULL,
    "taxRate" DECIMAL(6,4),
    "signDate" DATE,
    "startDate" DATE,
    "endDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "documentId" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "direction" "InvoiceDirection" NOT NULL,
    "category" "InvoiceCategory" NOT NULL,
    "invoiceCode" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "digitalInvoiceNo" TEXT,
    "invoiceDate" DATE NOT NULL,
    "sellerTaxNo" TEXT,
    "sellerName" TEXT NOT NULL,
    "buyerTaxNo" TEXT,
    "buyerName" TEXT NOT NULL,
    "amountExclTax" DECIMAL(18,2) NOT NULL,
    "taxRate" DECIMAL(6,4) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "amountInclTax" DECIMAL(18,2) NOT NULL,
    "isRedFlushed" BOOLEAN NOT NULL DEFAULT false,
    "originalInvoiceId" TEXT,
    "isDeductible" BOOLEAN NOT NULL DEFAULT true,
    "businessType" TEXT,
    "accountId" TEXT,
    "partnerId" TEXT,
    "contractId" TEXT,
    "documentId" TEXT,
    "extractionId" TEXT,
    "matchedTransactionId" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'IMPORTED',
    "reviewNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "dedupHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemName" TEXT NOT NULL,
    "spec" TEXT,
    "unit" TEXT,
    "quantity" DECIMAL(18,4),
    "unitPrice" DECIMAL(18,6),
    "amountExclTax" DECIMAL(18,2) NOT NULL,
    "taxRate" DECIMAL(6,4) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "accountId" TEXT,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transaction" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "accountId" TEXT,
    "bankAccountNo" TEXT NOT NULL,
    "txnDate" DATE NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "balanceAfter" DECIMAL(18,2),
    "counterpartyName" TEXT,
    "counterpartyAccountNo" TEXT,
    "summary" TEXT,
    "bankSerialNo" TEXT,
    "dedupHash" TEXT NOT NULL,
    "counterpartAccountId" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "sourceDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allocatedBy" TEXT,
    "isAuto" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_link" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "linkType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_voucher" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "voucherWord" TEXT NOT NULL DEFAULT '记',
    "voucherNo" INTEGER NOT NULL,
    "voucherDate" DATE NOT NULL,
    "status" "VoucherStatus" NOT NULL DEFAULT 'DRAFT',
    "totalDebit" DECIMAL(18,2) NOT NULL,
    "totalCredit" DECIMAL(18,2) NOT NULL,
    "summary" TEXT NOT NULL,
    "attachments" INTEGER NOT NULL DEFAULT 0,
    "sourceType" "VoucherSource" NOT NULL,
    "sourceId" TEXT,
    "idempotencyKey" TEXT,
    "ruleId" TEXT,
    "ruleReason" TEXT,
    "ruleVersion" INTEGER,
    "confidence" DECIMAL(5,4),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "postedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversesId" TEXT,
    "voidReason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_sequence" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "voucherWord" TEXT NOT NULL,
    "nextNo" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "voucher_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_line" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "direction" "BalanceDirection" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "summary" TEXT,
    "partnerId" TEXT,
    "auxProject" TEXT,
    "auxDepartment" TEXT,
    "contractId" TEXT,
    "taxRate" DECIMAL(6,4),
    "taxAmount" DECIMAL(18,2),
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_balance" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "openingDebit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "openingCredit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "debitOccurred" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditOccurred" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "closingDebit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "closingCredit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "period_close_run" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "CloseRunStatus" NOT NULL DEFAULT 'RUNNING',
    "steps" JSONB NOT NULL,
    "startedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "period_close_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "period_check_result" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "detail" TEXT,
    "metrics" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "period_check_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_rule" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" "RuleTrigger" NOT NULL,
    "conditions" JSONB NOT NULL,
    "template" JSONB NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL DEFAULT 0.9500,
    "autoPost" BOOLEAN NOT NULL DEFAULT false,
    "autoPostMaxAmount" DECIMAL(18,2),
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classification_override" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "supplierTaxNo" TEXT,
    "keyword" TEXT,
    "amountBucket" TEXT,
    "accountId" TEXT NOT NULL,
    "taxTreatment" TEXT,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classification_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_mapping" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sign" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "account_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_profile" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "taxpayerType" "TaxpayerType" NOT NULL DEFAULT 'GENERAL',
    "vatFilingCycle" TEXT NOT NULL DEFAULT 'MONTHLY',
    "citPrepayCycle" TEXT NOT NULL DEFAULT 'QUARTERLY',
    "isSmallLowProfit" BOOLEAN NOT NULL DEFAULT true,
    "surtaxRates" JSONB NOT NULL,
    "surtaxReduction" DECIMAL(6,4),
    "surtaxLocation" TEXT NOT NULL DEFAULT 'CITY',
    "invoiceCertMode" TEXT NOT NULL DEFAULT 'AUTO_ON_IMPORT',
    "smallProfitDeductionRate" DECIMAL(6,4),
    "smallProfitTaxRate" DECIMAL(6,4),
    "policyNote" TEXT,
    "policyEffectiveFrom" DATE,
    "policyEffectiveTo" DATE,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_period" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "taxType" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "quarter" INTEGER,
    "month" INTEGER,
    "label" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "tax_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_certification" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "certifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "certifiedBy" TEXT,
    "method" TEXT NOT NULL DEFAULT 'HOOK',
    "deductibleTax" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CERTIFIED',
    "remark" TEXT,

    CONSTRAINT "vat_certification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_period_aggregate" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "taxPeriodId" TEXT NOT NULL,
    "outputTax" JSONB NOT NULL,
    "inputTax" JSONB NOT NULL,
    "taxPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxCredited" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxPayableFinal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "surtax" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vat_period_aggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_filing" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "taxType" TEXT NOT NULL,
    "taxPeriodId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB NOT NULL,
    "tieOut" JSONB,
    "filedAt" TIMESTAMP(3),
    "filedBy" TEXT,
    "receiptNo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_filing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_call_log" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptKey" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "rawResponse" JSONB,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "costEstimate" DECIMAL(12,6),
    "latencyMs" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "errorMessage" TEXT,
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_call_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extraction_result" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "overallConfidence" DECIMAL(5,4) NOT NULL,
    "rawText" TEXT,
    "aiCallLogId" TEXT,
    "schemaVersion" TEXT NOT NULL DEFAULT 'v1',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "corrections" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extraction_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_rule" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "RiskCategory" NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'SQL',
    "definition" JSONB NOT NULL,
    "level" "RiskLevel" NOT NULL DEFAULT 'WARNING',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "risk_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_alert" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "level" "RiskLevel" NOT NULL,
    "category" "RiskCategory" NOT NULL,
    "periodId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "suggestion" TEXT,
    "evidence" JSONB,
    "status" "RiskAlertStatus" NOT NULL DEFAULT 'OPEN',
    "handledBy" TEXT,
    "handledAt" TIMESTAMP(3),
    "handleNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OPERATOR',
    "entityIds" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "beforeData" JSONB,
    "afterData" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_queue" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "job_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "remark" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "period_entityId_status_idx" ON "period"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "period_entityId_fiscalYear_month_key" ON "period"("entityId", "fiscalYear", "month");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_year_entityId_year_key" ON "fiscal_year"("entityId", "year");

-- CreateIndex
CREATE INDEX "account_entityId_parentId_idx" ON "account"("entityId", "parentId");

-- CreateIndex
CREATE INDEX "account_entityId_reportItem_idx" ON "account"("entityId", "reportItem");

-- CreateIndex
CREATE INDEX "account_entityId_taxTag_idx" ON "account"("entityId", "taxTag");

-- CreateIndex
CREATE UNIQUE INDEX "account_entityId_code_key" ON "account"("entityId", "code");

-- CreateIndex
CREATE INDEX "document_entityId_status_idx" ON "document"("entityId", "status");

-- CreateIndex
CREATE INDEX "document_entityId_docType_idx" ON "document"("entityId", "docType");

-- CreateIndex
CREATE UNIQUE INDEX "document_entityId_contentHash_key" ON "document"("entityId", "contentHash");

-- CreateIndex
CREATE INDEX "partner_entityId_name_idx" ON "partner"("entityId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "partner_entityId_taxNo_key" ON "partner"("entityId", "taxNo");

-- CreateIndex
CREATE INDEX "contract_entityId_direction_idx" ON "contract"("entityId", "direction");

-- CreateIndex
CREATE INDEX "contract_entityId_counterpartyId_idx" ON "contract"("entityId", "counterpartyId");

-- CreateIndex
CREATE INDEX "invoice_entityId_invoiceDate_idx" ON "invoice"("entityId", "invoiceDate");

-- CreateIndex
CREATE INDEX "invoice_entityId_status_idx" ON "invoice"("entityId", "status");

-- CreateIndex
CREATE INDEX "invoice_entityId_dedupHash_idx" ON "invoice"("entityId", "dedupHash");

-- CreateIndex
CREATE INDEX "invoice_entityId_partnerId_idx" ON "invoice"("entityId", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_entityId_direction_invoiceCode_invoiceNumber_isRedF_key" ON "invoice"("entityId", "direction", "invoiceCode", "invoiceNumber", "isRedFlushed");

-- CreateIndex
CREATE INDEX "invoice_line_invoiceId_idx" ON "invoice_line"("invoiceId");

-- CreateIndex
CREATE INDEX "bank_transaction_entityId_txnDate_idx" ON "bank_transaction"("entityId", "txnDate");

-- CreateIndex
CREATE INDEX "bank_transaction_entityId_matchStatus_idx" ON "bank_transaction"("entityId", "matchStatus");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transaction_entityId_dedupHash_key" ON "bank_transaction"("entityId", "dedupHash");

-- CreateIndex
CREATE INDEX "payment_allocation_entityId_idx" ON "payment_allocation"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocation_invoiceId_transactionId_key" ON "payment_allocation"("invoiceId", "transactionId");

-- CreateIndex
CREATE INDEX "document_link_entityId_idx" ON "document_link"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "document_link_fromType_fromId_toType_toId_linkType_key" ON "document_link"("fromType", "fromId", "toType", "toId", "linkType");

-- CreateIndex
CREATE INDEX "journal_voucher_entityId_periodId_status_idx" ON "journal_voucher"("entityId", "periodId", "status");

-- CreateIndex
CREATE INDEX "journal_voucher_entityId_voucherDate_idx" ON "journal_voucher"("entityId", "voucherDate");

-- CreateIndex
CREATE INDEX "journal_voucher_entityId_sourceType_sourceId_idx" ON "journal_voucher"("entityId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_voucher_entityId_voucherWord_periodYear_periodMonth_key" ON "journal_voucher"("entityId", "voucherWord", "periodYear", "periodMonth", "voucherNo");

-- CreateIndex
CREATE UNIQUE INDEX "journal_voucher_entityId_idempotencyKey_key" ON "journal_voucher"("entityId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_sequence_entityId_periodId_voucherWord_key" ON "voucher_sequence"("entityId", "periodId", "voucherWord");

-- CreateIndex
CREATE INDEX "journal_line_entityId_periodId_accountId_idx" ON "journal_line"("entityId", "periodId", "accountId");

-- CreateIndex
CREATE INDEX "journal_line_entityId_accountId_voucherId_idx" ON "journal_line"("entityId", "accountId", "voucherId");

-- CreateIndex
CREATE INDEX "journal_line_voucherId_idx" ON "journal_line"("voucherId");

-- CreateIndex
CREATE INDEX "journal_line_invoiceId_idx" ON "journal_line"("invoiceId");

-- CreateIndex
CREATE INDEX "journal_line_entityId_partnerId_idx" ON "journal_line"("entityId", "partnerId");

-- CreateIndex
CREATE INDEX "account_balance_entityId_periodId_idx" ON "account_balance"("entityId", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "account_balance_entityId_periodId_accountId_key" ON "account_balance"("entityId", "periodId", "accountId");

-- CreateIndex
CREATE INDEX "period_close_run_entityId_periodId_idx" ON "period_close_run"("entityId", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "period_check_result_entityId_periodId_code_key" ON "period_check_result"("entityId", "periodId", "code");

-- CreateIndex
CREATE INDEX "journal_rule_entityId_trigger_priority_idx" ON "journal_rule"("entityId", "trigger", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "journal_rule_entityId_code_key" ON "journal_rule"("entityId", "code");

-- CreateIndex
CREATE INDEX "classification_override_entityId_supplierTaxNo_idx" ON "classification_override"("entityId", "supplierTaxNo");

-- CreateIndex
CREATE UNIQUE INDEX "classification_override_entityId_featureKey_key" ON "classification_override"("entityId", "featureKey");

-- CreateIndex
CREATE UNIQUE INDEX "account_mapping_entityId_purpose_itemCode_accountId_key" ON "account_mapping"("entityId", "purpose", "itemCode", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "tax_profile_entityId_key" ON "tax_profile"("entityId");

-- CreateIndex
CREATE INDEX "tax_period_entityId_taxType_year_idx" ON "tax_period"("entityId", "taxType", "year");

-- CreateIndex
CREATE UNIQUE INDEX "tax_period_entityId_taxType_label_key" ON "tax_period"("entityId", "taxType", "label");

-- CreateIndex
CREATE INDEX "vat_certification_entityId_periodId_idx" ON "vat_certification"("entityId", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "vat_certification_invoiceId_periodId_key" ON "vat_certification"("invoiceId", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "vat_period_aggregate_entityId_taxPeriodId_key" ON "vat_period_aggregate"("entityId", "taxPeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "tax_filing_entityId_taxType_taxPeriodId_key" ON "tax_filing"("entityId", "taxType", "taxPeriodId");

-- CreateIndex
CREATE INDEX "ai_call_log_entityId_purpose_createdAt_idx" ON "ai_call_log"("entityId", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "ai_call_log_requestHash_idx" ON "ai_call_log"("requestHash");

-- CreateIndex
CREATE INDEX "extraction_result_entityId_documentId_idx" ON "extraction_result"("entityId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "risk_rule_entityId_code_key" ON "risk_rule"("entityId", "code");

-- CreateIndex
CREATE INDEX "risk_alert_entityId_status_level_idx" ON "risk_alert"("entityId", "status", "level");

-- CreateIndex
CREATE INDEX "risk_alert_entityId_periodId_idx" ON "risk_alert"("entityId", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "audit_log_entityId_subjectType_subjectId_idx" ON "audit_log"("entityId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "job_queue_status_availableAt_priority_idx" ON "job_queue"("status", "availableAt", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "system_config_entityId_key_key" ON "system_config"("entityId", "key");

-- AddForeignKey
ALTER TABLE "period" ADD CONSTRAINT "period_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_year" ADD CONSTRAINT "fiscal_year_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner" ADD CONSTRAINT "partner_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract" ADD CONSTRAINT "contract_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "bank_transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_voucher" ADD CONSTRAINT "journal_voucher_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "journal_voucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_balance" ADD CONSTRAINT "account_balance_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "period_close_run" ADD CONSTRAINT "period_close_run_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "period_check_result" ADD CONSTRAINT "period_check_result_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_rule" ADD CONSTRAINT "journal_rule_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_override" ADD CONSTRAINT "classification_override_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_mapping" ADD CONSTRAINT "account_mapping_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_profile" ADD CONSTRAINT "tax_profile_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_period" ADD CONSTRAINT "tax_period_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vat_certification" ADD CONSTRAINT "vat_certification_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vat_certification" ADD CONSTRAINT "vat_certification_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vat_period_aggregate" ADD CONSTRAINT "vat_period_aggregate_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_filing" ADD CONSTRAINT "tax_filing_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_result" ADD CONSTRAINT "extraction_result_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_result" ADD CONSTRAINT "extraction_result_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_rule" ADD CONSTRAINT "risk_rule_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_alert" ADD CONSTRAINT "risk_alert_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
