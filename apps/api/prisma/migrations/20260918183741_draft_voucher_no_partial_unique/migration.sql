-- 修复：同一期间只能存在一张草稿凭证
--
-- 原约束 @@unique([entityId, voucherWord, periodYear, periodMonth, voucherNo])
-- 把"未编号草稿"的 voucherNo=0 当成真实凭证号，于是同一期间的第二张草稿
-- 必然撞唯一约束 —— 表现为"建第二张凭证就报系统内部错误"。
--
-- 正确语义：**只有已编号的凭证才需要号码唯一**。未编号（voucherNo=0）可以有很多张。
-- 改用部分唯一索引，把约束目标精确限定在已编号凭证上。

DROP INDEX IF EXISTS "journal_voucher_entityId_voucherWord_periodYear_periodMonth_voucherNo_key";

-- 已过账凭证：号码在「主体+凭证字+期间」内唯一
CREATE UNIQUE INDEX "journal_voucher_no_unique_posted"
  ON "journal_voucher" ("entityId", "voucherWord", "periodYear", "periodMonth", "voucherNo")
  WHERE "voucherNo" > 0;

-- 未编号凭证的普通索引：列表按号排序时仍走索引
CREATE INDEX "journal_voucher_no_lookup"
  ON "journal_voucher" ("entityId", "voucherWord", "periodYear", "periodMonth", "voucherNo");