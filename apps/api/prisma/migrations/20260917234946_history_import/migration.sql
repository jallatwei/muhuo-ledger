-- CreateEnum
CREATE TYPE "HistorySourceType" AS ENUM ('INVOICE_SALES', 'INVOICE_PURCHASE', 'VAT_FILING', 'CIT_FILING', 'FINANCIAL_STATEMENT');

-- CreateEnum
CREATE TYPE "HistoryInvoiceKind" AS ENUM ('SPECIAL_VAT', 'GENERAL_VAT', 'E_INVOICE', 'TOLL', 'TRAIN', 'AIR', 'OTHER');

-- CreateEnum
CREATE TYPE "HistoryFilingType" AS ENUM ('VAT_MONTHLY', 'VAT_QUARTERLY', 'CIT_QUARTERLY', 'CIT_ANNUAL', 'SURTAX', 'STAMP_DUTY');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('UPLOADED', 'PARSING', 'MAPPING', 'IMPORTED', 'FAILED');

-- CreateEnum
CREATE TYPE "HistoryReconStatus" AS ENUM ('PENDING', 'MATCHED', 'MISMATCHED', 'MANUAL', 'IGNORED');

-- CreateEnum
CREATE TYPE "ReconstructionStatus" AS ENUM ('PENDING', 'INPUTS_READY', 'RECONCILED', 'DERIVED', 'NEEDS_INPUT', 'READY', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "OpeningSource" AS ENUM ('DECLARED', 'INVOICE', 'DERIVED', 'MANUAL');

-- CreateEnum
CREATE TYPE "OpeningProposalStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'POSTED', 'REJECTED');

-- CreateTable
CREATE TABLE "history_import_batch" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sourceType" "HistorySourceType" NOT NULL,
    "fileName" TEXT,
    "fileHash" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "columnMapping" JSONB,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "errorLog" JSONB,
    "importedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "history_import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "history_invoice_record" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "batchId" TEXT,
    "direction" "InvoiceDirection" NOT NULL,
    "kind" "HistoryInvoiceKind" NOT NULL DEFAULT 'SPECIAL_VAT',
    "invoiceCode" TEXT,
    "invoiceNumber" TEXT,
    "invoiceDate" DATE NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "counterpartyName" TEXT NOT NULL,
    "counterpartyTaxNo" TEXT,
    "amountExclTax" DECIMAL(18,2) NOT NULL,
    "taxRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "amountInclTax" DECIMAL(18,2) NOT NULL,
    "isCertified" BOOLEAN NOT NULL DEFAULT false,
    "isDeducted" BOOLEAN NOT NULL DEFAULT true,
    "isRedFlushed" BOOLEAN NOT NULL DEFAULT false,
    "itemSummary" TEXT,
    "aiCategory" TEXT,
    "aiConfidence" DECIMAL(5,4),
    "reconPeriodLabel" TEXT,
    "reconStatus" "HistoryReconStatus" NOT NULL DEFAULT 'PENDING',
    "reconNote" TEXT,
    "dedupHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "history_invoice_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "history_filing_record" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "batchId" TEXT,
    "filingType" "HistoryFilingType" NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER,
    "periodQuarter" INTEGER,
    "salesExclTax" DECIMAL(18,2),
    "outputTax" DECIMAL(18,2),
    "inputTax" DECIMAL(18,2),
    "inputTaxTransferOut" DECIMAL(18,2),
    "taxCreditBroughtForward" DECIMAL(18,2),
    "taxPayable" DECIMAL(18,2),
    "taxPaid" DECIMAL(18,2),
    "taxUnpaidEnd" DECIMAL(18,2),
    "surtax" DECIMAL(18,2),
    "citRevenue" DECIMAL(18,2),
    "citCost" DECIMAL(18,2),
    "citProfitBefore" DECIMAL(18,2),
    "citTaxPayable" DECIMAL(18,2),
    "citTaxPaid" DECIMAL(18,2),
    "citAdjustUp" DECIMAL(18,2),
    "rawRow" JSONB,
    "reconStatus" "HistoryReconStatus" NOT NULL DEFAULT 'PENDING',
    "reconNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "history_filing_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "history_reconstruction" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "ReconstructionStatus" NOT NULL DEFAULT 'PENDING',
    "steps" JSONB,
    "salesInvoiceCount" INTEGER NOT NULL DEFAULT 0,
    "salesAmountExclTax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "salesTaxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "purchaseInvoiceCount" INTEGER NOT NULL DEFAULT 0,
    "purchaseAmountExclTax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "purchaseTaxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "certifiedTaxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "declaredSalesExclTax" DECIMAL(18,2),
    "declaredOutputTax" DECIMAL(18,2),
    "declaredInputTax" DECIMAL(18,2),
    "declaredTaxPayable" DECIMAL(18,2),
    "declaredTaxPaid" DECIMAL(18,2),
    "declaredSurtax" DECIMAL(18,2),
    "salesDiff" DECIMAL(18,2),
    "purchaseDiff" DECIMAL(18,2),
    "reconciliationNote" TEXT,
    "profitBeforeTax" DECIMAL(18,2),
    "derivedCost" DECIMAL(18,2),
    "invoicedCost" DECIMAL(18,2),
    "costWithoutInvoice" DECIMAL(18,2),
    "incomeTaxExpense" DECIMAL(18,2),
    "incomeTaxPayable" DECIMAL(18,2),
    "netProfit" DECIMAL(18,2),
    "requiredInputs" JSONB,
    "aiSummary" TEXT,
    "aiWarnings" JSONB,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "history_reconstruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_balance_proposal" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "targetPeriodId" TEXT NOT NULL,
    "targetYear" INTEGER NOT NULL,
    "targetMonth" INTEGER NOT NULL,
    "status" "OpeningProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "totalDebit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalCredit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "difference" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cashBasis" TEXT NOT NULL DEFAULT 'DERIVED',
    "actualCashBalance" DECIMAL(18,2),
    "aiSummary" TEXT,
    "warnings" JSONB,
    "voucherId" TEXT,
    "postedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opening_balance_proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_balance_line" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "direction" "BalanceDirection" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "source" "OpeningSource" NOT NULL,
    "sourceNote" TEXT NOT NULL,
    "breakdown" JSONB,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "opening_balance_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_balance_source_ref" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT,
    "note" TEXT NOT NULL,
    "amount" DECIMAL(18,2),

    CONSTRAINT "opening_balance_source_ref_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "history_import_batch_entityId_sourceType_createdAt_idx" ON "history_import_batch"("entityId", "sourceType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "history_import_batch_entityId_fileHash_key" ON "history_import_batch"("entityId", "fileHash");

-- CreateIndex
CREATE INDEX "history_invoice_record_entityId_direction_periodYear_period_idx" ON "history_invoice_record"("entityId", "direction", "periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "history_invoice_record_entityId_reconStatus_idx" ON "history_invoice_record"("entityId", "reconStatus");

-- CreateIndex
CREATE UNIQUE INDEX "history_invoice_record_entityId_dedupHash_key" ON "history_invoice_record"("entityId", "dedupHash");

-- CreateIndex
CREATE INDEX "history_filing_record_entityId_periodYear_idx" ON "history_filing_record"("entityId", "periodYear");

-- CreateIndex
CREATE UNIQUE INDEX "history_filing_record_entityId_filingType_periodLabel_key" ON "history_filing_record"("entityId", "filingType", "periodLabel");

-- CreateIndex
CREATE INDEX "history_reconstruction_entityId_status_idx" ON "history_reconstruction"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "history_reconstruction_entityId_year_key" ON "history_reconstruction"("entityId", "year");

-- CreateIndex
CREATE INDEX "opening_balance_proposal_entityId_status_idx" ON "opening_balance_proposal"("entityId", "status");

-- CreateIndex
CREATE INDEX "opening_balance_line_proposalId_idx" ON "opening_balance_line"("proposalId");

-- CreateIndex
CREATE INDEX "opening_balance_source_ref_proposalId_idx" ON "opening_balance_source_ref"("proposalId");

-- AddForeignKey
ALTER TABLE "history_import_batch" ADD CONSTRAINT "history_import_batch_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "history_invoice_record" ADD CONSTRAINT "history_invoice_record_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "history_invoice_record" ADD CONSTRAINT "history_invoice_record_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "history_import_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "history_filing_record" ADD CONSTRAINT "history_filing_record_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "history_filing_record" ADD CONSTRAINT "history_filing_record_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "history_import_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "history_reconstruction" ADD CONSTRAINT "history_reconstruction_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balance_proposal" ADD CONSTRAINT "opening_balance_proposal_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balance_line" ADD CONSTRAINT "opening_balance_line_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "opening_balance_proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balance_source_ref" ADD CONSTRAINT "opening_balance_source_ref_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "opening_balance_proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
