-- =============================================================================
--  数据库层强制约束（最后一道防线）
--  ============================================================================
--  为什么要在数据库层再做一遍？
--    应用层可能被绕过：手工 SQL 修数、批处理脚本、未来新增的接口入口、
--    甚至一个记错的 where 条件。会计数据一旦被污染，排查成本极高。
--    所以把「不可违背的会计不变式」下沉到数据库。
--
--  由 entity.bookkeepingEnforced 开关控制：
--    true  → 全部约束生效（默认）
--    false → 仅放行 journal_line 的写入校验，便于批量导入/修数
--            （该开关本身的变更由应用层写入 audit_log）
--
--  由 prisma/migrations 自动执行（见 migration.sql）。
-- =============================================================================

-- -----------------------------------------------------------------------------
--  0. 内部辅助函数
-- -----------------------------------------------------------------------------

-- 判断某凭证所属主体是否启用了强制约束
CREATE OR REPLACE FUNCTION bk_bookkeeping_enforced(p_entity_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_enforced BOOLEAN;
BEGIN
  SELECT "bookkeepingEnforced" INTO v_enforced FROM entity WHERE id = p_entity_id;
  RETURN COALESCE(v_enforced, TRUE);
END;
$$;

-- 取某期间的锁状态（用于凭证写入前的期间锁校验）
CREATE OR REPLACE FUNCTION bk_period_status(p_period_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status::TEXT INTO v_status FROM period WHERE id = p_period_id;
  RETURN v_status;
END;
$$;

-- -----------------------------------------------------------------------------
--  1. journal_line：金额必须为正数
--     ★ 借贷方向由 direction 表达，绝不允许用负数金额。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bk_check_line_amount_positive()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <= 0 THEN
    RAISE EXCEPTION
      'BK_E_AMOUNT_NOT_POSITIVE: 分录金额必须大于 0（收到 %）。借贷方向请用 direction 字段表达，不要用负数金额。',
      NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_line_amount_positive ON journal_line;
CREATE TRIGGER trg_journal_line_amount_positive
  BEFORE INSERT OR UPDATE OF amount ON journal_line
  FOR EACH ROW EXECUTE FUNCTION bk_check_line_amount_positive();

-- -----------------------------------------------------------------------------
--  2. journal_line：只能记末级且启用的科目
--     ★ 记到「应交税费」这种一级科目上，报表就取不到数了。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bk_check_line_leaf_account()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_is_leaf   BOOLEAN;
  v_is_active BOOLEAN;
  v_code      TEXT;
  v_name      TEXT;
BEGIN
  IF NOT bk_bookkeeping_enforced(NEW."entityId") THEN
    RETURN NEW;
  END IF;

  SELECT "isLeaf", "isActive", code, name
    INTO v_is_leaf, v_is_active, v_code, v_name
    FROM account WHERE id = NEW."accountId";

  IF v_code IS NULL THEN
    RAISE EXCEPTION 'BK_E_ACCOUNT_NOT_FOUND: 科目不存在（id=%）', NEW."accountId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_is_leaf THEN
    RAISE EXCEPTION
      'BK_E_NON_LEAF_ACCOUNT: 科目 % % 不是末级科目，不允许记账。请选择其下级明细科目。',
      v_code, v_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_is_active THEN
    RAISE EXCEPTION 'BK_E_ACCOUNT_INACTIVE: 科目 % % 已停用，不允许记账。', v_code, v_name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_line_leaf_account ON journal_line;
CREATE TRIGGER trg_journal_line_leaf_account
  BEFORE INSERT OR UPDATE OF "accountId" ON journal_line
  FOR EACH ROW EXECUTE FUNCTION bk_check_line_leaf_account();

-- -----------------------------------------------------------------------------
--  3. journal_line：期间锁
--     ★ 已结账（CLOSED）或结账中（CLOSING）的期间禁止任何凭证写入。
--       要改？走「反结账 → 红冲 → 重新结账」的显式路径。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bk_check_line_period_lock()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_status    TEXT;
  v_reopened  INT;
BEGIN
  IF NOT bk_bookkeeping_enforced(NEW."entityId") THEN
    RETURN NEW;
  END IF;

  v_status := bk_period_status(NEW."periodId");

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'BK_E_PERIOD_NOT_FOUND: 会计期间不存在（id=%）', NEW."periodId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_status <> 'OPEN' THEN
    RAISE EXCEPTION
      'BK_E_PERIOD_LOCKED: 该会计期间已结账（状态 %），不允许写入凭证。请先在结账页执行「反结账」并填写理由。',
      v_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_line_period_lock ON journal_line;
CREATE TRIGGER trg_journal_line_period_lock
  BEFORE INSERT OR UPDATE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION bk_check_line_period_lock();

-- 期间锁也要挡住直接改凭证日期绕过期间检查
CREATE OR REPLACE FUNCTION bk_check_voucher_period_lock()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF NOT bk_bookkeeping_enforced(NEW."entityId") THEN
    RETURN NEW;
  END IF;

  -- 已过账的凭证不允许修改任何内容（只有 status 与 reversedById 可变）
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    IF NEW."voucherDate" <> OLD."voucherDate"
       OR NEW."periodId" <> OLD."periodId"
       OR NEW."voucherNo" <> OLD."voucherNo"
       OR NEW."totalDebit" <> OLD."totalDebit"
       OR NEW."totalCredit" <> OLD."totalCredit"
       OR NEW.summary <> OLD.summary THEN
      RAISE EXCEPTION
        'BK_E_POSTED_IMMUTABLE: 凭证 %-% 已过账，不允许修改。如需更正请执行红冲。',
        OLD."voucherWord", OLD."voucherNo"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  v_status := bk_period_status(NEW."periodId");
  IF v_status IS NOT NULL AND v_status <> 'OPEN' THEN
    RAISE EXCEPTION
      'BK_E_PERIOD_LOCKED: 会计期间已结账（状态 %），不允许新增或修改凭证。', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_voucher_period_lock ON journal_voucher;
CREATE TRIGGER trg_journal_voucher_period_lock
  BEFORE INSERT OR UPDATE ON journal_voucher
  FOR EACH ROW EXECUTE FUNCTION bk_check_voucher_period_lock();

-- -----------------------------------------------------------------------------
--  4. journal_voucher：借贷平衡
--     ★★ 全系统最重要的不变式。过账时（status -> POSTED）强制执行。
--        注意：即使应用层已经校验过，这里也要再算一遍 ——
--        两次计算的数据来源不同（应用层用内存对象，这里从表里读）。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bk_check_voucher_balanced()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_debit   NUMERIC(18,2);
  v_credit  NUMERIC(18,2);
  v_count   INT;
  v_label   TEXT;
BEGIN
  -- 只在过账时校验（草稿允许暂时不平，便于分步录入）
  IF NEW.status <> 'POSTED' THEN
    RETURN NEW;
  END IF;

  -- 已经是 POSTED 的再更新（如红冲标记），且金额没变，跳过
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED'
     AND OLD."totalDebit" = NEW."totalDebit" AND OLD."totalCredit" = NEW."totalCredit" THEN
    RETURN NEW;
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN direction = 'DEBIT'  THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0),
    COUNT(*)
  INTO v_debit, v_credit, v_count
  FROM journal_line WHERE "voucherId" = NEW.id;

  v_label := NEW."voucherWord" || '-' || NEW."voucherNo";

  IF v_count = 0 THEN
    RAISE EXCEPTION 'BK_E_NO_LINES: 凭证 % 没有任何分录行，不允许过账。', v_label
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'BK_E_UNBALANCED: 凭证 % 借贷不平 —— 借方合计 %, 贷方合计 %, 差额 %。过账已中止。',
      v_label, v_debit, v_credit, (v_debit - v_credit)
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debit <= 0 THEN
    RAISE EXCEPTION 'BK_E_ZERO_VOUCHER: 凭证 % 的借贷合计为 0，不允许过账。', v_label
      USING ERRCODE = 'check_violation';
  END IF;

  -- 顺带把合计同步为真实值（防御应用层算错）
  NEW."totalDebit"  := v_debit;
  NEW."totalCredit" := v_credit;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_voucher_balanced ON journal_voucher;
CREATE TRIGGER trg_journal_voucher_balanced
  BEFORE INSERT OR UPDATE ON journal_voucher
  FOR EACH ROW EXECUTE FUNCTION bk_check_voucher_balanced();

-- -----------------------------------------------------------------------------
--  5. journal_voucher：过账时必须已分配凭证号
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bk_check_voucher_numbered()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'POSTED' AND (NEW."voucherNo" IS NULL OR NEW."postedAt" IS NULL) THEN
    RAISE EXCEPTION
      'BK_E_NOT_NUMBERED: 凭证过账时必须已分配凭证号并记录过账时间（voucherNo=%, postedAt=%）。',
      NEW."voucherNo", NEW."postedAt"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_voucher_numbered ON journal_voucher;
CREATE TRIGGER trg_journal_voucher_numbered
  BEFORE INSERT OR UPDATE ON journal_voucher
  FOR EACH ROW EXECUTE FUNCTION bk_check_voucher_numbered();

-- -----------------------------------------------------------------------------
--  6. journal_line：自动重算凭证合计
--     ★ 防止"分录改了但凭证合计没跟着改"导致账面与分录不一致。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bk_sync_voucher_totals()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_voucher_id TEXT;
  v_debit      NUMERIC(18,2);
  v_credit     NUMERIC(18,2);
BEGIN
  v_voucher_id := COALESCE(NEW."voucherId", OLD."voucherId");

  SELECT
    COALESCE(SUM(CASE WHEN direction = 'DEBIT'  THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)
  INTO v_debit, v_credit
  FROM journal_line WHERE "voucherId" = v_voucher_id;

  UPDATE journal_voucher
     SET "totalDebit" = v_debit, "totalCredit" = v_credit, "updatedAt" = NOW()
   WHERE id = v_voucher_id;

  RETURN NULL; -- AFTER 触发器
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_line_sync_totals ON journal_line;
CREATE TRIGGER trg_journal_line_sync_totals
  AFTER INSERT OR UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION bk_sync_voucher_totals();

-- -----------------------------------------------------------------------------
--  7. audit_log：只追加，不可修改或删除
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bk_audit_log_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'BK_E_AUDIT_IMMUTABLE: 审计日志只允许追加，不允许修改或删除。'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit_log;
CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION bk_audit_log_immutable();

-- -----------------------------------------------------------------------------
--  8. 余额滚动函数（幂等）
--     ★ 任何时候怀疑余额不对，重算一次即可。
-- -----------------------------------------------------------------------------

-- 重算指定期间的余额（删掉重来，保证幂等）
CREATE OR REPLACE FUNCTION bk_rebuild_balances(p_entity_id TEXT, p_period_id TEXT)
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
  v_year   INT;
  v_month  INT;
  v_prev   TEXT;
  v_rows   INT := 0;
BEGIN
  SELECT "fiscalYear", month INTO v_year, v_month FROM period WHERE id = p_period_id;
  IF v_year IS NULL THEN
    RAISE EXCEPTION 'BK_E_PERIOD_NOT_FOUND: 会计期间不存在（id=%）', p_period_id;
  END IF;

  -- 找上一个期间
  SELECT id INTO v_prev
    FROM period
   WHERE "entityId" = p_entity_id
     AND (("fiscalYear" = v_year AND month < v_month)
          OR ("fiscalYear" = v_year - 1))
   ORDER BY "fiscalYear" DESC, month DESC
   LIMIT 1;

  -- 本期发生额（已过账 + 已红冲的凭证都算，两者相加净额为 0）
  CREATE TEMP TABLE tmp_occ ON COMMIT DROP AS
  SELECT l."accountId",
         SUM(CASE WHEN l.direction = 'DEBIT'  THEN l.amount ELSE 0 END) AS debit_occ,
         SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE 0 END) AS credit_occ
    FROM journal_line l
    JOIN journal_voucher v ON v.id = l."voucherId"
   WHERE l."entityId" = p_entity_id
     AND l."periodId" = p_period_id
     AND v.status IN ('POSTED', 'REVERSED')
   GROUP BY l."accountId";

  -- 写入余额：期初取上期期末，发生额取本期聚合，期末按科目方向计算
  INSERT INTO account_balance (
    id, "entityId", "periodId", "accountId",
    "openingDebit", "openingCredit", "debitOccurred", "creditOccurred",
    "closingDebit", "closingCredit", "updatedAt"
  )
  SELECT
    gen_random_uuid()::TEXT,
    p_entity_id,
    p_period_id,
    a.id,
    COALESCE(pb."closingDebit", 0),
    COALESCE(pb."closingCredit", 0),
    COALESCE(o.debit_occ, 0),
    COALESCE(o.credit_occ, 0),
    CASE WHEN a.direction = 'DEBIT'
      THEN COALESCE(pb."closingDebit", 0)  + COALESCE(o.debit_occ, 0) - COALESCE(o.credit_occ, 0)
      ELSE 0 END,
    CASE WHEN a.direction = 'CREDIT'
      THEN COALESCE(pb."closingCredit", 0) + COALESCE(o.credit_occ, 0) - COALESCE(o.debit_occ, 0)
      ELSE 0 END,
    NOW()
  FROM account a
  LEFT JOIN tmp_occ o ON o."accountId" = a.id
  LEFT JOIN account_balance pb ON pb."accountId" = a.id AND pb."periodId" = v_prev
  WHERE a."entityId" = p_entity_id
    AND a."isLeaf" = TRUE
  ON CONFLICT ("entityId", "periodId", "accountId") DO UPDATE SET
    "openingDebit"   = EXCLUDED."openingDebit",
    "openingCredit"  = EXCLUDED."openingCredit",
    "debitOccurred"  = EXCLUDED."debitOccurred",
    "creditOccurred" = EXCLUDED."creditOccurred",
    "closingDebit"   = EXCLUDED."closingDebit",
    "closingCredit"  = EXCLUDED."closingCredit",
    "updatedAt"      = NOW();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

-- -----------------------------------------------------------------------------
--  9. 账务自检：全局不变式 I2（借方余额合计 == 贷方余额合计）
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bk_check_invariants(p_entity_id TEXT, p_period_id TEXT)
RETURNS TABLE (invariant TEXT, passed BOOLEAN, detail TEXT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_debit   NUMERIC(18,2);
  v_credit  NUMERIC(18,2);
  v_mismatch INT;
BEGIN
  -- I2：全部科目借方余额合计 == 贷方余额合计
  SELECT COALESCE(SUM("closingDebit"), 0), COALESCE(SUM("closingCredit"), 0)
    INTO v_debit, v_credit
    FROM account_balance
   WHERE "entityId" = p_entity_id AND "periodId" = p_period_id;

  RETURN QUERY SELECT
    'I2'::TEXT,
    (v_debit = v_credit),
    format('借方余额合计 %s，贷方余额合计 %s，差额 %s', v_debit, v_credit, v_debit - v_credit);

  -- I4：本期发生额 == 该期凭证分录聚合
  -- 注意：PostgreSQL 的 IS DISTINCT FROM 右侧不接受多列子查询，
  -- 必须先用 LATERAL 把两个聚合值算成一行，再整体比较。
  SELECT COUNT(*) INTO v_mismatch
  FROM account_balance ab
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(CASE WHEN l.direction = 'DEBIT'  THEN l.amount ELSE 0 END), 0) AS d,
           COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE 0 END), 0) AS c
      FROM journal_line l
      JOIN journal_voucher v ON v.id = l."voucherId"
     WHERE l."accountId" = ab."accountId"
       AND l."periodId" = p_period_id
       AND v.status IN ('POSTED', 'REVERSED')
  ) occ ON TRUE
  WHERE ab."entityId" = p_entity_id
    AND ab."periodId" = p_period_id
    AND (ab."debitOccurred" <> occ.d OR ab."creditOccurred" <> occ.c);

  RETURN QUERY SELECT
    'I4'::TEXT,
    (v_mismatch = 0),
    format('余额表与凭证分录不一致的科目数：%s（可用 bk_rebuild_balances 重算）', v_mismatch);

  -- I5：凭证号连续无空洞（只检查已过账凭证）
  SELECT COUNT(*) INTO v_mismatch
  FROM (
    SELECT "voucherWord", COUNT(*) AS cnt, MIN("voucherNo") AS min_no, MAX("voucherNo") AS max_no
      FROM journal_voucher
     WHERE "entityId" = p_entity_id
       AND "periodId" = p_period_id
       AND status IN ('POSTED', 'REVERSED')
     GROUP BY "voucherWord"
  ) t
  WHERE t.min_no <> 1 OR t.max_no <> t.cnt;

  RETURN QUERY SELECT
    'I5'::TEXT,
    (v_mismatch = 0),
    format('凭证号不连续的凭证字数量：%s', v_mismatch);
END;
$$;

COMMENT ON FUNCTION bk_rebuild_balances IS '幂等重算指定期间的科目余额（由凭证重算，不依赖既有余额表）';
COMMENT ON FUNCTION bk_check_invariants IS '账务自检：I2 借贷余额相等、I4 余额与分录一致、I5 凭证号连续';
