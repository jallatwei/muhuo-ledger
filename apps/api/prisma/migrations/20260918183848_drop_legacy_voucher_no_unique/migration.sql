-- 修正上一支迁移：旧的全量唯一索引没有被删掉
--
-- 上一支迁移把 DROP INDEX 的索引名猜成了
--   journal_voucher_entityId_voucherWord_periodYear_periodMonth_voucherNo_key
-- 而 Prisma 实际生成的是（注意结尾是 periodMonth_key，voucherNo 被截断了）
--   journal_voucher_entityId_voucherWord_periodYear_periodMonth_key
-- 猜名字是不可靠的 —— 这里改成用 pg_indexes 查出真实名字再删，
-- 这样无论 Prisma 怎么截断都能删对。
--
-- 教训：索引/约束名是数据库生成的，不要在迁移里硬编码猜测值。

DO $$
DECLARE
  idx_name text;
BEGIN
  FOR idx_name IN
    SELECT indexname
    FROM pg_indexes
    WHERE tablename = 'journal_voucher'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%'
      AND indexdef LIKE '%"voucherNo"%'
      AND indexdef NOT LIKE '%WHERE%'      -- 只删"无条件"的那个：条件索引是我们要保留的新索引
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', idx_name);
    RAISE NOTICE '已删除旧的全量唯一索引: %', idx_name;
  END LOOP;
END $$;