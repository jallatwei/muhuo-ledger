/**
 * 界面偏好服务
 * ============================================================
 * 把 UI 偏好存进 SystemConfig 表，实现**跨会话、跨设备生效**的全局喜好。
 *
 * 两条读取规则：
 *   ① 先查主体级配置（entityId = 当前主体），命中即用
 *   ② 未命中则回落到全局默认（entityId = null）
 *   ③ 都没有则用代码内置默认（依八字喜用）
 *
 * 为什么主体级优先：一个账号可能管多个主体，
 * 但"界面长什么样"是人的偏好而不是账套的属性 —— 所以主体级只是可选覆盖，
 * 真正的默认值放在全局（entityId = null）。
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../infrastructure/prisma/audit.service';
import {
  CHART_SUMMARY,
  DEFAULT_THEME_SETTINGS,
  ELEMENT_LABEL,
  ELEMENT_ROLE,
  FAVORABLE_ELEMENTS,
  FAVORABLE_LABEL,
  UNFAVORABLE_LABEL,
  analyzeElementBalance,
  mergeThemeSettings,
  normalizeThemeSettings,
  themeSettingsSchema,
  type ThemeSettings,
  type ThemeSettingsPatch,
} from '../../domain/preferences/theme.model';

/** SystemConfig 里存主题的 key */
const THEME_KEY = 'ui.theme';

@Injectable()
export class PreferencesService {
  private readonly logger = new Logger(PreferencesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 读取主题偏好。
   * @param entityId 传了就优先取主体级配置
   */
  async getTheme(entityId?: string): Promise<{
    settings: ThemeSettings;
    source: 'ENTITY' | 'GLOBAL' | 'DEFAULT';
    entityId: string | null;
  }> {
    // 主体级
    if (entityId) {
      const row = await this.prisma.systemConfig.findUnique({
        where: { entityId_key: { entityId, key: THEME_KEY } },
      });
      if (row) {
        return { settings: normalizeThemeSettings(row.value), source: 'ENTITY', entityId };
      }
    }

    // 全局
    const global = await this.prisma.systemConfig.findFirst({
      where: { entityId: null, key: THEME_KEY },
      orderBy: { updatedAt: 'desc' },
    });
    if (global) {
      return { settings: normalizeThemeSettings(global.value), source: 'GLOBAL', entityId: null };
    }

    return {
      settings: { ...DEFAULT_THEME_SETTINGS, colors: { ...DEFAULT_THEME_SETTINGS.colors } },
      source: 'DEFAULT',
      entityId: null,
    };
  }

  /**
   * 更新主题偏好（局部更新，只覆盖显式传入的字段）。
   * @param entityId 传 null 表示写全局默认
   */
  async updateTheme(params: {
    patch: ThemeSettingsPatch;
    entityId?: string | null;
    userId?: string;
  }): Promise<{ settings: ThemeSettings; source: 'ENTITY' | 'GLOBAL' }> {
    const { patch, userId } = params;
    const entityId = params.entityId ?? null;

    // 校验补丁
    const parsed = themeSettingsSchema.parse(patch);

    const current = await this.getTheme(entityId ?? undefined);
    const merged = mergeThemeSettings(current.settings, parsed);

    // ★ 全局配置（entityId = null）不能走 upsert：
    //   Prisma 的复合唯一键 where 要求 entityId 是 string，传 null 会直接报错；
    //   而且 PostgreSQL 里 NULL 互不相等，@@unique([entityId, key]) 也拦不住重复行。
    //   所以全局配置用 findFirst + update/create，并在写入前清理历史重复行。
    await this.writeConfig(entityId, merged);

    await this.audit.record({
      entityId: entityId ?? undefined,
      userId,
      action: 'CONFIG',
      subjectType: 'SystemConfig',
      subjectId: THEME_KEY,
      beforeData: { colors: current.settings.colors },
      afterData: { colors: merged.colors },
      reason: '更新界面主题偏好',
    });

    this.logger.log(
      `主题偏好已更新（${entityId ? `主体 ${entityId}` : '全局'}）：` +
        `主色 ${merged.colors.fire500}，来源 ${current.source}`,
    );

    return { settings: merged, source: entityId ? 'ENTITY' : 'GLOBAL' };
  }

  /**
   * 写入配置。
   *
   * 主体级（entityId 非空）可以用 upsert，复合唯一键有效。
   * 全局级（entityId 为 null）必须用 findFirst + update/create：
   *   · Prisma 复合唯一键的 where 不接受 null
   *   · PostgreSQL 中 NULL 互不相等，唯一索引拦不住重复，需应用层去重
   */
  private async writeConfig(entityId: string | null, settings: ThemeSettings): Promise<void> {
    const remark = '界面主题偏好（依八字喜用：火为用、土为喜）';

    if (entityId) {
      await this.prisma.systemConfig.upsert({
        where: { entityId_key: { entityId, key: THEME_KEY } },
        create: { entityId, key: THEME_KEY, value: settings as never, remark },
        update: { value: settings as never },
      });
      return;
    }

    const rows = await this.prisma.systemConfig.findMany({
      where: { entityId: null, key: THEME_KEY },
      orderBy: { updatedAt: 'desc' },
    });

    if (rows.length === 0) {
      await this.prisma.systemConfig.create({
        data: { entityId: null, key: THEME_KEY, value: settings as never, remark },
      });
      return;
    }

    // 保留最新一条，其余（历史重复）删掉，避免读取时歧义
    const [keep, ...duplicates] = rows;
    if (duplicates.length > 0) {
      this.logger.warn(`发现 ${duplicates.length} 条重复的全局主题配置，已清理`);
      await this.prisma.systemConfig.deleteMany({
        where: { id: { in: duplicates.map((r) => r.id) } },
      });
    }

    await this.prisma.systemConfig.update({
      where: { id: keep!.id },
      data: { value: settings as never, remark },
    });
  }

  /** 恢复默认（依八字喜用的内置色板） */
  async resetTheme(params: {
    entityId?: string | null;
    userId?: string;
  }): Promise<ThemeSettings> {
    const entityId = params.entityId ?? null;

    if (entityId) {
      // 只删主体级覆盖，回落到全局/默认
      await this.prisma.systemConfig.deleteMany({ where: { entityId, key: THEME_KEY } });
      const after = await this.getTheme(entityId);
      return after.settings;
    }

    // 删全局，回到代码内置默认
    await this.prisma.systemConfig.deleteMany({ where: { entityId: null, key: THEME_KEY } });

    await this.audit.record({
      userId: params.userId,
      action: 'CONFIG',
      subjectType: 'SystemConfig',
      subjectId: THEME_KEY,
      reason: '恢复默认主题',
    });

    return { ...DEFAULT_THEME_SETTINGS, colors: { ...DEFAULT_THEME_SETTINGS.colors } };
  }

  /**
   * 主题总览：当前配置 + 五行分布分析。
   *
   * 五行分析不是装饰 —— 它把"这套配色是否仍合于喜用"变成一个可检查的量化结论：
   * 喜用（木火）令牌占比过低、或出现忌神（水金）色，都会被指出来。
   *
   * ★ 文案里的五行一律由 ELEMENT_ROLE 推导。硬写"火土"的话，
   *   将来改喜用就必然漏掉这里，界面会继续按旧五行给建议。
   */
  async describeTheme(entityId?: string) {
    const { settings, source } = await this.getTheme(entityId);
    const analysis = analyzeElementBalance(settings);

    return {
      settings,
      source,
      analysis,
      chart: CHART_SUMMARY,
      note:
        `配色依八字喜用而定（${FAVORABLE_ELEMENTS.map((e) => `${ELEMENT_LABEL[e]}为${ELEMENT_ROLE[e]}`).join('、')}；` +
        `忌${UNFAVORABLE_LABEL}）。` +
        `调整时建议加强${FAVORABLE_LABEL}、避免${UNFAVORABLE_LABEL}；` +
        '承载文字的色请保持对白对比度 ≥ 4.5（AA）。',
    };
  }
}
