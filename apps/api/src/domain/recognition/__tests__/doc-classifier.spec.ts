/**
 * 单据类型自动判定 —— 单元测试
 * ============================================================
 * 这个分类器的失败模式与别的模块不同：
 *   它判错了**不会立刻报错**，而是把数据送进错误的识别管道 ——
 *   把资产负债表当发票识别，AI 会被要求从表里抽"发票号码"，
 *   抽不出来还硬抽，最后可能生成一张完全错误的记录并落库。
 *
 * 所以测试重点是三件事：
 *   ① 典型单据必须判对
 *   ② **容易混淆的组合必须判对**（申报表 vs 利润表；台账 vs 单张票）
 *   ③ 判不出来时必须老实说判不出来，并给出选项目标
 */
import { describe, expect, it } from 'vitest';
import {
  canAutoRoute,
  classificationLabel,
  classifyDocument,
  type ClassifyInput,
} from '../doc-classifier';

const img = (text: string | null = null, name = 'scan.png'): ClassifyInput => ({
  fileName: name,
  text,
});

const xlsx = (text: string, name = '报表.xlsx'): ClassifyInput => ({
  fileName: name,
  text,
});

const pdf = (text: string, name = 'doc.pdf'): ClassifyInput => ({
  fileName: name,
  text,
});

// ============================================================================
describe('发票识别', () => {
  it('增值税专用发票（有标题有字段）→ INVOICE，高置信', () => {
    const c = classifyDocument(
      pdf(`
        增值税专用发票
        发票代码 044001900111
        发票号码 12345678
        购买方名称：演示科技有限公司
        纳税人识别号：91110108MA01XXXX1A
        销售方名称：某某商贸有限公司
        价税合计（大写）壹仟壹佰叁拾元整 （小写）¥1130.00
      `),
    );
    expect(c.kind).toBe('INVOICE');
    expect(c.targetType).toBe('INVOICE');
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
    expect(c.needsConfirmation).toBe(false);
  });

  it('数电票也能识别', () => {
    const c = classifyDocument(pdf('电子发票（普通发票）\n发票号码：24312000000012345678\n价税合计 ¥500.00'));
    expect(c.kind).toBe('INVOICE');
    expect(c.targetType).toBe('INVOICE');
  });

  it('只有字段没有标题 → 仍判为发票，但置信度中等', () => {
    const c = classifyDocument(pdf('发票号码 12345678\n价税合计 1130.00'));
    expect(c.kind).toBe('INVOICE');
    expect(c.confidence).toBeLessThan(0.9);
  });
});

// ============================================================================
describe('★★ 容易混淆：申报表 vs 利润表', () => {
  it('★★ 企业所得税年度申报表含"利润总额""营业收入"，必须判为申报表而不是利润表', () => {
    const c = classifyDocument(
      pdf(`
        中华人民共和国企业所得税年度纳税申报表（A类）
        行次  项目  本年累计金额
        1     营业收入        2680000.00
        2     营业成本        1890000.00
        3     利润总额        325000.00
        10    应纳税所得额    325000.00
        11    税率            0.25
        12    应纳所得税额    81250.00
        减：弥补以前年度亏损  0.00
      `),
    );
    expect(c.kind).toBe('STATEMENT');
    expect(c.statementType).toBe('TAX_RETURN_CIT');
    expect(c.targetType).toBe('TAX_RETURN');
    expect(classificationLabel(c)).toContain('企业所得税');
    // ★ 绝不能是利润表
    expect(c.statementType).not.toBe('INCOME_STATEMENT');
  });

  it('★ 增值税申报表判为 TAX_RETURN_VAT', () => {
    const c = classifyDocument(
      pdf(`
        增值税及附加税费申报表（一般纳税人适用）
        税款所属期：2024年12月01日至2024年12月31日
        1  按适用税率计税销售额   412000.00
        11 销项税额               53560.00
        12 进项税额               38600.00
        19 应纳税额               14960.00
        20 期末留抵税额           0.00
      `),
    );
    expect(c.statementType).toBe('TAX_RETURN_VAT');
    expect(c.targetType).toBe('TAX_RETURN');
  });

  it('纯利润表（无申报表字样）判为 INCOME_STATEMENT', () => {
    const c = classifyDocument(
      xlsx(`
        利润表
        会小企02表
        项目  行次  本期金额  上期金额
        一、营业收入  1  2680000.00  2310000.00
        减：营业成本  2  1890000.00  1640000.00
        三、利润总额  11  325000.00  254000.00
        四、净利润    13  308750.00  241300.00
      `),
    );
    expect(c.statementType).toBe('INCOME_STATEMENT');
    expect(c.targetType).toBe('INCOME_STATEMENT');
  });

  it('资产负债表判为 BALANCE_SHEET', () => {
    const c = classifyDocument(
      xlsx(`
        资产负债表
        会小企01表
        项目  行次  期末余额  年初余额
        货币资金 1  386400.00  298000.00
        资产总计 30 1238400.00 1062000.00
        负债合计 47 356900.00  321000.00
        负债和所有者权益总计 52 1238400.00 1062000.00
      `),
    );
    expect(c.statementType).toBe('BALANCE_SHEET');
    expect(c.targetType).toBe('BALANCE_SHEET');
  });
});

// ============================================================================
describe('★★ 容易混淆：发票台账 vs 单张发票', () => {
  it('★★ Excel 里的发票明细台账不得走单张票识别', () => {
    // ★ 测试数据必须用真实分隔符（逗号或报告读取器产出的「 | 」）。
    //   手写空格分隔会绕过网格判定，测不出真实行为 —— 踩过这个坑。
    const c = classifyDocument(
      xlsx(
        [
          '开票日期,发票代码,发票号码,购买方名称,价税合计',
          '2024-01-05,044001900111,12345678,甲公司,1130.00',
          '2024-01-08,044001900111,12345679,乙公司,2260.00',
          '2024-01-12,044001900111,12345680,丙公司,3390.00',
        ].join('\n'),
      ),
    );
    expect(c.kind).toBe('INVOICE');
    // ★ 台账不能自动路由到单张票识别
    expect(c.targetType).toBeNull();
    expect(c.needsConfirmation).toBe(true);
    expect(canAutoRoute(c)).toBe(false);
    expect(c.reason).toContain('台账');
    // 必须指引到正确的功能
    expect(c.hint).toContain('历史数据导入');
  });

  it('★ 台账经报告读取器转成「 | 」分隔后同样判为台账', () => {
    const c = classifyDocument(
      xlsx(
        [
          '开票日期 | 发票代码 | 发票号码 | 购买方名称 | 价税合计',
          '2024-01-05 | 044001900111 | 12345678 | 甲公司 | 1130.00',
          '2024-01-08 | 044001900111 | 12345679 | 乙公司 | 2260.00',
        ].join('\n'),
      ),
    );
    expect(c.kind).toBe('INVOICE');
    expect(c.targetType).toBeNull();
    expect(c.reason).toContain('台账');
  });

  it('★ 单张票的表格（一行数据）判为单张票，不必多问一次', () => {
    const c = classifyDocument(
      xlsx('发票代码,发票号码,价税合计\\n044001900111,12345678,1130.00'),
    );
    expect(c.kind).toBe('INVOICE');
    expect(c.targetType).toBe('INVOICE');
    expect(c.needsConfirmation).toBe(false);
  });

  it('★ 逐行文本形式的单张发票（.txt）应判为发票，而不是台账', () => {
    // 真实场景：有些开票软件导出的是"字段 值"逐行文本，不是表格网格
    const c = classifyDocument({
      fileName: 'invoice.txt',
      text: '增值税专用发票\n发票代码 044001900111\n发票号码 12345678\n价税合计（小写）¥1130.00',
    });
    expect(c.kind).toBe('INVOICE');
    expect(c.targetType).toBe('INVOICE');
    expect(c.needsConfirmation).toBe(false);
  });
});

// ============================================================================
describe('银行类单据', () => {
  it('银行回单（单笔）→ BANK_SLIP', () => {
    const c = classifyDocument(
      pdf('电子回单\n付款人：演示科技有限公司\n收款人：某某供应商\n交易流水号：20240105000123\n金额：1130.00'),
    );
    expect(c.kind).toBe('BANK_SLIP');
    expect(c.targetType).toBe('BANK_SLIP');
  });

  it('★ 银行流水（多笔）→ BANK_STATEMENT，不能判成回单', () => {
    const c = classifyDocument(
      xlsx(
        '交易明细\n交易日期 对方户名 借方发生额 贷方发生额 账户余额\n2024-01-05 甲公司 0.00 1130.00 386400.00\n2024-01-08 乙公司 500.00 0.00 385900.00',
        '流水.xlsx',
      ),
    );
    expect(c.kind).toBe('BANK_STATEMENT');
    expect(c.targetType).toBe('BANK_STATEMENT');
    expect(c.targetType).not.toBe('BANK_SLIP');
  });
});

// ============================================================================
describe('合同与收据', () => {
  it('合同 → CONTRACT，且不参与记账（无识别目标）', () => {
    const c = classifyDocument(
      pdf('采购合同\n甲方：演示科技有限公司\n乙方：某某商贸有限公司\n第一条 标的\n本合同自双方签字之日起生效'),
    );
    expect(c.kind).toBe('CONTRACT');
    // ★ 合同只作辅助备查，不参与记账
    expect(c.targetType).toBeNull();
    expect(c.reason).toContain('不参与记账');
  });

  it('收据 → RECEIPT，并提示税前扣除风险', () => {
    const c = classifyDocument(pdf('收款收据\n今收到 演示科技有限公司 款项 1130.00 元'));
    expect(c.kind).toBe('RECEIPT');
    expect(c.reason).toContain('税前扣除');
  });
});

// ============================================================================
describe('★★ 判不出来时必须老实说', () => {
  it('★★ 纯图片无文本层 → UNKNOWN，不猜', () => {
    const c = classifyDocument(img(null, 'photo.png'));
    expect(c.kind).toBe('UNKNOWN');
    expect(c.targetType).toBeNull();
    expect(c.confidence).toBe(0);
    expect(c.needsConfirmation).toBe(true);
    expect(canAutoRoute(c)).toBe(false);
    // ★ 必须列出可选目标，而不是只说"失败了"
    expect(c.hint).toContain('发票');
    expect(c.hint).toContain('资产负债表');
  });

  it('内容完全无关 → UNKNOWN', () => {
    const c = classifyDocument(pdf('这是一份随便写的说明文档，没有任何单据特征。'));
    expect(c.kind).toBe('UNKNOWN');
    expect(c.needsConfirmation).toBe(true);
  });

  it('Excel 但既不是报表也不是发票台账 → UNKNOWN 并说明原因', () => {
    const c = classifyDocument(xlsx('姓名,年龄,备注\n张三,30,无'));
    expect(c.kind).toBe('UNKNOWN');
    expect(c.evidence.some((e) => e.signal.includes('表格格式'))).toBe(true);
  });
});

// ============================================================================
describe('判定依据必须可展示', () => {
  it('★ 每次判定都要给出至少一条依据', () => {
    const samples: ClassifyInput[] = [
      pdf('增值税专用发票\n发票号码 12345678'),
      xlsx('资产负债表\n项目 期末余额\n资产总计 100.00'),
      pdf('电子回单\n付款人：甲\n收款人：乙'),
      img(null, 'x.png'),
    ];
    for (const s of samples) {
      const c = classifyDocument(s);
      expect(c.evidence.length, `${s.fileName} 无判定依据`).toBeGreaterThan(0);
      expect(c.reason.length, `${s.fileName} 无结论说明`).toBeGreaterThan(5);
    }
  });

  it('★ 依据强度分级：文件类型 / 标题 / 字段', () => {
    const c = classifyDocument(xlsx('资产负债表\n期末余额 100.00\n资产总计 100.00'));
    const strengths = c.evidence.map((e) => e.strength);
    expect(strengths).toContain('FILE_TYPE');
    expect(strengths.some((s) => s === 'TITLE' || s === 'FIELD')).toBe(true);
  });

  it('★ 判不出来时也要有依据（说明"我看了什么、没命中"）', () => {
    const c = classifyDocument(pdf('无关内容'));
    expect(c.evidence.length).toBeGreaterThan(0);
    expect(c.evidence[0]!.signal).toContain('未命中');
  });
});

// ============================================================================
describe('canAutoRoute 的语义', () => {
  it('★ 只有不需要确认且有目标类型时才可自动路由', () => {
    const invoice = classifyDocument(pdf('增值税专用发票\n发票号码 12345678\n价税合计 100.00'));
    expect(canAutoRoute(invoice)).toBe(true);

    // 台账必须有**多行数据** —— 单行是单张票，判为可自动路由是对的
    const ledger = classifyDocument(
      xlsx(
        [
          '发票号码,价税合计,开票日期',
          '12345678,100.00,2024-01-05',
          '12345679,200.00,2024-01-06',
        ].join('\n'),
      ),
    );
    expect(canAutoRoute(ledger)).toBe(false);

    const unknown = classifyDocument(img());
    expect(canAutoRoute(unknown)).toBe(false);
  });
});
