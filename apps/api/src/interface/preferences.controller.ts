/**
 * 界面偏好接口
 * ============================================================
 * GET    /api/preferences/theme?entityId=   读取主题偏好 + 五行分布分析
 * PATCH  /api/preferences/theme             局部更新（只提交改动的色）
 * POST   /api/preferences/theme/reset       恢复默认
 * GET    /api/preferences/theme/tokens      令牌元数据（设置页据此分组渲染）
 *
 * 前端启动时拉一次并把颜色写进 :root 的 CSS 变量，
 * 从而做到"改一次、全局生效、下次打开还在"。
 */
import { Body, Controller, Get, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PreferencesService } from '../application/preferences/preferences.service';
import {
  CHART_SUMMARY,
  ELEMENT_HUE_RANGE,
  ELEMENT_LABEL,
  ELEMENT_ROLE,
  TOKEN_META,
  DEFAULT_THEME_SETTINGS,
  type ThemeSettingsPatch,
} from '../domain/preferences/theme.model';

@ApiTags('界面偏好')
@Controller('preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get('theme')
  @ApiOperation({
    summary: '读取主题偏好（含五行分布分析）',
    description:
      '优先取主体级配置，未命中回落到全局默认，都没有则用内置默认。' +
      '内置默认依八字喜用而定：木为用神、火为喜神、忌神水金。',
  })
  async getTheme(@Query('entityId') entityId?: string) {
    return this.preferences.describeTheme(entityId);
  }

  @Get('theme/tokens')
  @ApiOperation({
    summary: '令牌元数据（设置页按五行分组渲染用）',
    description:
      '每个令牌都标了五行归属与喜忌角色，让"改配色"这件事有据可依，而不是随便挑色。',
  })
  tokens() {
    return {
      tokens: TOKEN_META,
      elements: ELEMENT_LABEL,
      roles: ELEMENT_ROLE,
      defaults: DEFAULT_THEME_SETTINGS,
      // ★ 调色方向由 ELEMENT_ROLE 推导，不在这里硬写 ——
      //   否则改了喜用之后，界面会继续按旧五行给建议。
      hueRanges: ELEMENT_HUE_RANGE,
      chart: CHART_SUMMARY,
      guidance: {
        用神: `木 —— 丙火生腊月，天寒地冻非木不生。主色系应占最多令牌（${ELEMENT_HUE_RANGE.WOOD}）`,
        喜神: `火 —— 木生火、火暖局，日主得助。辅色系次之（${ELEMENT_HUE_RANGE.FIRE}）`,
        闲神: `土 —— 火生土而泄火之力，仅作点缀与中性偏暖（${ELEMENT_HUE_RANGE.EARTH}）`,
        忌神: `水、金 —— 水克火且冬水本旺，金生水而助寒。应避免黑、深蓝、冷银（${ELEMENT_HUE_RANGE.WATER}）`,
      },
    };
  }

  @Patch('theme')
  @ApiOperation({
    summary: '局部更新主题偏好',
    description:
      '只覆盖显式传入的字段。例如只想改主色，提交 {"colors":{"wood500":"#376754"}} 即可，' +
      '其余保持原值。色值需为 #RGB 或 #RRGGBB。',
  })
  async updateTheme(
    @Body() body: ThemeSettingsPatch & { entityId?: string | null; userId?: string },
  ) {
    const { entityId, userId, ...patch } = body;
    const result = await this.preferences.updateTheme({
      patch: patch as ThemeSettingsPatch,
      entityId: entityId ?? null,
      userId,
    });
    const analysis = (await this.preferences.describeTheme(entityId ?? undefined)).analysis;
    return { ...result, analysis };
  }

  @Post('theme/reset')
  @ApiOperation({ summary: '恢复默认主题（依八字喜用的内置色板）' })
  async resetTheme(@Body() body: { entityId?: string | null; userId?: string }) {
    const settings = await this.preferences.resetTheme({
      entityId: body?.entityId ?? null,
      userId: body?.userId,
    });
    const analysis = (await this.preferences.describeTheme(body?.entityId ?? undefined)).analysis;
    return { settings, analysis };
  }
}
