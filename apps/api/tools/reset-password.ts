/**
 * 管理员重置用户密码
 * ============================================================
 * 用法：
 *   pnpm --filter @bookkeeper/api user:reset-password --email someone@example.com
 *   # 交互式输入新密码（推荐，密码不进命令历史）
 *
 *   pnpm --filter @bookkeeper/api user:reset-password --email someone@example.com --password '新密码' --yes
 *
 * ★ 为什么需要这么个工具
 *
 *   本系统的密码只存 bcrypt 哈希（cost 12），**单向不可逆** ——
 *   忘了密码就是找不回来。而应用里只有「改密码」（要求先输入当前密码），
 *   没有任何重置入口。于是对一个自托管用户来说：
 *   **忘了密码 = 永久进不去自己的账**，除了手改数据库没有别的办法。
 *   手改数据库这一步本身就是风险：容易写错哈希规则（cost 不一样、
 *   或者干脆写成明文），而且不会留下任何审计痕迹。
 *
 *   所以把它做成一条命令：用**应用自己的**密码策略与成本因子，
 *   并写一条审计日志。密码规则从 src/domain/auth/password-policy.ts 来，
 *   与注册/改密界面**共用同一份**，不会出现"界面不让设、命令行能设"。
 *
 * ★ 安全性说明
 *   · 交互式输入时密码不回显（见下面 prompt 的实现注释）。
 *   · 带 --password 时会进 shell 历史，所以默认走交互输入，并在带参时提醒。
 *   · 生产环境不阻止执行（锁在门外时这正是救命的），但会显著警告并要求确认。
 *   · 重置只改一个哈希：不动 isActive，也不给人加权限。
 *
 * ★ 在 Docker 部署上怎么用
 *   本脚本是 TS、用 tsx 跑，**不在生产镜像里**（镜像只带编译后的 dist）。
 *   所以从仓库签出目录运行，把 DATABASE_URL 指向目标库即可：
 *     本地 Docker：apps/api/.env 里就是 localhost:5433，直接跑
 *     云端：DATABASE_URL='postgresql://…' pnpm --filter @bookkeeper/api user:reset-password --email …
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { Prompter } from '../src/cli/prompt';

import {
  BCRYPT_ROUNDS,
  WeakPasswordError,
  assertPassword,
} from '../src/domain/auth/password-policy';

const prisma = new PrismaClient();

// ============================================================================
//  参数
// ============================================================================

interface Args {
  email?: string;
  password?: string;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--email' || a === '-e') out.email = argv[++i];
    else if (a === '--password' || a === '-p') out.password = argv[++i];
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  return out;
}

function printUsage(): void {
  console.log(`
重置某个用户的登录密码

  --email, -e <邮箱>     要重置哪个账号（必填）
  --password, -p <密码>  新密码；省略则交互式输入（推荐）
  --yes, -y              跳过确认（生产环境或脚本里用）
  --help, -h             显示本帮助

例：
  pnpm --filter @bookkeeper/api user:reset-password --email me@example.com
`);
}

// ============================================================================
//  交互输入
// ============================================================================

const prompter = new Prompter({ input: process.stdin, output: process.stdout });

// ============================================================================/  主流程
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email) {
    console.error('\n❌ 缺少 --email。用 --help 看用法。\n');
    process.exit(2);
  }
  const email = args.email.trim().toLowerCase();

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`\n❌ 没有这个账号：${email}\n`);
    // 列出现有账号：多数情况只是邮箱打错了一个字，直接给出来最省事
    const all = await prisma.user.findMany({ select: { email: true }, orderBy: { email: 'asc' } });
    console.error('   当前实例里的账号：');
    for (const u of all) console.error(`     · ${u.email}`);
    console.error('');
    process.exit(1);
  }

  /*
   * ★ 没有 --password 又不在真实终端里，就直接拒绝，不要去尝试交互。
   *
   *   非 TTY（管道、CI、被别的程序调起）时交互提问会静默丢数据 ——
   *   实测表现为"输入了三行只读到一行、然后卡死"或"什么都没发生却退出码 0"。
   *   与其让它半死不活，不如明确告诉对方该怎么办。
   */
  if (!args.password && !process.stdin.isTTY) {
    console.error(
      '\n❌ 当前不是交互式终端，无法安全地输入密码。\n\n' +
        '   请在真实的终端里运行（交互输入不会回显），或者在受控场景下显式传参：\n' +
        `     pnpm --filter @bookkeeper/api user:reset-password --email ${email} --password '新密码' --yes\n\n` +
        '   注意：用 --password 传参会把密码留在 shell 历史里。\n',
    );
    process.exit(2);
  }

  let password = args.password;
  if (password) {
    console.warn(
      '\n⚠️  你是用 --password 传的密码，它会留在 shell 历史里。\n' +
        '   下次可以省略该参数，改为交互式输入。\n',
    );
  } else {
    password = await prompter.ask(`为 ${user.email} 设置新密码（输入不回显）：`, { secret: true });
    const again = await prompter.ask('再输一次确认：', { secret: true });
    if (password !== again) {
      console.error('\n❌ 两次输入不一致，未做任何修改。\n');
      process.exit(1);
    }
  }

  try {
    assertPassword(password);
  } catch (e) {
    if (e instanceof WeakPasswordError) {
      console.error(`\n❌ ${e.userMessage}\n`);
      process.exit(1);
    }
    throw e;
  }

  const isProd = (process.env.NODE_ENV ?? 'development') === 'production';
  if (!args.yes) {
    const where = isProd ? '**生产库**' : '本地库';
    const dbUrl = (process.env.DATABASE_URL ?? '(未设置)').replace(/:[^:@/]+@/, ':****@');
    const ans = await prompter.ask(
      `\n将把 ${user.email}（${user.displayName}）的密码重置到 ${where}\n   ${dbUrl}\n输入 yes 继续：`,
    );
    if (ans.trim().toLowerCase() !== 'yes') {
      console.error('\n已取消，未做任何修改。\n');
      process.exit(1);
    }
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    // ★ 审计留痕：谁在什么时候重置了谁的密码，必须查得到。
    //   不写的话，一次"合法找回"与一次"他人篡改"在日志上完全无法区分。
    await tx.auditLog.create({
      data: {
        entityId: null,
        userId: user.id,
        userName: user.displayName,
        action: 'PASSWORD_CHANGE',
        subjectType: 'User',
        subjectId: user.id,
        reason: '通过 CLI 重置密码（user:reset-password）',
      },
    });
  });

  console.log(`\n✅ 已重置：${user.email}（${user.displayName}）`);
  console.log(`   哈希成本：bcrypt ${BCRYPT_ROUNDS}（与应用一致）`);
  console.log('   已写入审计日志（action=PASSWORD_CHANGE）');
  console.log('\n   现在可以用新密码登录了。\n');
}

main()
  .catch((e) => {
    console.error('\n❌ 执行失败：', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    prompter.close();
    await prisma.$disconnect();
  });