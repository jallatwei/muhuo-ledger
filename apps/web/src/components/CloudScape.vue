<script setup lang="ts">
/**
 * 山与祥云（品牌区底部的装饰纹样）
 * ============================================================
 * 取传统界画的意象：远山、流云。全是装饰，不承载任何信息，
 * 所以固定 aria-hidden，且透明度压得很低 ——
 * 它要的是"这块深色有东西在托着"，而不是让人盯着看。
 *
 * 三层叠出进深：
 *   · 后层远山轮廓（极淡描线，海拔高一点）
 *   · 中层远山（更淡，只留一道起伏）
 *   · 前层祥云（2px 描线，勾出云头与云脚）
 *
 * 颜色全部走 --bk-on-dark-wood（跟随主色实时推导），
 * 所以在外观偏好里换了主色，这片山云也跟着换色。
 */
</script>

<template>
  <svg
    class="cloudscape"
    viewBox="0 0 480 130"
    preserveAspectRatio="none"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <defs>
      <!-- 左浓右淡，让纹样自然融进右侧的空白，不留一条硬边 -->
      <linearGradient id="bkCloudFade" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#fff" stop-opacity="1" />
        <stop offset="55%" stop-color="#fff" stop-opacity="0.55" />
        <stop offset="100%" stop-color="#fff" stop-opacity="0.08" />
      </linearGradient>
      <mask id="bkCloudMask">
        <rect x="0" y="0" width="480" height="130" fill="url(#bkCloudFade)" />
      </mask>
    </defs>

    <g mask="url(#bkCloudMask)" stroke-linecap="round" stroke-linejoin="round">
      <!-- 后层远山 -->
      <path
        d="M-10 96 L58 46 L112 84 L168 34 L236 92 L296 52 L356 88 L420 44 L490 92"
        stroke="currentColor"
        stroke-width="1"
        opacity="0.16"
      />
      <!-- 中层远山 -->
      <path
        d="M-10 110 L46 78 L104 104 L152 70 L214 106 L272 80 L330 104 L386 76 L448 106 L490 92"
        stroke="currentColor"
        stroke-width="1"
        opacity="0.1"
      />

      <!-- 前层祥云：三朵，大小错落，避免等距排列的机械感 -->
      <g stroke="currentColor" stroke-width="2" opacity="0.3">
        <!-- 左：主云，云头三卷 + 云脚一道长尾 -->
        <path d="M12 122c0-9 7-15 15-15 2-9 10-15 19-15 8 0 15 5 18 13 9 1 15 8 15 17" />
        <path d="M6 122c0-13 9-22 21-22" opacity="0.7" />
        <path d="M79 122h58" opacity="0.55" />
        <!-- 中：小云 -->
        <path d="M158 122c0-7 6-12 12-12 2-7 8-12 15-12 6 0 12 4 14 10 7 1 12 7 12 14" />
        <path d="M211 122h44" opacity="0.55" />
        <!-- 右：云尾，收得最淡 -->
        <path d="M282 122c0-6 5-10 10-10 2-6 7-10 13-10 5 0 10 3 12 8 6 1 10 6 10 12" opacity="0.8" />
        <path d="M327 122h36" opacity="0.4" />
      </g>
    </g>
  </svg>
</template>

<style scoped>
.cloudscape {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  height: 130px;
  color: var(--bk-on-dark-wood, #5ea186);
  pointer-events: none;
}
</style>
