import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  dec,
  round2,
  round4,
  floor2,
  assertMoneyPrecision,
  assertPositive,
  add,
  sub,
  mul,
  div,
  sumRound2,
  eq,
  gt,
  lte,
  isZero,
  approxEq,
  checkBalance,
  assertBalanced,
  splitTaxFromExcl,
  splitTaxFromIncl,
  assertTaxConsistency,
  toChineseUppercase,
  formatMoney,
  toDbString,
  formatTaxRate,
  normalizeTaxRate,
  MoneyError,
} from '../money';

describe('金额解析 dec()', () => {
  it('接受字符串、Decimal、整数数字', () => {
    expect(dec('123.45').toFixed(2)).toBe('123.45');
    expect(dec(new Decimal('123.45')).toFixed(2)).toBe('123.45');
    expect(dec(123).toFixed(2)).toBe('123.00');
  });

  it('清理千分位、货币符号、空白与全角空格', () => {
    expect(dec('¥1,234.56').toFixed(2)).toBe('1234.56');
    expect(dec(' 1,234.56 ').toFixed(2)).toBe('1234.56');
    expect(dec('￥1,000,000.00').toFixed(2)).toBe('1000000.00');
  });

  it('空字符串视为 0', () => {
    expect(dec('').toFixed(2)).toBe('0.00');
    expect(dec('   ').toFixed(2)).toBe('0.00');
  });

  it('无法解析时抛错', () => {
    expect(() => dec('abc')).toThrow(MoneyError);
    expect(() => dec('12.3.4')).toThrow(MoneyError);
  });

  it('拒绝非有限数值', () => {
    expect(() => dec(Number.NaN)).toThrow(MoneyError);
    expect(() => dec(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe('舍入', () => {
  it('round2 使用四舍五入（ROUND_HALF_UP）', () => {
    expect(round2('1.005').toFixed(2)).toBe('1.01');
    expect(round2('1.004').toFixed(2)).toBe('1.00');
    expect(round2('2.345').toFixed(2)).toBe('2.35');
    expect(round2('0.125').toFixed(2)).toBe('0.13');
    expect(round2('-1.005').toFixed(2)).toBe('-1.01');
  });

  it('round4 用于单价数量', () => {
    expect(round4('1.00005').toString()).toBe('1.0001');
    expect(round4('3.14159').toString()).toBe('3.1416');
  });

  it('floor2 向下取整到分（保守计算）', () => {
    expect(floor2('1.999').toFixed(2)).toBe('1.99');
    expect(floor2('1.001').toFixed(2)).toBe('1.00');
  });
});

describe('★ assertMoneyPrecision 精度闸门', () => {
  it('恰好 2 位小数通过', () => {
    expect(assertMoneyPrecision('100.00').toFixed(2)).toBe('100.00');
    expect(assertMoneyPrecision('100.5').toFixed(2)).toBe('100.50');
    expect(assertMoneyPrecision('100').toFixed(2)).toBe('100.00');
  });

  it('超过 2 位小数必须抛错，绝不静默舍入', () => {
    expect(() => assertMoneyPrecision('100.001')).toThrow(/精度超过 2 位小数/);
    expect(() => assertMoneyPrecision('0.005')).toThrow(MoneyError);
  });
});

describe('★ assertPositive 正数约束', () => {
  it('正数通过', () => {
    expect(assertPositive('0.01').toFixed(2)).toBe('0.01');
  });

  it('0 与负数抛错，并提示使用 direction', () => {
    expect(() => assertPositive('0.00')).toThrow(/必须大于 0/);
    expect(() => assertPositive('-100.00')).toThrow(/direction/);
  });
});

describe('基本运算', () => {
  it('加减乘除', () => {
    expect(add('0.1', '0.2').toFixed(2)).toBe('0.30');
    expect(sub('100.00', '30.50').toFixed(2)).toBe('69.50');
    expect(mul('1000.00', '0.13').toFixed(2)).toBe('130.00');
    expect(div('1130.00', '1.13').toFixed(2)).toBe('1000.00');
  });

  it('0.1 + 0.2 精确等于 0.3（浮点会失败）', () => {
    expect(add('0.1', '0.2').eq('0.3')).toBe(true);
    expect(0.1 + 0.2).not.toBe(0.3); // 对照：number 运算不可靠
  });

  it('除零抛错', () => {
    expect(() => div('100', '0')).toThrow(/除数不能为 0/);
  });

  it('sumRound2 汇总后舍入', () => {
    expect(sumRound2(['0.005', '0.005']).toFixed(2)).toBe('0.01');
    expect(sumRound2(['100.01', '200.02', '300.03']).toFixed(2)).toBe('600.06');
  });

  it('比较运算', () => {
    expect(eq('100.00', '100')).toBe(true);
    expect(gt('100.01', '100.00')).toBe(true);
    expect(lte('100.00', '100.00')).toBe(true);
    expect(isZero('0.00')).toBe(true);
    expect(approxEq('100.00', '100.01', '0.02')).toBe(true);
    expect(approxEq('100.00', '100.05', '0.02')).toBe(false);
  });
});

describe('★★ 借贷平衡校验 checkBalance / assertBalanced', () => {
  it('标准平衡凭证通过', () => {
    const r = checkBalance([
      { direction: 'DEBIT', amount: '1000.00' },
      { direction: 'DEBIT', amount: '130.00' },
      { direction: 'CREDIT', amount: '1130.00' },
    ]);
    expect(r.balanced).toBe(true);
    expect(r.totalDebit.toFixed(2)).toBe('1130.00');
    expect(r.totalCredit.toFixed(2)).toBe('1130.00');
    expect(r.difference.toFixed(2)).toBe('0.00');
  });

  it('一分钱差异必须被发现', () => {
    const r = checkBalance([
      { direction: 'DEBIT', amount: '1000.00' },
      { direction: 'CREDIT', amount: '999.99' },
    ]);
    expect(r.balanced).toBe(false);
    expect(r.difference.toFixed(2)).toBe('0.01');
  });

  it('借贷不平抛错，且错误信息包含差额', () => {
    expect(() =>
      assertBalanced(
        [
          { direction: 'DEBIT', amount: '1000.00' },
          { direction: 'CREDIT', amount: '900.00' },
        ],
        '记-1',
      ),
    ).toThrow(/记-1借贷不平.*差额 100\.00/s);
  });

  it('空凭证抛错', () => {
    expect(() => checkBalance([])).toThrow(/没有任何分录行/);
  });

  it('单边凭证（只有借方）抛错', () => {
    expect(() => checkBalance([{ direction: 'DEBIT', amount: '100.00' }])).toThrow(/必须同时有借方和贷方/);
  });

  it('金额为 0 抛错', () => {
    expect(() =>
      checkBalance([
        { direction: 'DEBIT', amount: '0.00' },
        { direction: 'CREDIT', amount: '0.00' },
      ]),
    ).toThrow(/必须大于 0/);
  });

  it('负数金额抛错并提示改用方向', () => {
    expect(() =>
      checkBalance([
        { direction: 'DEBIT', amount: '-100.00' },
        { direction: 'CREDIT', amount: '100.00' },
      ]),
    ).toThrow(/相反方向的 direction/);
  });

  it('多借多贷复杂凭证', () => {
    const r = checkBalance([
      { direction: 'DEBIT', amount: '5000.00' },
      { direction: 'DEBIT', amount: '650.00' },
      { direction: 'DEBIT', amount: '300.00' },
      { direction: 'CREDIT', amount: '1650.00' },
      { direction: 'CREDIT', amount: '4300.00' },
    ]);
    expect(r.balanced).toBe(true);
    expect(r.totalDebit.toFixed(2)).toBe('5950.00');
  });

  it('大量小数累加仍然精确', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({
      direction: (i % 2 === 0 ? 'DEBIT' : 'CREDIT') as 'DEBIT' | 'CREDIT',
      amount: '0.01',
    }));
    const r = checkBalance(lines);
    expect(r.balanced).toBe(true);
    expect(r.totalDebit.toFixed(2)).toBe('0.50');
  });
});

describe('★ 价税分离', () => {
  it('由不含税金额正算（先算不含税，再算税）', () => {
    const r = splitTaxFromExcl('1000.00', '0.13');
    expect(r.amountExclTax.toFixed(2)).toBe('1000.00');
    expect(r.taxAmount.toFixed(2)).toBe('130.00');
    expect(r.amountInclTax.toFixed(2)).toBe('1130.00');
  });

  it('由价税合计反算：先算不含税再倒挤税额，保证三者恒等', () => {
    const r = splitTaxFromIncl('1130.00', '0.13');
    expect(r.amountExclTax.toFixed(2)).toBe('1000.00');
    expect(r.taxAmount.toFixed(2)).toBe('130.00');
    expect(r.amountInclTax.toFixed(2)).toBe('1130.00');
  });

  it('反算时不会出现 金额+税额 ≠ 价税合计 的分差', () => {
    // 这类金额最容易出现 1 分钱差异
    const cases: Array<[string, string]> = [
      ['1130.00', '0.13'],
      ['999.99', '0.13'],
      ['106.00', '0.06'],
      ['109.00', '0.09'],
      ['103.00', '0.03'],
      ['101.00', '0.01'],
      ['3333.33', '0.13'],
      ['12345.67', '0.09'],
      ['0.03', '0.03'],
      ['1.00', '0.13'],
    ];
    for (const [incl, rate] of cases) {
      const r = splitTaxFromIncl(incl, rate);
      const recomposed = r.amountExclTax.plus(r.taxAmount);
      expect(recomposed.toFixed(2)).toBe(r.amountInclTax.toFixed(2));
      expect(r.amountExclTax.plus(r.taxAmount).toFixed(2)).toBe(round2(incl).toFixed(2));
    }
  });

  it('零税率时税额为 0，不含税=含税', () => {
    const r = splitTaxFromIncl('1000.00', '0');
    expect(r.amountExclTax.toFixed(2)).toBe('1000.00');
    expect(r.taxAmount.toFixed(2)).toBe('0.00');
  });

  it('9% 旅客运输（火车票 218 元）', () => {
    const r = splitTaxFromIncl('218.00', '0.09');
    expect(r.amountExclTax.toFixed(2)).toBe('200.00');
    expect(r.taxAmount.toFixed(2)).toBe('18.00');
  });
});

describe('价税勾稽校验 assertTaxConsistency（识别规则 V1）', () => {
  it('完全一致通过', () => {
    expect(assertTaxConsistency('1000.00', '130.00', '1130.00').ok).toBe(true);
  });

  it('2 分以内容忍（票面舍入）', () => {
    expect(assertTaxConsistency('1000.00', '130.00', '1130.02').ok).toBe(true);
  });

  it('超过 2 分判定为不一致', () => {
    const r = assertTaxConsistency('1000.00', '130.00', '1130.05');
    expect(r.ok).toBe(false);
    expect(r.difference.toFixed(2)).toBe('-0.05');
  });
});

describe('★ 中文大写金额 toChineseUppercase', () => {
  it('零与整', () => {
    expect(toChineseUppercase('0')).toBe('零元整');
    expect(toChineseUppercase('0.00')).toBe('零元整');
  });

  it('仅有分', () => {
    expect(toChineseUppercase('0.05')).toBe('零元零伍分');
    expect(toChineseUppercase('0.50')).toBe('零元伍角');
    expect(toChineseUppercase('0.55')).toBe('零元伍角伍分');
  });

  it('常见整数金额', () => {
    expect(toChineseUppercase('1')).toBe('壹元整');
    expect(toChineseUppercase('10')).toBe('壹拾元整');
    expect(toChineseUppercase('100')).toBe('壹佰元整');
    expect(toChineseUppercase('1000')).toBe('壹仟元整');
    expect(toChineseUppercase('1130')).toBe('壹仟壹佰叁拾元整');
    expect(toChineseUppercase('10000')).toBe('壹万元整');
    expect(toChineseUppercase('100000')).toBe('壹拾万元整');
    expect(toChineseUppercase('1000000')).toBe('壹佰万元整');
  });

  it('含零的整数（最易出错）', () => {
    expect(toChineseUppercase('1001')).toBe('壹仟零壹元整');
    expect(toChineseUppercase('1010')).toBe('壹仟零壹拾元整');
    expect(toChineseUppercase('10001')).toBe('壹万零壹元整');
    expect(toChineseUppercase('10010')).toBe('壹万零壹拾元整');
    expect(toChineseUppercase('10100')).toBe('壹万零壹佰元整');
    expect(toChineseUppercase('100000001')).toBe('壹亿零壹元整');
  });

  it('跨段大额（亿 / 万亿）', () => {
    expect(toChineseUppercase('100000000')).toBe('壹亿元整');
    expect(toChineseUppercase('100010000')).toBe('壹亿零壹万元整');
    expect(toChineseUppercase('1234567890')).toBe('壹拾贰亿叁仟肆佰伍拾陆万柒仟捌佰玖拾元整');
    expect(toChineseUppercase('1000000000000')).toBe('壹万亿元整');
  });

  it('带角分', () => {
    expect(toChineseUppercase('1130.00')).toBe('壹仟壹佰叁拾元整');
    expect(toChineseUppercase('1130.50')).toBe('壹仟壹佰叁拾元伍角');
    expect(toChineseUppercase('1130.56')).toBe('壹仟壹佰叁拾元伍角陆分');
    expect(toChineseUppercase('100000000.01')).toBe('壹亿元零壹分');
    expect(toChineseUppercase('100.10')).toBe('壹佰元壹角');
  });

  it('负数', () => {
    expect(toChineseUppercase('-1234.56')).toBe('负壹仟贰佰叁拾肆元伍角陆分');
  });

  it('超过 2 位小数先四舍五入', () => {
    expect(toChineseUppercase('1.005')).toBe('壹元零壹分');
  });

  it('真实发票金额样例', () => {
    expect(toChineseUppercase('1130.00')).toBe('壹仟壹佰叁拾元整');
    expect(toChineseUppercase('22600.00')).toBe('贰万贰仟陆佰元整');
    expect(toChineseUppercase('319.80')).toBe('叁佰壹拾玖元捌角');
  });
});

describe('展示格式化', () => {
  it('formatMoney 千分位与固定 2 位小数', () => {
    expect(formatMoney('1234567.5')).toBe('1,234,567.50');
    expect(formatMoney('0')).toBe('0.00');
    expect(formatMoney('-1234.5')).toBe('-1,234.50');
    expect(formatMoney('1234.5', { thousands: false })).toBe('1234.50');
    expect(formatMoney('1234.5', { symbol: true })).toBe('¥1,234.50');
  });

  it('toDbString 无千分位固定 2 位', () => {
    expect(toDbString('1234567.5')).toBe('1234567.50');
    expect(toDbString('0.005')).toBe('0.01');
  });

  it('formatTaxRate', () => {
    expect(formatTaxRate('0.13')).toBe('13%');
    expect(formatTaxRate('0.09')).toBe('9%');
    expect(formatTaxRate('0.03')).toBe('3%');
    expect(formatTaxRate('0.005')).toBe('0.5%');
    expect(formatTaxRate('0')).toBe('免税');
  });

  it('normalizeTaxRate —— 百分号写法转小数（实测 MiMo 会返回 "13%"）', () => {
    expect(normalizeTaxRate('13%')).toBe('0.13');
    expect(normalizeTaxRate('9%')).toBe('0.09');
    expect(normalizeTaxRate('0.5%')).toBe('0.005');
    expect(normalizeTaxRate('13％')).toBe('0.13'); // 全角百分号
    expect(normalizeTaxRate(' 13 % ')).toBe('0.13');
  });

  it('normalizeTaxRate —— 数值 >= 1 视为百分数（合法税率全都 < 0.15，不存在歧义）', () => {
    expect(normalizeTaxRate('13')).toBe('0.13');
    expect(normalizeTaxRate(13)).toBe('0.13');
    expect(normalizeTaxRate('6')).toBe('0.06');
    expect(normalizeTaxRate('3')).toBe('0.03');
  });

  it('normalizeTaxRate —— 已经是小数的原样保留', () => {
    expect(normalizeTaxRate('0.13')).toBe('0.13');
    expect(normalizeTaxRate('0.06')).toBe('0.06');
    expect(normalizeTaxRate(0)).toBe('0');
  });

  it('normalizeTaxRate —— 空值返回 undefined，交给上游当"未识别到"', () => {
    expect(normalizeTaxRate(null)).toBeUndefined();
    expect(normalizeTaxRate(undefined)).toBeUndefined();
    expect(normalizeTaxRate('')).toBeUndefined();
    expect(normalizeTaxRate('   ')).toBeUndefined();
  });

  it('normalizeTaxRate —— ★ 认不出的写法不抛异常，原样交回让 V3 报"不在合法枚举内"', () => {
    // 关键：这里若抛 MoneyError，用户看到的是 500 + "无法解析为金额"，
    // 而实际上他需要的是"税率写法不对"。可以报错，但必须是能看懂的那种。
    expect(() => normalizeTaxRate('免税')).not.toThrow();
    expect(normalizeTaxRate('免税')).toBe('免税');
    expect(() => normalizeTaxRate('abc')).not.toThrow();
  });

  it('normalizeTaxRate —— 0.13% 不是合法税率，但归一化本身不该拦，交给 V3', () => {
    expect(normalizeTaxRate('0.13%')).toBe('0.0013');
  });

  it('normalizeTaxRate 的结果可以直接喂给 dec（改造前 "13%" 会在这里抛）', () => {
    expect(() => dec(normalizeTaxRate('13%')!)).not.toThrow();
    expect(dec(normalizeTaxRate('13%')!).equals('0.13')).toBe(true);
  });
});

describe('元与分转换（避免科学计数法）', () => {
  it('极小金额不输出科学计数法', () => {
    expect(dec('0.01').toString()).toBe('0.01');
    expect(dec('0.000001').toString()).toBe('0.000001');
  });

  it('大额不输出科学计数法', () => {
    expect(dec('1000000000000').toString()).toBe('1000000000000');
  });
});
