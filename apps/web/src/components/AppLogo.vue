<script setup lang="ts">
/**
 * Logo —— 木火相生（低饱和商用版）
 * ============================================================
 * ★ 2026-09 按**更正后的八字**重画：
 *   此前记为「甲子日、日主甲木」，于是画成了一团火为主、木为薪。
 *   核对儒略日后日柱应为**丙寅**、日主是**丙火** —— 丙火生腊月，
 *   天寒地冻非木不生，所以木才是用神、是主角，火退为辅。
 *   构图随之颠倒：**树为主，火在根部温养**。
 *
 * 命局取象：
 *   · 外廓「土」  —— 近真灰深色底，厚重承托。不用纯黑，更不用深蓝（忌神水色）
 *   · 主干「木」  —— 低饱和松绿（用神）：树干、枝叶、地面上的生长线
 *   · 焰心「火」  —— 低饱和赤陶（喜神）：贴地的一簇小火，温养寒木而非喧宾夺主
 *   · 三点「水」  —— 极淡青灰，如实承认冬水本旺，但不给它主角位置
 *
 * 配色与 apps/web/src/styles/theme.css 同源，改色时两处一起改：
 *   wood500 = #376754   fire500 = #966a5c   earth400 = #a49c79
 *
 * ★ 文字用 APP_NAME（packages/shared/src/brand.ts），各处的产品名同源。
 *   名字里的「木火」与图形里的树+火是同一件事，不是两套说法。
 */
import { computed } from 'vue';
import { APP_NAME, APP_SUBTITLE } from '@bookkeeper/shared';

const props = withDefaults(
  defineProps<{
    /** 尺寸（px） */
    size?: number;
    /** 是否显示文字 */
    showText?: boolean;
    /** Logo 是否用在浅色背景上（浅色背景需要更深的底色） */
    onLight?: boolean;
  }>(),
  { size: 32, showText: true, onLight: false },
);

/** 底色：深色侧边栏上用略浅的中性深灰，浅底上用更深一档 */
const bgColor = computed(() => (props.onLight ? '#1b1b1d' : '#2f2f33'));
</script>

<template>
  <div class="logo">
    <svg
      :width="size"
      :height="size"
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class="logo__mark"
      role="img"
      :aria-label="APP_NAME"
    >
      <defs>
        <!-- 木：自下而上的生长感，深松绿到浅松绿 -->
        <linearGradient id="bkLogoWood" x1="24" y1="40" x2="24" y2="8" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="var(--bk-wood-600, #2d5344)" />
          <stop offset="60%" stop-color="var(--bk-wood-500, #376754)" />
          <stop offset="100%" stop-color="var(--bk-wood-400, #5ea186)" />
        </linearGradient>
        <!-- 火：贴地的一簇，低饱和赤陶到浅陶 -->
        <linearGradient id="bkLogoFire" x1="24" y1="41" x2="24" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="var(--bk-fire-500, #966a5c)" />
          <stop offset="100%" stop-color="var(--bk-fire-300, #cfbbb4)" />
        </linearGradient>
      </defs>

      <!-- 外廓：土 —— 近真灰深色，厚重承托 -->
      <rect x="2" y="2" width="44" height="44" rx="10" :fill="bgColor" />

      <!-- 子水三点：如实呈现冬水本旺，但极淡，不与木火争位 -->
      <circle cx="10.5" cy="11" r="1.3" fill="#7f98a3" opacity="0.36" />
      <circle cx="37.5" cy="11" r="1.3" fill="#7f98a3" opacity="0.36" />
      <circle cx="24" cy="6.4" r="1.1" fill="#7f98a3" opacity="0.26" />

      <!-- 木：主干（用神，全图主角）-->
      <path
        d="M24 41.5V13.5"
        stroke="url(#bkLogoWood)"
        stroke-width="2.6"
        stroke-linecap="round"
      />
      <!-- 左右两枝：一枝向上生发，一枝向外舒展 -->
      <path
        d="M24 25.5c-3.6-1.4-6.4-4-7.8-7.6"
        stroke="var(--bk-wood-500, #376754)"
        stroke-width="2"
        stroke-linecap="round"
      />
      <path
        d="M24 20.5c3.6-1.4 6.4-4 7.8-7.6"
        stroke="var(--bk-wood-500, #376754)"
        stroke-width="2"
        stroke-linecap="round"
      />
      <!-- 枝叶：三片低饱和松叶，构成树冠 -->
      <path d="M24 9.2c2.6 2.2 3.9 4.6 3.9 7.2-2.6-.7-4.3-2.1-5.2-4.2.6-1 .9-2 1.3-3Z" fill="var(--bk-wood-400, #5ea186)" />
      <path d="M15.4 16.6c3.4-.5 5.9.3 7.6 2.3-2.4 1.3-4.8 1.4-7.1.3-.3-.9-.4-1.8-.5-2.6Z" fill="var(--bk-wood-400, #5ea186)" opacity="0.9" />
      <path d="M32.6 16.6c-3.4-.5-5.9.3-7.6 2.3 2.4 1.3 4.8 1.4 7.1.3.3-.9.4-1.8.5-2.6Z" fill="var(--bk-wood-400, #5ea186)" opacity="0.9" />

      <!-- 火：喜神。贴地一簇，温养寒木 —— 不抢木的位置 -->
      <path
        d="M24 38.6c1.7 1.9 3.1 3.4 3.1 5.1 0 1.7-1.4 2.9-3.1 2.9s-3.1-1.2-3.1-2.9c0-1.7 1.4-3.2 3.1-5.1Z"
        fill="url(#bkLogoFire)"
        transform="translate(0,-7)"
      />

      <!-- 地面：土，稳稳托住树与火 -->
      <path d="M14 41.6h20" stroke="var(--bk-earth-400, #a49c79)" stroke-width="1.8" stroke-linecap="round" />
    </svg>

    <div v-if="showText" class="logo__text">
      <div class="logo__name">
        <span class="logo__name-wood">木</span><span class="logo__name-fire">火</span>{{ APP_NAME.slice(2) }}
      </div>
      <div class="logo__sub">{{ APP_SUBTITLE.split(' · ')[0] }}</div>
    </div>
  </div>
</template>

<style scoped>
.logo {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 14px 11px;
  border-bottom: 1px solid rgb(255 255 255 / 6%);
}

.logo__mark {
  flex-shrink: 0;
  /* 低饱和下不建议再发光，只用极轻的主色投影点一下 */
  filter: drop-shadow(0 1px 2px rgb(55 103 84 / 26%));
}

.logo__text {
  line-height: 1.25;
}

.logo__name {
  color: #f0f0f2;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 1.2px;
}

/* 名字里的两个五行字各取自己的色 —— 与图形、与界面主色三方一致。
   ★ 这里用 --bk-logo-wood / --bk-logo-fire 而不是 --bk-wood-400：
     后两个是写死在 theme.css 里的默认值，用户在外观偏好里改主色时不会跟着变。
     --bk-logo-* 由 preferences store 每次 apply() 写入，是唯一会跟随的地方。 */
.logo__name-wood {
  color: var(--bk-on-dark-wood, #5ea186);
}

.logo__name-fire {
  color: var(--bk-on-dark-fire, #b49288);
}

.logo__sub {
  color: var(--bk-aside-text-dim, #909098);
  font-size: 10.5px;
  margin-top: 2px;
  letter-spacing: 0.4px;
}
</style>
