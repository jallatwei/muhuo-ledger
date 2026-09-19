/**
 * 出生地经度表
 * ============================================================
 * 只收录到**地级市**，而不是全国区县。
 *
 * 为什么粒度到此为止：
 *   真太阳时的经度修正按 4 分钟/度算，同一个地级市范围内的经度差
 *   通常不足 0.5 度，也就是修正量相差不到 2 分钟 ——
 *   对定时辰（一个时辰 120 分钟）几乎没有影响。
 *   再往下精确到街道，是把精力花在了不影响结论的位数上。
 *
 * ★ 真要精确到分钟的人，用「其它 / 手工填经纬度」自己填。
 *   那个入口必须留 —— 出生在县、乡，或者需要与别处结果逐分钟对齐时，
 *   预置表无论多长都不够用。
 *
 * 经度东经为正，纬度北纬为正。
 */
export interface CityCoord {
  /** 稳定标识，用于持久化 */
  key: string;
  name: string;
  /** 东经，度 */
  longitude: number;
  /** 北纬，度 */
  latitude: number;
  /** 所属省级行政区，便于在下拉里辨认同名城市 */
  province: string;
}

export const CHINA_CITIES: CityCoord[] = [
  // ---- 直辖市 ----
  { key: 'beijing', name: '北京市', province: '北京', longitude: 116.41, latitude: 39.9 },
  { key: 'shanghai', name: '上海市', province: '上海', longitude: 121.47, latitude: 31.23 },
  { key: 'tianjin', name: '天津市', province: '天津', longitude: 117.19, latitude: 39.13 },
  { key: 'chongqing', name: '重庆市', province: '重庆', longitude: 106.55, latitude: 29.56 },

  // ---- 东北 ----
  { key: 'shenyang', name: '沈阳市', province: '辽宁', longitude: 123.43, latitude: 41.8 },
  { key: 'dalian', name: '大连市', province: '辽宁', longitude: 121.61, latitude: 38.91 },
  { key: 'changchun', name: '长春市', province: '吉林', longitude: 125.32, latitude: 43.82 },
  { key: 'jilin', name: '吉林市', province: '吉林', longitude: 126.56, latitude: 43.84 },
  { key: 'harbin', name: '哈尔滨市', province: '黑龙江', longitude: 126.63, latitude: 45.75 },
  { key: 'qiqihar', name: '齐齐哈尔市', province: '黑龙江', longitude: 123.92, latitude: 47.35 },

  // ---- 华北 ----
  { key: 'shijiazhuang', name: '石家庄市', province: '河北', longitude: 114.51, latitude: 38.04 },
  { key: 'tangshan', name: '唐山市', province: '河北', longitude: 118.18, latitude: 39.63 },
  { key: 'taiyuan', name: '太原市', province: '山西', longitude: 112.55, latitude: 37.87 },
  { key: 'datong', name: '大同市', province: '山西', longitude: 113.3, latitude: 40.09 },
  { key: 'huhehaote', name: '呼和浩特市', province: '内蒙古', longitude: 111.75, latitude: 40.84 },
  { key: 'baotou', name: '包头市', province: '内蒙古', longitude: 109.84, latitude: 40.66 },

  // ---- 华东 ----
  { key: 'nanjing', name: '南京市', province: '江苏', longitude: 118.8, latitude: 32.06 },
  { key: 'suzhou', name: '苏州市', province: '江苏', longitude: 120.62, latitude: 31.3 },
  { key: 'wuxi', name: '无锡市', province: '江苏', longitude: 120.3, latitude: 31.57 },
  { key: 'xuzhou', name: '徐州市', province: '江苏', longitude: 117.18, latitude: 34.26 },
  { key: 'hangzhou', name: '杭州市', province: '浙江', longitude: 120.15, latitude: 30.27 },
  { key: 'ningbo', name: '宁波市', province: '浙江', longitude: 121.55, latitude: 29.87 },
  { key: 'wenzhou', name: '温州市', province: '浙江', longitude: 120.7, latitude: 28.0 },
  { key: 'hefei', name: '合肥市', province: '安徽', longitude: 117.28, latitude: 31.86 },
  { key: 'fuzhou', name: '福州市', province: '福建', longitude: 119.3, latitude: 26.08 },
  { key: 'xiamen', name: '厦门市', province: '福建', longitude: 118.09, latitude: 24.48 },
  { key: 'nanchang', name: '南昌市', province: '江西', longitude: 115.89, latitude: 28.68 },
  { key: 'jinan', name: '济南市', province: '山东', longitude: 117.0, latitude: 36.65 },
  { key: 'qingdao', name: '青岛市', province: '山东', longitude: 120.38, latitude: 36.07 },
  { key: 'yantai', name: '烟台市', province: '山东', longitude: 121.39, latitude: 37.54 },
  { key: 'weifang', name: '潍坊市', province: '山东', longitude: 119.16, latitude: 36.71 },

  // ---- 华中 ----
  { key: 'zhengzhou', name: '郑州市', province: '河南', longitude: 113.62, latitude: 34.75 },
  { key: 'luoyang', name: '洛阳市', province: '河南', longitude: 112.45, latitude: 34.62 },
  { key: 'wuhan', name: '武汉市', province: '湖北', longitude: 114.3, latitude: 30.59 },
  { key: 'yichang', name: '宜昌市', province: '湖北', longitude: 111.29, latitude: 30.69 },
  { key: 'changsha', name: '长沙市', province: '湖南', longitude: 112.94, latitude: 28.23 },
  { key: 'hengyang', name: '衡阳市', province: '湖南', longitude: 112.57, latitude: 26.89 },

  // ---- 华南 ----
  { key: 'guangzhou', name: '广州市', province: '广东', longitude: 113.26, latitude: 23.13 },
  { key: 'shenzhen', name: '深圳市', province: '广东', longitude: 114.06, latitude: 22.55 },
  { key: 'dongguan', name: '东莞市', province: '广东', longitude: 113.75, latitude: 23.02 },
  { key: 'foshan', name: '佛山市', province: '广东', longitude: 113.12, latitude: 23.02 },
  { key: 'nanning', name: '南宁市', province: '广西', longitude: 108.37, latitude: 22.82 },
  { key: 'guilin', name: '桂林市', province: '广西', longitude: 110.29, latitude: 25.27 },
  { key: 'haikou', name: '海口市', province: '海南', longitude: 110.2, latitude: 20.04 },
  { key: 'sanya', name: '三亚市', province: '海南', longitude: 109.51, latitude: 18.25 },

  // ---- 西南 ----
  { key: 'chengdu', name: '成都市', province: '四川', longitude: 104.07, latitude: 30.57 },
  { key: 'mianyang', name: '绵阳市', province: '四川', longitude: 104.68, latitude: 31.47 },
  { key: 'guiyang', name: '贵阳市', province: '贵州', longitude: 106.63, latitude: 26.65 },
  { key: 'kunming', name: '昆明市', province: '云南', longitude: 102.83, latitude: 24.88 },
  { key: 'dali', name: '大理市', province: '云南', longitude: 100.23, latitude: 25.6 },
  { key: 'lasa', name: '拉萨市', province: '西藏', longitude: 91.14, latitude: 29.65 },

  // ---- 西北 ----
  { key: 'xian', name: '西安市', province: '陕西', longitude: 108.94, latitude: 34.34 },
  { key: 'xianyang', name: '咸阳市', province: '陕西', longitude: 108.71, latitude: 34.33 },
  { key: 'lanzhou', name: '兰州市', province: '甘肃', longitude: 103.83, latitude: 36.06 },
  { key: 'xining', name: '西宁市', province: '青海', longitude: 101.78, latitude: 36.62 },
  { key: 'yinchuan', name: '银川市', province: '宁夏', longitude: 106.23, latitude: 38.49 },
  { key: 'wulumuqi', name: '乌鲁木齐市', province: '新疆', longitude: 87.62, latitude: 43.83 },
  { key: 'kashi', name: '喀什市', province: '新疆', longitude: 75.99, latitude: 39.47 },

  // ---- 港澳台 ----
  { key: 'xianggang', name: '香港', province: '香港', longitude: 114.17, latitude: 22.32 },
  { key: 'aomen', name: '澳门', province: '澳门', longitude: 113.55, latitude: 22.2 },
  { key: 'taibei', name: '台北市', province: '台湾', longitude: 121.56, latitude: 25.03 },
  { key: 'gaoxiong', name: '高雄市', province: '台湾', longitude: 120.31, latitude: 22.62 },
];

/** 按名称或省份模糊找城市（给"输入地名自动带出经纬度"用） */
export function findCities(keyword: string): CityCoord[] {
  const k = (keyword ?? '').trim();
  if (!k) return [];
  return CHINA_CITIES.filter((c) => c.name.includes(k) || c.province.includes(k));
}

/** 取城市坐标；找不到返回 null（调用方应回落到手工填经纬度） */
export function cityByKey(key: string): CityCoord | null {
  return CHINA_CITIES.find((c) => c.key === key) ?? null;
}
