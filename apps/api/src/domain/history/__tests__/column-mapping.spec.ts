/**
 * 表头映射与值解析 —— 测试
 * ============================================================
 * 列映射错了会导致**整批数据错位**，是灾难性的。
 * 所以这组测试重点验证：
 *   · 各家开票软件的列名都能识别
 *   · 歧义列名（"金额" vs "不含税金额"）不会互相抢占
 *   · AI 推断的映射置信度封顶且必须人工确认
 *   · 必填字段缺失必须拦住导入
 *   · 金额/日期/税率/布尔的各种写法都能正确解析
 */
import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  matchByRules,
  mergeAiMappings,
  parseAmount,
  parseDate,
  parseTaxRate,
  parseBoolean,
} from '../column-mapping';

// ============================================================================
describe('规则匹配：常见开票软件的导出格式', () => {
  it('税局/航信标准格式全部识别', () => {
    const r = matchByRules([
      '发票代码',
      '发票号码',
      '开票日期',
      '销方名称',
      '销方纳税人识别号',
      '金额',
      '税率',
      '税额',
      '价税合计',
      '货物或应税劳务名称',
    ]);
    const map = Object.fromEntries(r.mappings.map((m) => [m.source, m.target]));
    expect(map['发票代码']).toBe('invoiceCode');
    expect(map['发票号码']).toBe('invoiceNumber');
    expect(map['开票日期']).toBe('invoiceDate');
    expect(map['销方名称']).toBe('counterpartyName');
    expect(map['销方纳税人识别号']).toBe('counterpartyTaxNo');
    expect(map['金额']).toBe('amountExclTax');
    expect(map['税率']).toBe('taxRate');
    expect(map['税额']).toBe('taxAmount');
    expect(map['价税合计']).toBe('amountInclTax');
    expect(map['货物或应税劳务名称']).toBe('itemSummary');
    expect(r.complete).toBe(true);
    expect(r.missingRequired).toHaveLength(0);
  });

  it('进项发票导出格式（购买方视角）也识别', () => {
    const r = matchByRules([
      '发票号码',
      '开票时间',
      '购方名称',
      '购方税号',
      '不含税金额',
      '税率（%）',
      '税金',
      '含税金额',
      '勾选状态',
    ]);
    const map = Object.fromEntries(r.mappings.map((m) => [m.source, m.target]));
    expect(map['开票时间']).toBe('invoiceDate');
    expect(map['购方名称']).toBe('counterpartyName');
    expect(map['不含税金额']).toBe('amountExclTax');
    expect(map['税率（%）']).toBe('taxRate');
    expect(map['税金']).toBe('taxAmount');
    expect(map['含税金额']).toBe('amountInclTax');
    expect(map['勾选状态']).toBe('isCertified');
  });

  it('★ 「金额」与「不含税金额」同时存在 → 检测出歧义并要求确认', () => {
    // 「金额」和「不含税金额」都是 amountExclTax 的精确别名。
    // 一般税局导出里不会同时出现这两列，但用户自己整理的表格里很常见
    // （一列填不含税、一列表头却写成"金额"）。
    // 关键是：系统不能默默挑一个，必须把歧义摆出来。
    const r = matchByRules(['金额', '不含税金额', '价税合计']);
    const map = Object.fromEntries(r.mappings.map((m) => [m.source, m.target]));

    // 无论谁拿到 amountExclTax，价税合计都应稳定落到 amountInclTax
    expect(map['价税合计']).toBe('amountInclTax');

    // 两列不会落到同一个字段
    const targets = r.mappings.filter((m) => m.target !== 'IGNORE').map((m) => m.target);
    expect(new Set(targets).size).toBe(targets.length);

    // 必须报出歧义，且涉及的列都要人工确认
    expect(r.ambiguous.some((a) => a.field === 'amountExclTax')).toBe(true);
    const contested = r.ambiguous.find((a) => a.field === 'amountExclTax')!;
    expect(contested.sources).toEqual(expect.arrayContaining(['金额', '不含税金额']));
    // 已分配字段的候选列必须标为需确认（未匹配到的列本来就要人工指定）
    for (const src of contested.sources) {
      const m = r.mappings.find((x) => x.source === src)!;
      if (m.target !== 'IGNORE') expect(m.needsConfirm).toBe(true);
    }
  });

  it('只有一列声明某字段时不报歧义（避免噪音）', () => {
    const r = matchByRules(['金额', '价税合计', '开票日期', '销方名称']);
    expect(r.ambiguous).toHaveLength(0);
  });

  it('带括号补充说明的列名能部分匹配', () => {
    const r = matchByRules(['销方名称（全称）', '价税合计（含税）']);
    const map = Object.fromEntries(r.mappings.map((m) => [m.source, m.target]));
    expect(map['销方名称（全称）']).toBe('counterpartyName');
    expect(map['价税合计（含税）']).toBe('amountInclTax');
    expect(r.ambiguous).toHaveLength(0);
  });

  it('带单位的金额列能正确归一（含税金额(元) → amountInclTax）', () => {
    // 单独出现时没有歧义，应精确匹配到含税金额
    const r = matchByRules(['含税金额(元)', '开票日期', '销方名称']);
    const map = Object.fromEntries(r.mappings.map((m) => [m.source, m.target]));
    expect(map['含税金额(元)']).toBe('amountInclTax');
    expect(r.ambiguous).toHaveLength(0);
  });

  it('★ 多列争同一字段 → 暴露歧义并要求人工确认，而不是悄悄挑一个', () => {
    // 「价税合计」与「含税金额」都是 amountInclTax 的等长精确别名。
    // 无论怎么贪心分配，总会有一列掉到模糊匹配，可能被错配到
    // amountExclTax（不含税金额）—— 金额列错位会让整批数据不可信。
    // 正确做法是把歧义摆到用户面前。
    const r = matchByRules(['价税合计（含税）', '含税金额(元)', '开票日期', '销方名称']);

    // 必须检测到歧义
    expect(r.ambiguous.length).toBeGreaterThan(0);
    const field = r.ambiguous[0]!.field;
    expect(field).toBe('amountInclTax');
    expect(r.ambiguous[0]!.sources.length).toBeGreaterThan(1);

    // 涉及的列必须标记为需人工确认
    const contested = r.mappings.filter((m) => r.ambiguous[0]!.sources.includes(m.source));
    expect(contested.every((m) => m.needsConfirm)).toBe(true);

    // 必须有醒目警告，且说明后果
    expect(r.warnings.some((w) => w.includes('歧义') && w.includes('错位'))).toBe(true);

    // 仍不允许两列落到同一个字段
    const targets = r.mappings.filter((m) => m.target !== 'IGNORE').map((m) => m.target);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('无歧义的常规表头不应报出歧义（避免狼来了）', () => {
    const r = matchByRules([
      '发票代码',
      '发票号码',
      '开票日期',
      '销方名称',
      '金额',
      '税率',
      '税额',
      '价税合计',
    ]);
    expect(r.ambiguous).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('歧义'))).toBe(false);
  });

  it('无法识别的列归入 IGNORE 而不是乱猜', () => {
    const r = matchByRules(['发票代码', '开票日期', '销方名称', '价税合计', '备注列', '内部编号XYZ']);
    const map = Object.fromEntries(r.mappings.map((m) => [m.source, m.target]));
    expect(map['备注列']).toBe('IGNORE');
    expect(map['内部编号XYZ']).toBe('IGNORE');
  });

  it('★ 缺必填字段 → complete=false 且给出明确提示', () => {
    const r = matchByRules(['发票号码', '金额', '税额']);
    expect(r.complete).toBe(false);
    expect(r.missingRequired).toContain('invoiceDate');
    expect(r.missingRequired).toContain('counterpartyName');
    expect(r.missingRequired).toContain('amountInclTax');
    expect(r.warnings.some((w) => w.includes('必须有') || w.includes('缺少必填'))).toBe(true);
  });

  it('缺建议字段 → 警告但不算 incomplete', () => {
    const r = matchByRules(['开票日期', '销方名称', '价税合计']);
    expect(r.complete).toBe(true);
    expect(r.warnings.some((w) => w.includes('建议字段'))).toBe(true);
  });

  it('精确匹配的置信度为 1.0 且无需确认', () => {
    const r = matchByRules(['开票日期']);
    expect(r.mappings[0]!.confidence).toBe(1.0);
    expect(r.mappings[0]!.needsConfirm).toBe(false);
  });

  it('部分匹配置信度较低且标记需确认', () => {
    const r = matchByRules(['开票日期', '销方名称', '价税合计', '金额']);
    const partial = r.mappings.find((m) => m.confidence < 1.0);
    if (partial) expect(partial.needsConfirm).toBe(true);
  });
});

// ============================================================================
describe('★ AI 补充映射', () => {
  it('只填补规则未识别的列，不覆盖词典结果', () => {
    const rule = matchByRules(['开票日期', '自定义单位字段']);
    const merged = mergeAiMappings(rule, [
      { source: '开票日期', target: 'IGNORE', confidence: 0.9 }, // 试图覆盖，应被忽略
      { source: '自定义单位字段', target: 'counterpartyName', confidence: 0.9, reason: '语义为交易对方' },
    ]);
    const map = Object.fromEntries(merged.mappings.map((m) => [m.source, m.target]));
    expect(map['开票日期']).toBe('invoiceDate'); // 未被覆盖
    expect(map['自定义单位字段']).toBe('counterpartyName');
  });

  it('★ AI 映射置信度封顶 0.85 且强制人工确认', () => {
    const rule = matchByRules(['开票日期', '对方主体']);
    const merged = mergeAiMappings(rule, [
      { source: '对方主体', target: 'counterpartyName', confidence: 0.99 },
    ]);
    const ai = merged.mappings.find((m) => m.source === '对方主体')!;
    expect(ai.confidence).toBeLessThanOrEqual(0.85);
    expect(ai.needsConfirm).toBe(true);
    expect(ai.reason).toContain('AI 推断');
  });

  it('AI 返回不存在的目标字段 → 忽略', () => {
    const rule = matchByRules(['开票日期', '神秘列']);
    const merged = mergeAiMappings(rule, [
      { source: '神秘列', target: 'NOT_A_FIELD', confidence: 0.9 },
    ]);
    expect(merged.mappings.find((m) => m.source === '神秘列')!.target).toBe('IGNORE');
  });

  it('AI 不会把两列映射到同一字段', () => {
    const rule = matchByRules(['开票日期', '列A', '列B']);
    const merged = mergeAiMappings(rule, [
      { source: '列A', target: 'counterpartyName', confidence: 0.8 },
      { source: '列B', target: 'counterpartyName', confidence: 0.8 },
    ]);
    const targets = merged.mappings.filter((m) => m.target !== 'IGNORE').map((m) => m.target);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

// ============================================================================
describe('金额解析', () => {
  it('清理千分位与货币符号', () => {
    expect(parseAmount('1,234.56')?.toFixed(2)).toBe('1234.56');
    expect(parseAmount('¥1,234.56')?.toFixed(2)).toBe('1234.56');
    expect(parseAmount('1130.00元')?.toFixed(2)).toBe('1130.00');
    expect(parseAmount(' 1 130.00 ')?.toFixed(2)).toBe('1130.00');
  });

  it('括号负数', () => {
    expect(parseAmount('(1,234.56)')?.toFixed(2)).toBe('-1234.56');
    expect(parseAmount('（100.00）')?.toFixed(2)).toBe('-100.00');
    expect(parseAmount('-500.00')?.toFixed(2)).toBe('-500.00');
  });

  it('空值返回 null 而不是 0（0 与"没这个数"必须区分）', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount('-')).toBeNull();
    expect(parseAmount('—')).toBeNull();
  });

  it('真正的 0 返回 0', () => {
    expect(parseAmount('0')?.toFixed(2)).toBe('0.00');
    expect(parseAmount('0.00')?.toFixed(2)).toBe('0.00');
  });

  it('无法解析的返回 null', () => {
    expect(parseAmount('壹仟元整')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });

  it('接受 number 类型', () => {
    expect(parseAmount(1130)?.toFixed(2)).toBe('1130.00');
    expect(parseAmount(1130.5)?.toFixed(2)).toBe('1130.50');
  });
});

// ============================================================================
describe('日期解析', () => {
  it('多种分隔符', () => {
    expect(parseDate('2024-01-15')?.toISOString().slice(0, 10)).toBe('2024-01-15');
    expect(parseDate('2024/1/15')?.toISOString().slice(0, 10)).toBe('2024-01-15');
    expect(parseDate('2024.01.15')?.toISOString().slice(0, 10)).toBe('2024-01-15');
    expect(parseDate('2024年1月15日')?.toISOString().slice(0, 10)).toBe('2024-01-15');
  });

  it('紧凑格式 20240115', () => {
    expect(parseDate('20240115')?.toISOString().slice(0, 10)).toBe('2024-01-15');
  });

  it('★ Excel 日期序列号', () => {
    // 45292 = 2024-01-01（1900 日期系统的常见偏移）
    const d = parseDate('45292');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2024);
  });

  it('空值返回 null', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });

  it('无法解析返回 null', () => {
    expect(parseDate('二〇二四年一月')).toBeNull();
  });

  it('带时间部分也能解析到日', () => {
    expect(parseDate('2024-03-05 14:30:00')?.toISOString().slice(0, 10)).toBe('2024-03-05');
  });
});

// ============================================================================
describe('税率解析', () => {
  it('百分比字符串', () => {
    expect(parseTaxRate('13%')?.toString()).toBe('0.13');
    expect(parseTaxRate('9%')?.toString()).toBe('0.09');
    expect(parseTaxRate('6 %')?.toString()).toBe('0.06');
    expect(parseTaxRate('0.5%')?.toString()).toBe('0.005');
  });

  it('数字形式的百分比', () => {
    expect(parseTaxRate('13')?.toString()).toBe('0.13');
    expect(parseTaxRate(13)?.toString()).toBe('0.13');
    expect(parseTaxRate('3')?.toString()).toBe('0.03');
  });

  it('已是小数的形式', () => {
    expect(parseTaxRate('0.13')?.toString()).toBe('0.13');
    expect(parseTaxRate(0.09)?.toString()).toBe('0.09');
    expect(parseTaxRate('0.005')?.toString()).toBe('0.005');
  });

  it('免税/不征税 → 0', () => {
    expect(parseTaxRate('免税')?.toString()).toBe('0');
    expect(parseTaxRate('不征税')?.toString()).toBe('0');
    expect(parseTaxRate('零税率')?.toString()).toBe('0');
    expect(parseTaxRate('免征')?.toString()).toBe('0');
  });

  it('0 保持为 0', () => {
    expect(parseTaxRate('0')?.toString()).toBe('0');
    expect(parseTaxRate('0%')?.toString()).toBe('0');
  });

  it('空值返回 null', () => {
    expect(parseTaxRate('')).toBeNull();
    expect(parseTaxRate(null)).toBeNull();
  });
});

// ============================================================================
describe('布尔解析（认证/勾选状态）', () => {
  it('肯定写法', () => {
    for (const v of ['是', '有', '已认证', '已勾选', '已抵扣', 'Y', 'yes', 'true', '1', '√']) {
      expect(parseBoolean(v), `"${v}" 应为 true`).toBe(true);
    }
  });

  it('否定写法', () => {
    for (const v of ['否', '无', '未认证', '未勾选', '未抵扣', 'N', 'no', 'false', '0', '×']) {
      expect(parseBoolean(v), `"${v}" 应为 false`).toBe(false);
    }
  });

  it('★ "未认证" 不会被误判为 true（"认"字命中）', () => {
    expect(parseBoolean('未认证')).toBe(false);
    expect(parseBoolean('未勾选')).toBe(false);
    expect(parseBoolean('不予抵扣')).toBe(false);
  });

  it('空值返回 null', () => {
    expect(parseBoolean('')).toBeNull();
    expect(parseBoolean(null)).toBeNull();
  });

  it('无法判断返回 null', () => {
    expect(parseBoolean('待处理')).toBeNull();
  });
});
