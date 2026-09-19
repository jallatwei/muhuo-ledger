-- CreateEnum
CREATE TYPE "FinancialStatementType" AS ENUM ('BALANCE_SHEET', 'INCOME_STATEMENT', 'CASH_FLOW');

-- AlterEnum
ALTER TYPE "HistorySourceType" ADD VALUE 'TAX_RETURN';

-- CreateTable
CREATE TABLE "financial_statement_record" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "batchId" TEXT,
    "statementType" "FinancialStatementType" NOT NULL,
    "statementDate" DATE NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "fiscalMonth" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'RECOGNITION',
    "standard" TEXT NOT NULL DEFAULT 'SMALL_ENTERPRISE_2013',
    "items" JSONB NOT NULL,
    "totalAssets" DECIMAL(18,2),
    "totalLiabilities" DECIMAL(18,2),
    "totalEquity" DECIMAL(18,2),
    "revenue" DECIMAL(18,2),
    "cost" DECIMAL(18,2),
    "profitBeforeTax" DECIMAL(18,2),
    "netProfit" DECIMAL(18,2),
    "isBalanced" BOOLEAN NOT NULL DEFAULT true,
    "balanceDifference" DECIMAL(18,2),
    "rawRow" JSONB,
    "documentId" TEXT,
    "reconNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_statement_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "financial_statement_record_entityId_fiscalYear_idx" ON "financial_statement_record"("entityId", "fiscalYear");

-- CreateIndex
CREATE UNIQUE INDEX "financial_statement_record_entityId_statementType_statement_key" ON "financial_statement_record"("entityId", "statementType", "statementDate");

-- AddForeignKey
ALTER TABLE "financial_statement_record" ADD CONSTRAINT "financial_statement_record_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_statement_record" ADD CONSTRAINT "financial_statement_record_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "history_import_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
