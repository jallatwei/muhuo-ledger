/**
 * 进项凭证类型判定测试
 * ============================================================
 * ★ 这一份测的是「凭证类型 → 进项税怎么算」这条链路的**唯一入口**。
 *
 *   改造前它散在两处按关键词匹配的代码里，两边各维护关键词，
 *   分叉的后果是税额算错。所以这里既测判定本身，也测
 *   「每一类凭证都有明确税务处理、没有漏网的」。
 */
import { describe, expect, it } from 'vitest';

import {
  VOUCHER_RULES,
  classifyVoucher,
  deductibleByVoucherType,
  statutoryRateOf,
  type VoucherType,
} from '../voucher-type';

describe('classifyVoucher —— 真实票面的类别文本', () => {
  const cases: Array<[string, VoucherType]> = [
    ['增值税专用发票', 'SPECIAL_VAT'],
    ['增值税普通发票', 'GENERAL_VAT'],
    ['电子发票（铁路电子客票）', 'TRAIN'],
    ['电子发票（航空运输电子客票行程单）', 'AIR'],
    ['河北通用机打发票（出租车卷式）', 'TAXI'],
    ['出租车发票', 'TAXI'],
    ['收费公路通行费增值税电子普通发票', 'TOLL'],
    ['公路客运客票', 'ROAD_WATER'],
  ];

  for (const [text, expected] of cases) {
    it(`「${text}」→ ${expected}`, () => {
      expect(classifyVoucher({ category: text }).type).toBe(expected);
    });
  }

  it('★ 航空要排在铁路前面：「航空运输电子客票行程单」也含"电子客票"', () => {
    // 若先判铁路又把"电子客票"当铁路特征，航空行程单会被认成铁路
    expect(classifyVoucher({ category: '电子发票（航空运输电子客票行程单）' }).type).toBe('AIR');
    expect(classifyVoucher({ category: '航空运输电子客票行程单' }).type).toBe('AIR');
  });

  it('★ 铁路要排在通用"电子发票"前面，否则会被当成普通电子发票', () => {
    expect(classifyVoucher({ category: '电子发票（铁路电子客票）' }).type).toBe('TRAIN');
  });

  it('★ 网约车/出租车公司的增值税电子普通发票不算出租车卷式票', () => {
    // 那是合规扣税凭证（票面列明税额、凭票直抵），不能一起清零
    expect(classifyVoucher({ category: '出租车增值税电子普通发票' }).type).not.toBe('TAXI');
    expect(deductibleByVoucherType(classifyVoucher({ category: '出租车增值税电子普通发票' }).type)).toBe(true);
  });
});

describe('★ 分类器必须同时接受枚举值（否则校验会静默失灵）', () => {
  // category 有两个来源：模型读出的中文类别，以及已规范化的枚举值
  // （mock 样例、前端回传已确认的凭证都是后者）。
  // 改造初期只匹配中文，传 "SPECIAL_VAT" 时认不出、落到 OTHER，
  // 于是"不可抵扣"把税额清成 0 —— V1/V2/V3 等金额规则**全部失效**，
  // 而且不报任何错。校验静默失灵比判错类型更危险。
  const all: VoucherType[] = [
    'SPECIAL_VAT',
    'GENERAL_VAT',
    'E_INVOICE',
    'TRAIN',
    'AIR',
    'TOLL',
    'TAXI',
    'ROAD_WATER',
    'OTHER',
  ];

  for (const type of all) {
    it(`传枚举值 "${type}" 时原样返回，不退化成 OTHER`, () => {
      expect(classifyVoucher({ category: type }).type).toBe(type);
    });
  }

  it('大小写不敏感（前端可能传小写）', () => {
    expect(classifyVoucher({ category: 'special_vat' }).type).toBe('SPECIAL_VAT');
  });

  it('枚举值优先于关键词：带枚举值时不会被文件名带偏', () => {
    expect(classifyVoucher({ category: 'SPECIAL_VAT', fileName: '06-出租车.jpg' }).type).toBe(
      'SPECIAL_VAT',
    );
  });
});

describe('classifyVoucher —— 证据优先级与兜底', () => {
  it('类别认不出时退到文件名（不受模型影响，往往更可靠）', () => {
    const r = classifyVoucher({ category: '看不懂的类别', fileName: '04-北京雄安火车-电子发票.pdf' });
    expect(r.type).toBe('TRAIN');
    expect(r.reason).toContain('文件名');
  });

  it('类别与文件名都认不出时退到票面文本层', () => {
    const r = classifyVoucher({ text: '中国铁路 12306 电子发票（铁路电子客票） 票价 ¥41.00' });
    expect(r.type).toBe('TRAIN');
    expect(r.reason).toContain('票面文本');
  });

  it('全都没有 → OTHER，并说明没认出来', () => {
    const r = classifyVoucher({});
    expect(r.type).toBe('OTHER');
    expect(r.reason).toContain('没能识别');
  });

  it('类别对时不看文件名（类别是模型直接读票面的，最可信）', () => {
    const r = classifyVoucher({ category: '增值税专用发票', fileName: '06-出租车.jpg' });
    expect(r.type).toBe('SPECIAL_VAT');
  });
});

describe('VOUCHER_RULES —— 每一类都必须有明确的税务处理', () => {
  it('★ 枚举里的每一类都能查到规则（防止新增类型漏配规则）', () => {
    for (const [type, rule] of Object.entries(VOUCHER_RULES)) {
      expect(rule.label, `${type} 缺 label`).toBeTruthy();
      expect(rule.basis, `${type} 缺税法依据`).toBeTruthy();
      expect(['STATED', 'COMPUTE', 'NONE']).toContain(rule.deduction);
      if (rule.deduction === 'COMPUTE') {
        expect(rule.statutoryRate, `${type} 是计算抵扣但没给法定税率`).toBeTruthy();
      }
    }
  });

  it('法定税率：铁路/航空 9%，公路水路 3%', () => {
    expect(statutoryRateOf('TRAIN')).toBe('0.09');
    expect(statutoryRateOf('AIR')).toBe('0.09');
    expect(statutoryRateOf('ROAD_WATER')).toBe('0.03');
  });

  it('专票/普票是凭票直抵，没有"法定税率"可倒算', () => {
    expect(statutoryRateOf('SPECIAL_VAT')).toBeNull();
    expect(statutoryRateOf('GENERAL_VAT')).toBeNull();
    expect(statutoryRateOf('E_INVOICE')).toBeNull();
  });

  it('★ 出租车与"没认出来"都不可抵扣', () => {
    expect(deductibleByVoucherType('TAXI')).toBe(false);
    expect(deductibleByVoucherType('OTHER')).toBe(false);
  });

  it('★ 出租车规则里必须写明"不要按 3% 倒算"（否则容易凭空多抵）', () => {
    expect(VOUCHER_RULES.TAXI.basis).toContain('3%');
    expect(VOUCHER_RULES.TAXI.basis).toContain('多抵');
  });

  it('旅客运输的规则要引用 13号公告（审计时可追溯）', () => {
    for (const t of ['TRAIN', 'AIR', 'ROAD_WATER'] as VoucherType[]) {
      expect(VOUCHER_RULES[t].basis).toContain('2026年第13号');
    }
  });
});