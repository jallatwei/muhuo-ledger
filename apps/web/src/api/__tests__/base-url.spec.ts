/**
 * API 基地址解析测试
 * ============================================================
 * ★ 这组测试守的是一个**只在生产镜像里出现**的 bug。
 *
 *   前端曾经写成：
 *     const baseURL = import.meta.env.VITE_API_BASE_URL ?? '/api';
 *   Docker 构建时把该变量显式定义成空字符串，`'' ?? '/api'` 得到 `''`，
 *   于是 axios 的 baseURL 是空串、所有请求丢掉 /api 前缀：
 *     实际 POST /auth/login → nginx 405，界面显示"无法连接到后端服务"
 *
 *   而开发态变量是 undefined，`??` 正常回退 → 本地怎么点都是好的。
 *   也就是说：**"本地跑通了"这件事完全无法证明它是对的**，
 *   必须有断言守着。下面第一条用例就是这个回归。
 */
import { describe, expect, it } from 'vitest';

import { resolveApiBaseUrl } from '../base-url';

describe('resolveApiBaseUrl', () => {
  it('★ 空字符串必须回退到 /api（生产镜像里就是空串，用 ?? 会坏）', () => {
    // 这条如果失败，说明又改回 ?? 了 —— 生产登录会 405
    expect(resolveApiBaseUrl('')).toBe('/api');
  });

  it('未设置（undefined）回退到 /api', () => {
    expect(resolveApiBaseUrl(undefined)).toBe('/api');
  });

  it('null 回退到 /api', () => {
    expect(resolveApiBaseUrl(null)).toBe('/api');
  });

  it('只有空白字符也算没给', () => {
    expect(resolveApiBaseUrl('   ')).toBe('/api');
  });

  it('给了值就原样用（把前端单独部署到别的域名的场景）', () => {
    expect(resolveApiBaseUrl('https://api.example.com/api')).toBe('https://api.example.com/api');
  });

  it('去掉结尾多余的斜杠，避免拼出 //auth/login', () => {
    expect(resolveApiBaseUrl('https://api.example.com/api/')).toBe('https://api.example.com/api');
    expect(resolveApiBaseUrl('https://api.example.com/api///')).toBe('https://api.example.com/api');
    expect(resolveApiBaseUrl('/api/')).toBe('/api');
  });

  it('两侧空白会被去掉（环境变量里常带进来）', () => {
    expect(resolveApiBaseUrl('  /api  ')).toBe('/api');
  });
});
