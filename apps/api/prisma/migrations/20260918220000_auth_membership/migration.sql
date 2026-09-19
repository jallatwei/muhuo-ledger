-- =============================================================================
--  账号体系：User 平台化 + Membership 关系表
-- =============================================================================
--
-- 背景：原来的 app_user 上挂着 role TEXT 与 entityIds TEXT[]。
--   · entityIds 是数组，**没有外键** —— 可以塞进任何不存在的 id，删主体也不会清理；
--   · 数组表达不了「在这家公司是什么角色」，而角色恰好是权限判定的核心；
--   · 权限校验要按 (userId, entityId) 查一行，关系表一个联合唯一索引就够，
--     数组只能全表扫。
-- 所以角色搬到新的 membership 表，app_user 退化为**平台级账号**。
--
-- ★ 数据迁移：把老 user 的 entityIds 逐个展开成 membership 行，
--   角色沿用原来的 app_user.role（老数据里只有 OWNER 一种）。
--   这一步不能省 —— 直接 DROP COLUMN 会把"谁能进哪家公司"整段丢掉。

-- ---------------------------------------------------------------------------
-- ① app_user：加平台级字段，去角色字段
-- ---------------------------------------------------------------------------

-- 账号性质。只影响注册引导与默认权限预设，不决定实际权限（实际权限一律看 membership.role）。
ALTER TABLE "app_user" ADD COLUMN "accountType" TEXT NOT NULL DEFAULT 'PERSONAL';

-- 平台级管理员：可跨主体查看，用于运维排障。与 membership.role=OWNER 是两件事。
ALTER TABLE "app_user" ADD COLUMN "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

-- 手机号（选填）
ALTER TABLE "app_user" ADD COLUMN "phone" TEXT;

-- ---------------------------------------------------------------------------
-- ② membership：先建表，再从 entityIds 回填
-- ---------------------------------------------------------------------------

CREATE TABLE "membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "invitedBy" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- 一个用户在同一主体下只能有一条关系
CREATE UNIQUE INDEX "membership_userId_entityId_key" ON "membership"("userId", "entityId");
CREATE INDEX "membership_entityId_role_idx" ON "membership"("entityId", "role");
CREATE INDEX "membership_userId_isActive_idx" ON "membership"("userId", "isActive");

ALTER TABLE "membership" ADD CONSTRAINT "membership_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "membership" ADD CONSTRAINT "membership_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ★ 回填：老数据里 entityIds 有值就展开成 membership。
--   JOIN entity 一次 —— 指向已不存在主体的脏 id 会被自然过滤掉（外键也容不下它）。
INSERT INTO "membership" ("id", "userId", "entityId", "role", "isActive", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    u."id",
    e."id",
    COALESCE(NULLIF(u."role", ''), 'OWNER'),
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "app_user" u
CROSS JOIN LATERAL unnest(u."entityIds") AS eid
JOIN "entity" e ON e."id" = eid
ON CONFLICT ("userId", "entityId") DO NOTHING;

-- ---------------------------------------------------------------------------
-- ③ 摘掉旧的角色字段
-- ---------------------------------------------------------------------------

ALTER TABLE "app_user" DROP COLUMN "entityIds";
ALTER TABLE "app_user" DROP COLUMN "role";
