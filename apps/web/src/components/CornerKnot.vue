<script setup lang="ts">
/**
 * 回纹角饰
 * ============================================================
 * 回纹（雷纹 / 云雷纹）是青铜器与家具上最常见的边框纹样 ——
 * 一个方框绕着另一个方框，回环不断，取"绵长不绝"的意思。
 * 放在表单区四角，给白底页面一点中式的骨架感，
 * 又不像满框花纹那样抢表单的注意力。
 *
 * 只画**左上角**一次，另外三角用 CSS 的 rotate 镜像出来 ——
 * 四个角各写一份 path 是四倍的维护面，且很容易改一处漏三处。
 *
 * 颜色走 currentColor，由使用方决定（默认取主色）。
 */
</script>

<template>
  <svg
    class="corner"
    viewBox="0 0 44 44"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <g
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="square"
      stroke-linejoin="miter"
    >
      <!-- 外层方框的内折 -->
      <path d="M43 1H1v42" />
      <!-- 中层回环 -->
      <path d="M12 12h20v20h-8V20h-8v4h4" />
      <!-- 内层收头 -->
      <path d="M8 8v28h28" opacity="0.5" />
    </g>
  </svg>
</template>

<style scoped>
.corner {
  width: 34px;
  height: 34px;
  color: var(--bk-wood-300, #a3c8b9);
  pointer-events: none;
}
</style>
