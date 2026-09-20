-- 补上 audit_log.userName 列。
--
-- ★ 这是一次 schema 漂移的修复，不是新功能：
--   schema.prisma 里 AuditLog.userName 已经存在（用于"用户改名或删号后，
--   历史日志仍能显示当时是谁"），但**从来没有迁移创建过这一列**。
--   Prisma 客户端是按 schema.prisma 生成的，插入后会 SELECT 整行，
--   找不到该列就整条 create 失败 —— 结果是**每一次审计写入都失败**，
--   而且失败被 catch 住只打日志，业务照常返回 200。
--   实测报错：The column `audit_log.userName` does not exist in the current database.
--
--   漂移的成因见 20260918112107 与 20260918183741 两个迁移：
--   前者要 RENAME 一个由后者才创建的索引，导致迁移历史无法从零重放，
--   `prisma migrate dev` 因此不可用 —— schema 改了也生成不出迁移。
--   那个问题另行处理，本迁移只把已经缺了的列补上。

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN "userName" TEXT;