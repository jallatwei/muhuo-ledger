<script setup lang="ts">
/**
 * 聚宝盆（招财纹样）
 * ============================================================
 * 取传统"聚宝盆"的图式 —— 盆中涌出铜钱、元宝、宝珠，缠枝环绕、祥云覆顶。
 * 这是中式招财纹样里最经典的一组，比单画一枚铜钱更有"聚"的意思，
 * 也好撑起一块竖长的区域（盆在下、宝气向上发散）。
 *
 * ★ 它是**暗纹（水印）**，不是插图：
 *   整幅只用一种颜色、以很低的透明度压在表单之下，笔画细、对比弱。
 *   目的只是让右半边的白底不至于空得发飘 ——
 *   所以宁可画淡一点，也不要让它跟表单抢注意力。
 *   一旦你能一眼看出"盆里装的是什么"，就说明画重了。
 *
 * ★ 颜色是可覆盖的：
 *   默认取 --bk-pattern-fill（深木绿），使用方可以传 --bk-pattern-fill
 *   换色调；因为走 currentColor，主题切换时整幅纹样跟着变。
 *
 * 所有线条路径都写在下面这一处，没有第二个副本 ——
 * 这类装饰最容易出现的维护问题就是"改了左边忘了右边"。
 */

/**
 * 铜钱的位置与倾角。
 *
 * 手写坐标而不是让 v-for 按公式排 —— 招财纹样讲"错落有致"，
 * 严格等距、等角的排列会立刻显出现代 UI 的机械感。
 * 这几个点是从盆口向上手工摆的：越往上越小、越稀。
 */
const COINS = [
  { x: 160, y: 344, r: -8 },
  { x: 128, y: 322, r: 14 },
  { x: 194, y: 318, r: -20 },
  { x: 160, y: 296, r: 6 },
  { x: 108, y: 292, r: -12 },
  { x: 214, y: 284, r: 18 },
  { x: 152, y: 260, r: -4 },
  { x: 186, y: 246, r: 22 },
  { x: 122, y: 240, r: 10 },
];
</script>

<template>
  <svg
    class="treasure"
    viewBox="0 0 320 520"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <defs>
      <!-- 上下淡出：纹样从中间"浮现"，不留一条水平的硬边 -->
      <linearGradient id="bkTreasureFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#fff" stop-opacity="0.15" />
        <stop offset="22%" stop-color="#fff" stop-opacity="1" />
        <stop offset="78%" stop-color="#fff" stop-opacity="1" />
        <stop offset="100%" stop-color="#fff" stop-opacity="0.2" />
      </linearGradient>
      <mask id="bkTreasureMask">
        <rect x="0" y="0" width="320" height="520" fill="url(#bkTreasureFade)" />
      </mask>
    </defs>

    <g
      mask="url(#bkTreasureMask)"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <!-- ══════════ 盆（主体，居中偏下）══════════ -->
      <g>
        <!-- 盆口：一道外撇的弧 -->
        <path d="M92 372c0 12 30 20 68 20s68-8 68-20" />
        <!-- 盆身：上宽下收 -->
        <path d="M96 374c4 38 20 58 64 58s60-20 64-58" />
        <!-- 盆底圈足 -->
        <path d="M128 432h64" />
        <path d="M136 438h48" opacity="0.7" />
        <!-- 盆身弦纹两道（器物的分层） -->
        <path d="M100 396h120" opacity="0.45" />
        <path d="M112 418h96" opacity="0.3" />
        <!-- 盆沿双线 -->
        <path d="M88 368c0 14 32 24 72 24s72-10 72-24" opacity="0.8" />
      </g>

      <!-- ══════════ 盆中宝气：元宝 + 宝珠 ══════════ -->
      <g>
        <!-- 中央大元宝：两端翘起，中间束腰 -->
        <path d="M132 340c-6-10 0-18 10-18h36c10 0 16 8 10 18" />
        <path d="M132 340c8 8 20 12 28 12s20-4 28-12" />
        <path d="M142 322c4-6 9-9 18-9s14 3 18 9" opacity="0.7" />
        <!-- 左右小元宝，错开高度 -->
        <path d="M84 352c-4-7 0-12 7-12h22c7 0 11 5 7 12" opacity="0.75" />
        <path d="M84 352c5 6 12 8 18 8s13-2 18-8" opacity="0.75" />
        <path d="M204 348c-4-7 0-12 7-12h22c7 0 11 5 7 12" opacity="0.75" />
        <path d="M204 348c5 6 12 8 18 8s13-2 18-8" opacity="0.75" />
        <!-- 宝珠三颗，越往上越小（宝气上升的层次） -->
        <circle cx="160" cy="290" r="10" />
        <circle cx="122" cy="304" r="6" opacity="0.8" />
        <circle cx="198" cy="300" r="7" opacity="0.8" />
        <circle cx="160" cy="262" r="5" opacity="0.6" />
      </g>

      <!-- ══════════ 铜钱：一串自盆中涌出 ══════════ -->
      <g opacity="0.85">
        <!-- 外圆内方：每枚钱都是「圆 + 方孔」 -->
        <g v-for="(c, i) in COINS" :key="i" :transform="`translate(${c.x} ${c.y}) rotate(${c.r})`">
          <circle cx="0" cy="0" r="13" />
          <rect x="-4.5" y="-4.5" width="9" height="9" />
        </g>
      </g>

      <!-- ══════════ 缠枝：自盆沿向两侧生出 ══════════ -->
      <g opacity="0.6">
        <path d="M96 380c-22 6-38 22-44 46" />
        <path d="M224 380c22 6 38 22 44 46" />
        <!-- 枝上小叶 -->
        <path d="M74 402c-9-3-15 1-17 9 9 3 15-1 17-9Z" />
        <path d="M246 402c9-3 15 1 17 9-9 3-15-1-17-9Z" />
        <path d="M62 424c-8-2-13 2-14 9 8 2 13-2 14-9Z" opacity="0.8" />
        <path d="M258 424c8-2 13 2 14 9-8 2-13-2-14-9Z" opacity="0.8" />
      </g>

      <!-- ══════════ 覆顶祥云 ══════════ -->
      <g opacity="0.55">
        <path d="M104 224c0-11 9-19 19-19 3-11 13-19 24-19 10 0 19 7 22 16 11 2 19 11 19 22" />
        <path d="M188 238c0-8 6-14 14-14 2-8 10-14 18-14 8 0 15 5 17 12 8 2 14 9 14 16" />
        <path d="M40 250c0-8 6-14 14-14 2-8 10-14 18-14 8 0 15 5 17 12 8 2 14 9 14 16" opacity="0.8" />
        <!-- 云脚 -->
        <path d="M96 250h38" opacity="0.5" />
        <path d="M180 268h44" opacity="0.45" />
        <path d="M32 276h40" opacity="0.4" />
      </g>

      <!-- ══════════ 地面：一道极淡的基座线，让盆"落"在实处 ══════════ -->
      <path d="M60 452h200" opacity="0.22" />
      <path d="M92 460h136" opacity="0.14" />
    </g>
  </svg>
</template>


<style scoped>
.treasure {
  width: 320px;
  height: 520px;
  color: var(--bk-pattern-fill, var(--bk-wood-700, #223f33));
  pointer-events: none;
  user-select: none;
}
</style>
