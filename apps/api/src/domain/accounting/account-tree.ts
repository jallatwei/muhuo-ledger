/**
 * 科目表构建辅助
 * ============================================================
 * 从扁平的手写清单（BUILTIN_ACCOUNTS）算出层级、完整名称、是否末级。
 *
 * ★ 为什么必须抽成共享模块：
 *   seed 脚本用它给演示主体建科目表，而「公司注册」也要用它给新公司建科目表。
 *   两处各写一份的话，只要有一处的口径变了（比如 fullName 的分隔符、
 *   或者 isLeaf 的判定），新老主体的科目表就会不一致，
 *   而科目表不一致会让报表口径分叉 —— 这是最难排查的一类问题。
 */
import type { BuiltinAccount } from './chart-of-accounts';

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  fullName: string;
  parentId: string | null;
  level: number;
  category: string;
  direction: string;
  isLeaf: boolean;
  isActive: boolean;
  reportItem: string | null;
  taxTag: string | null;
  cashflowTag: string | null;
  auxRequired: string[];
  isSystem: boolean;
  sortOrder: number;
}

/** 计算层级：沿 parent 链向上数 */
export function computeLevel(account: BuiltinAccount, byCode: Map<string, BuiltinAccount>): number {
  let level = 1;
  let cur = account.parent;
  const guard = new Set<string>();
  while (cur) {
    if (guard.has(cur)) throw new Error(`科目父子关系存在环：${account.code}`);
    guard.add(cur);
    level += 1;
    cur = byCode.get(cur)?.parent;
  }
  return level;
}

/** 计算完整名称：应交税费—应交增值税—进项税额 */
export function computeFullName(
  account: BuiltinAccount,
  byCode: Map<string, BuiltinAccount>,
): string {
  const parts: string[] = [account.name];
  let cur = account.parent;
  const guard = new Set<string>();
  while (cur) {
    if (guard.has(cur)) break;
    guard.add(cur);
    const parent = byCode.get(cur);
    if (!parent) break;
    parts.unshift(parent.name);
    cur = parent.parent;
  }
  return parts.join('—');
}

/** 是否为末级科目：没有任何科目的 parent 指向它 */
export function computeIsLeaf(code: string, all: BuiltinAccount[]): boolean {
  return !all.some((a) => a.parent === code);
}

/**
 * 把扁平清单展开成可直接插入数据库的行。
 *
 * @param entityId 所属主体
 * @param idFactory 生成 id 的函数（默认 crypto.randomUUID）
 */
export function buildAccountRows(
  entityId: string,
  accounts: BuiltinAccount[] = [],
  idFactory: () => string = () => globalThis.crypto.randomUUID(),
): AccountRow[] {
  const list = accounts.length > 0 ? accounts : [];
  const byCode = new Map(list.map((a) => [a.code, a]));
  const idByCode = new Map<string, string>();

  // ★ 按层级升序处理，保证父科目先拿到 id。
  //   不排序的话，子科目可能先插入而 parentId 为空 —— 层级会整体塌掉。
  const withLevel = list.map((a) => ({ acc: a, level: computeLevel(a, byCode) }));
  withLevel.sort((a, b) => a.level - b.level || a.acc.code.localeCompare(b.acc.code));

  const rows: AccountRow[] = [];
  for (const { acc, level } of withLevel) {
    const id = idFactory();
    idByCode.set(acc.code, id);
    rows.push({
      id,
      code: acc.code,
      name: acc.name,
      fullName: computeFullName(acc, byCode),
      parentId: acc.parent ? (idByCode.get(acc.parent) ?? null) : null,
      level,
      category: acc.category,
      direction: acc.direction,
      isLeaf: computeIsLeaf(acc.code, list),
      isActive: true,
      reportItem: acc.reportItem ?? null,
      taxTag: acc.taxTag ?? null,
      cashflowTag: acc.cashflow ?? null,
      auxRequired: acc.aux ?? [],
      isSystem: true,
      sortOrder: Number(acc.code.padEnd(8, '0').slice(0, 8)),
    });
  }
  return rows;
}

/**
 * 幂等版：把内置科目表**逐条 upsert** 进某个主体。
 *
 * ★ 与 `buildAccountRows` 的区别，也是它存在的理由：
 *   公司注册时是一次性写入，用 createMany 最快；
 *   而种子脚本会在已有账簿上反复执行，必须 upsert ——
 *   科目 id 一旦变了，历史分录的 accountId 就会指向一个不存在的科目。
 *
 *   两者共用**同一套** computeLevel / computeFullName / computeIsLeaf，
 *   所以新增公司拿到的科目表和演示主体逐字段一致，
 *   不会出现"新老主体报表口径分叉"这种最难查的问题。
 */
export interface AccountUpsertClient {
  account: {
    upsert(args: {
      where: { entityId_code: { entityId: string; code: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<{ id: string }> | { id: string };
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<unknown> | unknown;
  };
}

export async function upsertBuiltinAccounts(
  client: AccountUpsertClient,
  entityId: string,
  accounts: BuiltinAccount[],
): Promise<{ idByCode: Map<string, string>; count: number; parentCount: number }> {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const idByCode = new Map<string, string>();

  // 按层级排序，保证父科目先落库
  const sorted = [...accounts].sort((a, b) => {
    const la = computeLevel(a, byCode);
    const lb = computeLevel(b, byCode);
    return la !== lb ? la - lb : a.code.localeCompare(b.code);
  });

  for (const acc of sorted) {
    const parentCode = acc.parent;
    const parentId = parentCode ? idByCode.get(parentCode) : null;
    if (parentCode && !parentId) {
      throw new Error(`科目 ${acc.code} 的上级 ${parentCode} 尚未创建，内置科目表顺序有误`);
    }

    const data = {
      entityId,
      code: acc.code,
      name: acc.name,
      fullName: computeFullName(acc, byCode),
      parentId: parentId ?? null,
      level: computeLevel(acc, byCode),
      category: acc.category,
      direction: acc.direction,
      isLeaf: computeIsLeaf(acc.code, accounts),
      isActive: true,
      reportItem: acc.reportItem ?? null,
      cashflowTag: acc.cashflow ?? null,
      taxTag: acc.taxTag ?? null,
      auxRequired: acc.aux ?? [],
      isSystem: true,
      sortOrder: Number(acc.code.padEnd(8, '0').slice(0, 8)),
    };

    const row = await client.account.upsert({
      where: { entityId_code: { entityId, code: acc.code } },
      create: data,
      update: {
        name: data.name,
        fullName: data.fullName,
        parentId: data.parentId,
        level: data.level,
        category: data.category,
        direction: data.direction,
        isLeaf: data.isLeaf,
        reportItem: data.reportItem,
        cashflowTag: data.cashflowTag,
        taxTag: data.taxTag,
        auxRequired: data.auxRequired,
        sortOrder: data.sortOrder,
      },
    });
    idByCode.set(acc.code, row.id);
  }

  // 修正父科目的 isLeaf（有子科目的一律不是末级）
  const parents = accounts.filter((a) => !computeIsLeaf(a.code, accounts));
  if (parents.length > 0) {
    await client.account.updateMany({
      where: { entityId, code: { in: parents.map((p) => p.code) } },
      data: { isLeaf: false },
    });
  }

  return { idByCode, count: sorted.length, parentCount: parents.length };
}

/** 生成某年的 12 个会计期间行 */
export function buildPeriodRows(
  entityId: string,
  year: number,
  idFactory: () => string = () => globalThis.crypto.randomUUID(),
): Array<{
  id: string;
  entityId: string;
  fiscalYear: number;
  month: number;
  startsOn: Date;
  endsOn: Date;
  status: string;
}> {
  return Array.from({ length: 12 }, (_, i) => ({
    id: idFactory(),
    entityId,
    fiscalYear: year,
    month: i + 1,
    startsOn: new Date(Date.UTC(year, i, 1)),
    // 下月 0 日 = 本月最后一天，自动处理大小月与闰年
    endsOn: new Date(Date.UTC(year, i + 1, 0)),
    status: 'OPEN',
  }));
}
