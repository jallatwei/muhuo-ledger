/**
 * 税务政策检索纯逻辑单元测试
 * ============================================================
 * 政策检索最容易出的问题不是"抓不到"，而是**抓到了但呈现得让人误判**：
 *   · 状态说成"现行有效"（暗示可以适用），而实际只是"按日期推算已施行"
 *   · 只给标题摘要，用户看不到限定条件
 *   · 抓取全挂了却报"本期无新政策"
 *   · 内容被修订了却因为链接没变而完全没提示
 *
 * 这些都是纯逻辑可以覆盖的，所以在这里逐条钉死。
 */
import { describe, expect, it } from 'vitest';
import {
  BuiltinCatalogFetcher,
  extractConditions,
  extractDocumentNo,
  extractKeywords,
  hashPolicy,
  deriveStatus,
  diffPolicies,
  inferTaxTypes,
  runFetch,
  type PolicyFetcher,
  type PolicySource,
  type RawPolicyItem,
} from '../policy-search';

const item = (over: Partial<RawPolicyItem> = {}): RawPolicyItem => ({
  title: '关于某税收政策的公告',
  sourceUrl: 'https://www.chinatax.gov.cn/x.html',
  sourceName: '国家税务总局 政策文件',
  content: '正文内容',
  ...over,
});

// ============================================================================
describe('deriveStatus 只按日期推算，不做适用性判断', () => {
  const asOf = new Date('2024-06-15T00:00:00Z');

  it('已过施行日、未到失效日 → EFFECTIVE', () => {
    expect(deriveStatus('2024-01-01', '2027-12-31', asOf)).toBe('EFFECTIVE');
  });

  it('★ 尚未到施行日 → UPCOMING', () => {
    expect(deriveStatus('2024-12-01', null, asOf)).toBe('UPCOMING');
  });

  it('★ 已过失效日 → EXPIRED', () => {
    expect(deriveStatus('2020-01-01', '2023-12-31', asOf)).toBe('EXPIRED');
  });

  it('无失效日期 → 视作仍在施行（不擅自判为失效）', () => {
    expect(deriveStatus('2020-01-01', null, asOf)).toBe('EFFECTIVE');
  });

  it('完全没有日期 → 默认 EFFECTIVE（不猜 UPCOMING）', () => {
    expect(deriveStatus(null, null, asOf)).toBe('EFFECTIVE');
  });

  it('边界：施行日当天即为已施行', () => {
    expect(deriveStatus('2024-06-15', null, asOf)).toBe('EFFECTIVE');
  });

  it('边界：失效日当天仍为已施行', () => {
    expect(deriveStatus('2024-01-01', '2024-06-15', asOf)).toBe('EFFECTIVE');
  });
});

// ============================================================================
describe('inferTaxTypes 税种识别', () => {
  it('识别增值税', () => {
    expect(inferTaxTypes('增值税减免公告', '')).toContain('VAT');
  });

  it('识别企业所得税', () => {
    expect(inferTaxTypes('小微企业所得税优惠', '')).toContain('CIT');
  });

  it('识别附加税费（城建税/教育费附加）', () => {
    expect(inferTaxTypes('城市维护建设税法', '教育费附加')).toContain('SURTAX');
  });

  it('识别印花税与个人所得税', () => {
    expect(inferTaxTypes('印花税公告', '')).toContain('STAMP_DUTY');
    expect(inferTaxTypes('个人所得税汇算', '')).toContain('IIT');
  });

  it('★ 认不出税种时标 OTHER，而不是硬塞一个', () => {
    expect(inferTaxTypes('关于某事项的公告', '无关内容')).toEqual(['OTHER']);
  });

  it('一条政策可命中多个税种', () => {
    const types = inferTaxTypes('关于小微企业税费政策的公告', '增值税、企业所得税、印花税均有涉及');
    expect(types).toContain('VAT');
    expect(types).toContain('CIT');
    expect(types).toContain('STAMP_DUTY');
  });
});

// ============================================================================
describe('extractConditions 摘出限定条件', () => {
  it('★ 摘出「同时符合下列条件」', () => {
    const content = '一、某政策如下。\n二、小型微利企业，是指同时符合以下三个条件的企业：\n年度应纳税所得额不超过300万元。';
    const conds = extractConditions(content);
    expect(conds.length).toBeGreaterThan(0);
    expect(conds.join(' ')).toContain('同时符合');
  });

  it('★ 摘出含具体门槛数字的条款', () => {
    const conds = extractConditions('（一）纳税人所在地在市区的，税率为百分之七；\n年度不超过300万元的部分。');
    expect(conds.join(' ')).toContain('300');
  });

  it('★★ 限定条件里必须能看到人数与资产总额（小微三项条件）', () => {
    const content =
      '小型微利企业，是指从事国家非限制和禁止行业，且同时符合以下三个条件的企业：' +
      '年度应纳税所得额不超过300万元、从业人数不超过300人、资产总额不超过5000万元。';
    const conds = extractConditions(content).join(' ');
    expect(conds).toContain('300人');
    expect(conds).toContain('5000万元');
  });

  it('没有条件句时返回空数组（不硬凑）', () => {
    expect(extractConditions('本公告自发布之日起施行。')).toEqual([]);
  });

  it('去重且过滤超长行', () => {
    const long = `同时符合${'很长的内容'.repeat(80)}`;
    const conds = extractConditions(`同时符合下列条件\n同时符合下列条件\n${long}`);
    expect(conds.filter((c) => c === '同时符合下列条件')).toHaveLength(1);
  });
});

// ============================================================================
describe('extractDocumentNo 文号识别', () => {
  it('识别财政部 税务总局公告文号', () => {
    expect(extractDocumentNo('财政部 税务总局公告2023年第12号', '')).toBe(
      '财政部税务总局公告2023年第12号',
    );
  });

  it('识别国家税务总局公告文号', () => {
    expect(extractDocumentNo('国家税务总局公告2024年第5号', '')).toBe(
      '国家税务总局公告2024年第5号',
    );
  });

  it('★ 识别省级税务机关公告（地方政策）', () => {
    const no = extractDocumentNo('国家税务总局吉林省税务局公告2023年第1号', '');
    expect(no).toContain('2023年第1号');
  });

  it('识别主席令', () => {
    expect(extractDocumentNo('中华人民共和国城市维护建设税法', '主席令第五十一号')).toBe(
      '主席令第五十一号',
    );
  });

  it('没有文号时返回 null（不编一个）', () => {
    expect(extractDocumentNo('某通知', '无文号内容')).toBeNull();
  });
});

// ============================================================================
describe('extractKeywords 关键词初筛', () => {
  it('命中影响适用判断的词', () => {
    const kw = extractKeywords('小微企业增值税优惠', '小规模纳税人免征增值税');
    expect(kw).toContain('小微企业');
    expect(kw).toContain('小规模纳税人');
  });

  it('★ 一般纳税人与小规模纳税人要能区分（适用完全不同）', () => {
    const kw = extractKeywords('适用3%征收率', '本公告适用于小规模纳税人，一般纳税人不适用');
    expect(kw).toContain('小规模纳税人');
    expect(kw).toContain('一般纳税人');
  });

  it('无命中返回空数组', () => {
    expect(extractKeywords('某公告', '普通内容')).toEqual([]);
  });
});

// ============================================================================
describe('hashPolicy 内容哈希', () => {
  it('相同内容哈希相同', () => {
    expect(hashPolicy(item())).toBe(hashPolicy(item()));
  });

  it('★★ 正文变化 → 哈希变化（这是发现"政策被修订"的唯一依据）', () => {
    expect(hashPolicy(item({ content: 'A' }))).not.toBe(hashPolicy(item({ content: 'B' })));
  });

  it('★ 施行日期变化 → 哈希变化', () => {
    expect(hashPolicy(item({ effectiveFrom: '2024-01-01' }))).not.toBe(
      hashPolicy(item({ effectiveFrom: '2024-07-01' })),
    );
  });

  it('标题变化 → 哈希变化', () => {
    expect(hashPolicy(item({ title: 'X' }))).not.toBe(hashPolicy(item({ title: 'Y' })));
  });
});

// ============================================================================
describe('diffPolicies 新增/变更/未变', () => {
  it('首次入库全部算新增', () => {
    const r = diffPolicies({ fetched: [item({ sourceUrl: 'u1' }), item({ sourceUrl: 'u2' })], existing: [] });
    expect(r.added).toHaveLength(2);
    expect(r.changed).toHaveLength(0);
    expect(r.unchanged).toBe(0);
  });

  it('★★ 链接未变但正文变了 → 必须报为「变更」（最易漏的一类）', () => {
    const first = item({ sourceUrl: 'u1', content: '原内容' });
    const r = diffPolicies({
      fetched: [item({ sourceUrl: 'u1', content: '修订后的内容' })],
      existing: [{ sourceUrl: 'u1', contentHash: hashPolicy(first), title: first.title }],
    });
    expect(r.changed).toHaveLength(1);
    expect(r.added).toHaveLength(0);
  });

  it('内容完全相同 → 未变', () => {
    const same = item({ sourceUrl: 'u1' });
    const r = diffPolicies({
      fetched: [same],
      existing: [{ sourceUrl: 'u1', contentHash: hashPolicy(same), title: same.title }],
    });
    expect(r.unchanged).toBe(1);
    expect(r.added).toHaveLength(0);
    expect(r.changed).toHaveLength(0);
  });

  it('新链接与已有链接混合', () => {
    const old = item({ sourceUrl: 'u1' });
    const r = diffPolicies({
      fetched: [old, item({ sourceUrl: 'u2' })],
      existing: [{ sourceUrl: 'u1', contentHash: hashPolicy(old), title: old.title }],
    });
    expect(r.unchanged).toBe(1);
    expect(r.added).toHaveLength(1);
  });
});

// ============================================================================
describe('runFetch 抓取失败必须能被看见', () => {
  const sources: PolicySource[] = [
    { key: 'a', name: '来源A', jurisdiction: 'CN-GENERAL', url: 'https://a.gov.cn', covers: '' },
    { key: 'b', name: '来源B', jurisdiction: 'CN-GENERAL', url: 'https://b.gov.cn', covers: '' },
  ];

  class OkFetcher implements PolicyFetcher {
    readonly name = 'ok';
    async fetch(source: PolicySource): Promise<RawPolicyItem[]> {
      return [item({ sourceUrl: `https://x.gov.cn/${source.key}` })];
    }
  }

  class AllFailFetcher implements PolicyFetcher {
    readonly name = 'all-fail';
    async fetch(): Promise<RawPolicyItem[]> {
      throw new Error('网络不可达');
    }
  }

  class HalfFailFetcher implements PolicyFetcher {
    readonly name = 'half-fail';
    async fetch(source: PolicySource): Promise<RawPolicyItem[]> {
      if (source.key === 'b') throw new Error('超时');
      return [item({ sourceUrl: `https://x.gov.cn/${source.key}` })];
    }
  }

  it('全部成功 → SUCCESS', async () => {
    const r = await runFetch({ jurisdiction: 'CN-GENERAL', fetcher: new OkFetcher(), sources });
    expect(r.status).toBe('SUCCESS');
    expect(r.sourcesFailed).toBe(0);
    expect(r.items).toHaveLength(2);
  });

  it('部分失败 → PARTIAL，且列出失败来源', async () => {
    const r = await runFetch({ jurisdiction: 'CN-GENERAL', fetcher: new HalfFailFetcher(), sources });
    expect(r.status).toBe('PARTIAL');
    expect(r.sourcesFailed).toBe(1);
    expect(r.sourceResults.filter((x) => !x.ok)).toHaveLength(1);
  });

  it('★★ 全部失败 → FAILED，且明确声明「不能用来判断没有新政策」', async () => {
    const r = await runFetch({ jurisdiction: 'CN-GENERAL', fetcher: new AllFailFetcher(), sources });
    expect(r.status).toBe('FAILED');
    expect(r.warnings.join(' ')).toContain('不能');
    expect(r.warnings.join(' ')).toContain('没有新政策');
  });

  it('★★ 没有登记来源时给出提示，而不是静默返回空', async () => {
    const r = await runFetch({
      jurisdiction: 'CN-XX-NOWHERE',
      fetcher: new OkFetcher(),
      // ★ 必须传一个**地方**来源才会被过滤掉：
      //   CN-GENERAL（国家层面）按设计对所有报税地都生效，
      //   用它做这个用例会得到"来源数=1"，与断言意图不符。
      sources: [
        { key: 'sh', name: '上海', jurisdiction: 'CN-SH', url: 'https://s.gov.cn', covers: '' },
      ],
    });
    expect(r.sourcesTried).toBe(0);
    expect(r.warnings.join(' ')).toContain('没有为报税地');
  });

  it('国家层面来源对所有报税地都适用', async () => {
    const r = await runFetch({
      jurisdiction: 'CN-JL',
      fetcher: new OkFetcher(),
      sources: [
        { key: 'n', name: '国家', jurisdiction: 'CN-GENERAL', url: 'https://n.gov.cn', covers: '' },
        { key: 'j', name: '吉林', jurisdiction: 'CN-JL', url: 'https://j.gov.cn', covers: '' },
        { key: 's', name: '上海', jurisdiction: 'CN-SH', url: 'https://s.gov.cn', covers: '' },
      ],
    });
    const tried = r.sourceResults.map((x) => x.source);
    expect(tried).toContain('国家');
    expect(tried).toContain('吉林');
    expect(tried).not.toContain('上海');
  });
});

// ============================================================================
describe('BuiltinCatalogFetcher 内置基线', () => {
  const fetcher = new BuiltinCatalogFetcher();

  it('能返回内置政策', async () => {
    const got = await fetcher.fetch({
      key: 'c',
      name: '国家税务总局 政策文件',
      jurisdiction: 'CN-GENERAL',
      url: '',
      covers: '',
    });
    expect(got.length).toBeGreaterThan(0);
  });

  it('★ 内置政策必须带正文原文（限定条件在里面）', async () => {
    const got = await fetcher.fetch({
      key: 'c',
      name: '国家税务总局 政策文件',
      jurisdiction: 'CN-GENERAL',
      url: '',
      covers: '',
    });
    for (const it of got) {
      expect(it.content.length, `${it.title} 正文过短`).toBeGreaterThan(30);
      expect(it.sourceUrl).toContain('gov.cn');
    }
  });

  it('★ 小微三项条件在内置政策正文里可被摘出', async () => {
    const got = await fetcher.fetch({
      key: 'c',
      name: '国家税务总局 政策文件',
      jurisdiction: 'CN-GENERAL',
      url: '',
      covers: '',
    });
    const all = got.map((i) => extractConditions(i.content).join(' ')).join(' ');
    expect(all).toContain('300人');
    expect(all).toContain('5000万元');
  });
});
