<script setup lang="ts">
/**
 * 古建筑仰视（飞檐转角 · 线稿暗纹）
 * ============================================================
 * 照参考照片（低角度拍檐角）描成线稿。照片里最抓人的四处，按重要性依次落笔：
 *
 *   ① **檐口那道长长的弧** —— 从左下起、向右上扬起，是整个画面的骨架。
 *      45° 仰视的全部证据就在这条弧上：平视立面图的檐口是一条直线。
 *   ② **一圈勾头瓦当** —— 沿檐口排开的小圆（照片里最醒目的重复元素），
 *      尺寸从左向右递减，靠透视交代"檐口正在远离"。
 *   ③ **转角处的脊饰（脊兽）** —— 照片正中的那个小兽，
 *      线稿里用一个小形加两笔卷云暗示，不画细节（这个尺寸下细节会糊成一团）。
 *   ④ **两层檐** —— 近处的前檐 + 后面退一层、更高更小的远檐，
 *      重叠出"一层压一层"的进深，这是照片里最有分量的东西。
 *
 * 檐下沿深度依次是：飞椽（短竖线）→ 斗拱（十字形）→ 额枋（横带 + 画板分段）→ 柱身。
 * 越远的元素越淡、越短，靠这三档差别撑开空间。
 *
 * ★ 整体斜置 12°（作用在 svg 上的 CSS transform）：
 *   照片的檐口天然是斜的，摆正反而失掉动势。
 *
 * ★ 颜色走 currentColor（默认 --bk-on-dark-wood），换主色时整幅跟着变。
 */
</script>

<template>
  <svg
    class="corner-eave"
    viewBox="0 0 680 480"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    preserveAspectRatio="xMidYMin meet"
    aria-hidden="true"
  >
    <g stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <!-- ══════════════ ① 后檐（远、更小更高）══════════════ -->
      <path d="M348 132C432 160 546 196 664 230" stroke-width="1.4" opacity="0.5" />
      <path d="M662 232c8 0 15-3 19-9" stroke-width="1.3" opacity="0.5" />
      <!-- 后檐的瓦当：同样沿弧排开，半径更小 -->
      <g stroke-width="1.1" opacity="0.42">
        <circle cx="350" cy="128" r="6" />
        <circle cx="402" cy="142" r="5.6" />
        <circle cx="454" cy="156" r="5.2" />
        <circle cx="506" cy="170" r="4.8" />
        <circle cx="558" cy="186" r="4.4" />
        <circle cx="610" cy="200" r="4" />
      </g>
      <!-- 后檐的垂脊，向后上方退去 -->
      <path d="M470 62C498 84 530 112 566 150" stroke-width="1.3" opacity="0.42" />

      <!-- ══════════════ ② 正脊与脊饰 ══════════════ -->
      <path d="M182 60h250" stroke-width="2.2" />
      <path d="M182 68h250" stroke-width="1.1" opacity="0.5" />
      <!-- 脊饰：一个小形 + 两笔卷云 + 一撮尖须 -->
      <path d="M298 44c7 6 11 12 11 19h-22c0-7 4-13 11-19Z" stroke-width="1.6" />
      <path d="M287 40c-5-4-7-9-6-14 5 3 8 8 8 13" stroke-width="1.4" />
      <path d="M312 40c5-4 7-9 6-14-5 3-8 8-8 13" stroke-width="1.4" />
      <path d="M307 28c-3-7-2-13 2-18 3 6 3 12-2 18Z" stroke-width="1.2" opacity="0.85" />

      <!-- ══════════════ ③ 前檐：主体弧线 ══════════════ -->
      <!-- 上沿（檐口）—— 整幅画的骨架 -->
      <path d="M18 256C184 306 436 292 638 200" stroke-width="2.6" />
      <!-- 下沿：檐口厚度。仰视时这条更"厚"，压出檐板的体积 -->
      <path d="M30 272C190 320 432 306 630 216" stroke-width="1.2" opacity="0.5" />

      <!-- 左端起翘（照片里向左下伸出的翼角） -->
      <path d="M18 256c-14 1-24-6-30-17" stroke-width="2.1" />
      <path d="M-12 239c-4-7-6-13-5-18" stroke-width="1.5" opacity="0.85" />
      <!-- 右端起翘（上扬，最尖） -->
      <path d="M638 200c11-3 19-10 23-20" stroke-width="2.1" />
      <path d="M661 180c4-9 5-17 3-23" stroke-width="1.5" />

      <!-- 前檐的垂脊：自正脊向右下张开，末端与檐口相接 -->
      <path d="M276 68C364 92 480 132 588 184" stroke-width="1.8" />
      <!-- 瓦垄（只两条，多了会糊） -->
      <path d="M362 96C430 128 512 164 580 196" stroke-width="1" opacity="0.28" />
      <path d="M470 140c26 14 54 30 82 44" stroke-width="1" opacity="0.28" />

      <!-- ══════════════ ④ 勾头瓦当：沿檐口一圈小圆 ══════════════ -->
      <!-- 半径自左向右递减 —— 靠尺寸差交代檐口正在远离 -->
      <g stroke-width="1.4">
        <circle cx="30" cy="262" r="10" />
        <circle cx="90" cy="278" r="9.5" />
        <circle cx="150" cy="290" r="9" />
        <circle cx="210" cy="297" r="8.5" />
        <circle cx="270" cy="300" r="8" />
        <circle cx="330" cy="297" r="7.6" />
        <circle cx="390" cy="289" r="7.2" />
        <circle cx="450" cy="277" r="6.8" />
        <circle cx="510" cy="262" r="6.4" />
        <circle cx="570" cy="244" r="6" />
        <circle cx="626" cy="222" r="5.6" />
      </g>

      <!-- ══════════════ ⑤ 檐下：飞椽 → 斗拱 → 额枋 → 柱 ══════════════ -->
      <!-- 飞椽：自下沿垂下的短竖线，长度随弧线变化 -->
      <g stroke-width="1.2" opacity="0.5">
        <path d="M48 280v26" />
        <path d="M108 295v28" />
        <path d="M168 306v30" />
        <path d="M228 312v31" />
        <path d="M288 315v32" />
        <path d="M348 313v32" />
        <path d="M408 306v31" />
        <path d="M468 295v30" />
        <path d="M528 281v28" />
        <path d="M588 264v26" />
      </g>

      <!-- 前檐斗拱：十字形（横伸的拱臂 + 上下两道斗 + 竖柱），随檐口弧线上抬 -->
      <g stroke-width="1.4" opacity="0.8">
        <path d="M96 300h30M172 324h30M248 340h30M324 348h30M400 340h30M476 322h30M552 296h30" />
        <path d="M104 306h14M180 330h14M256 346h14M332 354h14M408 346h14M484 328h14M560 302h14" opacity="0.7" />
        <path d="M104 334h14M180 358h14M256 374h14M332 382h14M408 374h14M484 356h14M560 330h14" opacity="0.7" />
        <path d="M111 306v28M187 330v28M263 346v28M339 354v28M415 346v28M491 328v28M567 302v28" opacity="0.6" />
      </g>

      <!-- 额枋：一条随檐口起伏的横带 + 带上的画板分段 -->
      <path d="M22 388C196 418 452 400 646 330" stroke-width="2" opacity="0.7" />
      <path d="M22 400C196 430 452 412 646 342" stroke-width="1.2" opacity="0.4" />
      <g stroke-width="1.2" opacity="0.45">
        <path d="M96 392v16M170 398v16M244 403v15M318 406v14M392 403v14M466 398v15M540 380v15" />
      </g>

      <!-- 柱身：仰视下被压短，越往右（越远）越短 -->
      <g stroke-width="2.4" opacity="0.6">
        <path d="M60 396v62" />
        <path d="M206 404v58" />
        <path d="M352 410v54" />
        <path d="M498 396v52" />
      </g>
      <g stroke-width="1.6" opacity="0.3">
        <path d="M132 400v58" />
        <path d="M278 407v55" />
        <path d="M424 404v53" />
        <path d="M570 388v50" />
      </g>

      <!-- 台基 -->
      <path d="M0 462h680" stroke-width="1.6" opacity="0.35" />
      <path d="M20 472h640" stroke-width="1.1" opacity="0.2" />
    </g>
  </svg>
</template>

<style scoped>
.corner-eave {
  width: 100%;
  height: 100%;
  /* ★ 8° 斜置：照片里的檐口天然是斜的，摆正反而失掉动势。
     角度不能大 —— 旋转会把四角带出空白并推高有效高度，
     12° 时下半部分（斗拱、柱、台基）会被挤出容器，只剩一条檐线。
     缩放交给父容器（在这里放 scale 会改变宽度基准，尺寸不好控）。 */
  transform: rotate(-8deg);
  color: var(--bk-on-dark-wood, #5ea186);
  pointer-events: none;
  user-select: none;
}
</style>
