/**
 * PDF 版面重建测试
 * ============================================================
 * ★ 这一份测试的价值全在"回归"两个字：下面第一组的坐标是从**真实的
 *   北京住宿电子发票**里导出来的（pdfjs getTextContent 的 transform），
 *   不是编的。改造前把同样的内容按阅读顺序平铺，模型会把购买方与
 *   销售方读反 —— 而这是一条不会报错、只会静默记错账的路径。
 *
 *   所以这里同时断言两件事：
 *     1. 重建出的文本里，购买方的名称与"购"在同一列（对齐）
 *     2. 平铺顺序下这两者**不会**对齐（即这个测试真的在测东西）
 */
import { describe, expect, it } from 'vitest';

import {
  assessTextLayer,
  countCjk,
  rebuildLayoutText,
  type PdfTextItem,
} from '../pdf-layout';

// ============================================================================
//  真实住宿发票的文本项（已裁剪到购销双方那几行）
// ============================================================================
//  一行一个文本项：原文、x、y（PDF 原点在左下角，y 越大越靠上）
//  版面：购买方在左（x≈16/32/57），销售方在右（x≈301/317/340）

const C = (str: string, x: number, y: number, height = 9): PdfTextItem => ({
  str,
  x,
  y,
  height,
});

/**
 * ★ 数组顺序刻意按**真实 PDF 的抽取顺序**排，不是按视觉顺序排 ——
 *   因为"顺序"正是这个 bug 的成因，顺序变了测试就失去意义了：
 *   标签先出右列的「销售方信息」，再出左列的「购买方信息」；
 *   而取值是左列的名称/税号在前、右列的在后。
 */
const INVOICE_PARTY_ITEMS: PdfTextItem[] = [
  // ① 竖排标签「销售方信息」——右列，但先被抽出来
  C('销', 301, 296),
  C('售', 301, 284),
  C('方', 301, 276),
  C('信', 301, 268),
  C('息', 301, 256),
  C('统一社会信用代码/纳税人识别号：', 317, 264),
  C('名称：', 317, 292),
  // ② 竖排标签「购买方信息」——左列，后被抽出来
  C('购', 16, 296),
  C('买', 16, 284),
  C('方', 16, 276),
  C('信', 16, 268),
  C('息', 16, 256),
  C('统一社会信用代码/纳税人识别号：', 32, 264),
  C('名称：', 32, 292),
  // ③ 然后才是取值：先左列（购买方），后右列（销售方）
  C('煤炭工业规划设计研究院有限公司', 57, 292),
  C('91110000710934035X', 152, 264),
  C('东宇酒店（北京）有限责任公司', 340, 292),
  C('91110113MA04CM3C37', 437, 264),
];

describe('rebuildLayoutText —— 真实住宿发票的版面还原', () => {
  const layout = rebuildLayoutText(INVOICE_PARTY_ITEMS);
  const lines = layout.split('\n');

  /** 取包含指定文字的行的列号 */
  const columnOf = (needle: string): number => {
    const line = lines.find((l) => l.includes(needle));
    if (line === undefined) throw new Error(`重建结果里找不到「${needle}」：\n${layout}`);
    return line.indexOf(needle);
  };

  it('购方标签与购方名称落在同一列，销方标签与销方名称落在同一列', () => {
    // 这两个名称必须出现在"购"所在的那一侧
    const buyCol = columnOf('购');
    const sellCol = columnOf('销');
    expect(buyCol).toBeLessThan(sellCol);

    // 煤炭工业规划设计研究院是**购买方**（左列）
    const buyerNameCol = columnOf('煤炭工业规划设计研究院有限公司');
    expect(Math.abs(buyerNameCol - buyCol)).toBeLessThan(20);

    // 东宇酒店是**销售方**（右列）
    const sellerNameCol = columnOf('东宇酒店（北京）有限责任公司');
    expect(Math.abs(sellerNameCol - sellCol)).toBeLessThan(20);
  });

  it('购方名称在销方名称左边（靠列位置就能区分，不必猜阅读顺序）', () => {
    expect(columnOf('煤炭工业规划设计研究院有限公司')).toBeLessThan(
      columnOf('东宇酒店（北京）有限责任公司'),
    );
  });

  it('两个税号也各自跟在所属方的名称之后', () => {
    expect(columnOf('91110000710934035X')).toBeLessThan(columnOf('91110113MA04CM3C37'));
  });

  it('★ 对照组：平铺（按阅读顺序）时这个区分**消失**，正是当初读反的原因', () => {
    // 旧实现就是把 items 里的 str 依次拼起来
    const flat = INVOICE_PARTY_ITEMS.map((i) => i.str).join('\n');
    const at = (needle: string) => {
      const i = flat.indexOf(needle);
      if (i < 0) throw new Error(`平铺文本里找不到「${needle}」`);
      return i;
    };

    // ① 标签的出现顺序是「先销售方、后购买方」
    expect(at('销')).toBeLessThan(at('购'));

    // ② 而取值的出现顺序是「先购买方的名称、后销售方的名称」
    expect(at('煤炭工业规划设计研究院有限公司')).toBeLessThan(
      at('东宇酒店（北京）有限责任公司'),
    );

    // ③ 于是"销售方标签之后出现的第一个名称"其实是**购买方** ——
    //    这就是读反的机制，一个纯顺序造成的错配。
    expect(at('销')).toBeLessThan(at('煤炭工业规划设计研究院有限公司'));

    // ④ 而按坐标重建后，这个错配被位置纠正回来（对照上一组用例）
    expect(columnOf('煤炭工业规划设计研究院有限公司')).toBeLessThan(
      columnOf('东宇酒店（北京）有限责任公司'),
    );
  });
});

describe('rebuildLayoutText —— 通用行为', () => {
  it('空输入返回空串', () => {
    expect(rebuildLayoutText([])).toBe('');
    expect(rebuildLayoutText([C('   ', 0, 0)])).toBe('');
  });

  it('同一行的单元格按 x 从左到右排列', () => {
    const text = rebuildLayoutText([C('右', 200, 100), C('左', 20, 100)]);
    expect(text.indexOf('左')).toBeLessThan(text.indexOf('右'));
  });

  it('y 从大到小（页面上到下），y 大的行在上面', () => {
    const text = rebuildLayoutText([C('下', 20, 100), C('上', 20, 200)]);
    expect(text.indexOf('上')).toBeLessThan(text.indexOf('下'));
  });

  it('行聚合用容差，字号内的微小 y 差不会把一行拆成两行', () => {
    const text = rebuildLayoutText([C('甲', 20, 200), C('乙', 60, 197)]);
    expect(text.split('\n').length).toBe(1);
  });

  it('y 相差超过容差就分行', () => {
    const text = rebuildLayoutText([C('甲', 20, 200), C('乙', 20, 180)]);
    expect(text.split('\n').length).toBe(2);
  });

  it('异常大的 x 不会把一行撑到失控（有上限截断）', () => {
    const text = rebuildLayoutText([C('尾', 999_999, 100)], { maxPad: 30 });
    expect(text.length).toBeLessThanOrEqual(35);
  });

  it('位置被占满时至少隔开一格，不会把两个字粘成一个词', () => {
    // 两个单元格 x 几乎相同，估算宽度偏小的情况
    const text = rebuildLayoutText([C('甲', 20, 100), C('乙', 20.5, 100)]);
    expect(text).not.toContain('甲乙');
  });

  it('行尾不留多余空格', () => {
    const text = rebuildLayoutText([C('甲', 20, 100), C('乙', 60, 100)]);
    expect(text).toBe(text.trimEnd());
  });
});

describe('countCjk', () => {
  it('统计汉字，忽略数字、字母与标点', () => {
    expect(countCjk('增值税专用发票')).toBe(7);
    expect(countCjk('12306 95306')).toBe(0);
    expect(countCjk('Beijingxi')).toBe(0);
    expect(countCjk('税率 13%')).toBe(2);
  });

  it('空串为 0', () => {
    expect(countCjk('')).toBe(0);
  });
});

describe('assessTextLayer —— 文本层可用性判据', () => {
  it('★ 火车票的真实情形：字符够长但零汉字 → 判为不可用', () => {
    // 这就是那张 04-北京雄安火车 电子发票的文本层，PDF 缺 ToUnicode 映射，
    // 中文全部丢失、只剩碎片。改造前按"字符数 ≥ 40"判定为可用，
    // 于是模型拿到碎片、字段全空，还报"票面信息不完整"—— 一张好票被说成识别不出来。
    const trainTicketLayer =
      '12306 95306:26119121152002953432BeijingxiC27292026 03 06 22:33 07 06D: 41.00' +
      '2202041985****0337:2115274086030794546462026:91110000710934035X:20260422Xiongan:';
    const verdict = assessTextLayer(trainTicketLayer);

    expect(trainTicketLayer.length).toBeGreaterThanOrEqual(40);
    expect(verdict.usable).toBe(false);
    expect(verdict.cjk).toBe(0);
  });

  it('★ 住宿发票的真实情形：汉字充足 → 判为可用', () => {
    const hotelLayer =
      '电子发票（增值税专用发票）发票号码：开票日期：销售方信息购买方信息' +
      '统一社会信用代码/纳税人识别号：名称：26112000000843435811 2026年03月05日';
    const verdict = assessTextLayer(hotelLayer);

    expect(verdict.usable).toBe(true);
    expect(verdict.cjk).toBeGreaterThanOrEqual(10);
  });

  it('太短的文本层不可用', () => {
    expect(assessTextLayer('发票').usable).toBe(false);
    expect(assessTextLayer(null).usable).toBe(false);
    expect(assessTextLayer('').usable).toBe(false);
  });

  it('不可用时会给出可读原因（会透传到前端 notes）', () => {
    const verdict = assessTextLayer('12306 95306 Beijingxi C2729 20260306 41.00 Xiongan');
    expect(verdict.reason).toContain('汉字');
    expect(verdict.reason.length).toBeGreaterThan(10);
  });

  it('可用时原因里带上字符数与汉字数', () => {
    const verdict = assessTextLayer(
      '电子发票（增值税专用发票）购买方名称：某某有限公司 销售方名称：某某酒店有限公司 价税合计 500.00',
    );
    expect(verdict.reason).toContain(String(verdict.cjk));
  });
});
