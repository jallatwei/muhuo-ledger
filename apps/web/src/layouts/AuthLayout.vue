<script setup lang="ts">
/**
 * 未登录页面的外壳（登录 / 注册 / 公司注册）
 * ============================================================
 * 为什么单独做一个 shell：
 *   登录页没有「当前主体、当前期间」这些概念，套主界面外壳会立刻报错，
 *   也会让用户看到一排与自己无关的空控件。
 *   所以路由上把「未登录页」与「已登录页」分成两棵子树，
 *   各自套自己的外壳 —— 比在一个 App.vue 里到处写 v-if 清楚得多。
 *
 * ---------------------------------------------------------------------------
 * 左侧品牌区
 * ---------------------------------------------------------------------------
 * 一屏里只回答一个问题：**这是什么软件、靠不靠得住**。
 *   名字（木火账房）+ 一句话（木火相生，顺其性而理其财）+ 三条产品承诺。
 *
 * 装饰取中式的**留白与纹样**，不取内容：
 *   光晕、星点、山云纹样、钤印、回纹角饰、古建筑飞檐线稿 ——
 *   全部 aria-hidden、不承载信息。
 *
 * ★ 这里**不放实控人的八字**。
 *   配色确实是按喜用定的（主色松绿为木、辅色赤陶为火），
 *   但那是内部依据，不该出现在登录首页上：
 *   一来登录页可能被别人看到，把命盘摆在首屏是不必要的暴露；
 *   二来登录页要回答的是"这软件靠不靠得住"，不是"它按谁的八字配色"。
 *   出生信息的输入与推算在「外观偏好」页（/appearance），那里才是它该待的地方。
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppLogo from '@/components/AppLogo.vue';
import CloudScape from '@/components/CloudScape.vue';
import CornerKnot from '@/components/CornerKnot.vue';
import TreasureBowl from '@/components/TreasureBowl.vue';
import EaveLineArt from '@/components/EaveLineArt.vue';
import { APP_NAME, APP_NAME_PARTS, APP_TAGLINE, APP_SUBTITLE } from '@bookkeeper/shared';

const route = useRoute();

const title = computed(() => (route.meta.title as string | undefined) ?? '');
const subtitle = computed(() => (route.meta.subtitle as string | undefined) ?? '');

/** 品牌名逐字上色：木取主色、火取辅色，其余留白 */
function partColor(token: string | null): string {
  if (token === 'wood500') return 'var(--bk-on-dark-wood)';
  if (token === 'fire500') return 'var(--bk-on-dark-fire)';
  return '#fff';
}
</script>

<template>
  <div class="auth">
    <!-- ══════════ 品牌区 ══════════ -->
    <aside class="auth__brand">
      <!-- 装饰层：光晕 + 星点 + 山云纹样。全部 aria-hidden，不承载信息 -->
      <div class="deco deco--glow-1" aria-hidden="true"></div>
      <div class="deco deco--glow-2" aria-hidden="true"></div>
      <div class="deco deco--dots" aria-hidden="true"></div>
      <CloudScape class="brand-cloud" />

      <header class="auth__brand-top">
        <AppLogo :size="40" :show-text="false" />
        <span class="auth__brand-top-text">{{ APP_SUBTITLE }}</span>
      </header>

      <div class="auth__brand-main">
        <div class="title-row">
          <h1 class="auth__name">
            <span
              v-for="(p, i) in APP_NAME_PARTS"
              :key="i"
              :style="{ color: partColor(p.token) }"
            >{{ p.text }}</span>
          </h1>

          <!-- 钤印：把品牌名收成一方小印，中式版面上最省事的一笔 -->
          <span class="seal" aria-hidden="true">
            <span class="seal__char">木</span>
            <span class="seal__char">火</span>
          </span>
        </div>

        <p class="auth__tagline">{{ APP_TAGLINE }}</p>

        <ul class="points">
          <li>
            <b>不会记错</b>
            <span>借贷永远平衡、同一张单据绝不重复入账、已结账的账改不动</span>
          </li>
          <li>
            <b>有据可查</b>
            <span>每张凭证挂着原始单据，月末凭证册可整本打印</span>
          </li>
          <li>
            <b>口径清楚</b>
            <span>申报只出底稿，不替你做决定</span>
          </li>
        </ul>
      </div>

      <!-- 古建筑仰视飞檐线稿：填在品牌名与底部之间的深色空档里 -->
      <div class="brand-eave" aria-hidden="true">
        <EaveLineArt />
      </div>

      <footer class="auth__brand-foot">
        <span class="auth__brand-foot-line" aria-hidden="true"></span>
        <span>{{ APP_NAME }} · 配色依八字喜用而定</span>
      </footer>
    </aside>

    <!-- ══════════ 表单区 ══════════ -->
    <main class="auth__panel">
      <!-- 聚宝盆暗纹：压在表单之下的深绿招财纹样，只为让白底不至于空得发飘 -->
      <TreasureBowl class="panel-pattern" />

      <div class="auth__panel-inner">
        <!-- 回纹四角：中式边框的骨架，只是角上一点，不框满 -->
        <CornerKnot class="knot knot--tl" />
        <CornerKnot class="knot knot--tr" />
        <CornerKnot class="knot knot--bl" />
        <CornerKnot class="knot knot--br" />

        <header class="auth__head">
          <h2>{{ title }}</h2>
          <p v-if="subtitle" class="bk-hint">{{ subtitle }}</p>
        </header>

        <router-view />
      </div>
    </main>
  </div>
</template>


<style scoped>
.auth {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(380px, 520px);
  height: 100%;
  background: var(--bk-page-bg);
}

/* ── 品牌区 ───────────────────────────────────────────── */
.auth__brand {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 38px 46px 30px;
  background: var(--bk-aside-bg);
  color: var(--bk-aside-text);
  overflow: hidden;
}

/* 底部一道主色渐隐线：从木色过渡到火色再消失 */
.auth__brand::after {
  content: '';
  position: absolute;
  inset: auto 0 0 0;
  height: 2px;
  background: linear-gradient(
    90deg,
    var(--bk-wood-500) 0%,
    var(--bk-wood-400) 18%,
    var(--bk-fire-500) 42%,
    transparent 82%
  );
}

/* 装饰层 */
.deco {
  position: absolute;
  pointer-events: none;
}

.deco--glow-1 {
  top: -160px;
  left: -120px;
  width: 420px;
  height: 420px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--bk-wood-500) 22%, transparent) 0%, transparent 68%);
}

.deco--glow-2 {
  right: -140px;
  bottom: -180px;
  width: 380px;
  height: 380px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--bk-fire-500) 18%, transparent) 0%, transparent 70%);
}

/* 极淡的星点网格：让深色块有质感，不至于是一块死板的纯色 */
.deco--dots {
  inset: 0;
  background-image: radial-gradient(rgb(255 255 255 / 5%) 1px, transparent 1px);
  background-size: 22px 22px;
  mask-image: linear-gradient(160deg, #000 0%, transparent 62%);
}

/* 山云纹样贴着底边，且压在整个内容层之下 */
.brand-cloud {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 0;
}

/* 内容一律抬到装饰之上 */
.auth__brand-top,
.auth__brand-main,
.auth__brand-foot {
  position: relative;
  z-index: 1;
}

.auth__brand-top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 18px;
  border-bottom: 1px solid rgb(255 255 255 / 7%);
}

.auth__brand-top-text {
  font-size: 11.5px;
  letter-spacing: 0.6px;
  color: var(--bk-aside-text-dim);
}

.auth__brand-main {
  margin: 34px 0 18px;
}

/**
 * 古建筑线稿的位置与尺寸。
 *
 * 用 flex: 1 吃掉品牌名与底部之间的剩余高度，再自己定高 ——
 * 高屏上它会长高，矮屏上自动收窄，不需要为每个断点各写一套。
 *
 * ★ 左右都溢出 34px：线稿整体斜置 12°，旋转会把四角带出空白，
 *   只往一侧给余量的话另一边会被裁出一条直角边。
 *   父级已有 overflow: hidden，超出的部分自然裁掉。
 *
 * 透明度 0.26 —— 它是线稿不是插画。细线在近真灰深底上要淡到
 * "不盯着看看不出是一栋建筑"，才不会跟左边的文字抢注意力。
 */
.brand-eave {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  height: 300px;
  /* 左右都溢出 40px：线稿斜置后四角会带出空白，
     只往一侧给余量的话另一边会被裁出一条直角边。
     父级已有 overflow: hidden，超出的部分自然裁掉。 */
  margin: 0 -40px 2px;
  opacity: 0.26;
}

/* ── 产品名 + 钤印 ── */
.title-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 14px;
}

.auth__name {
  margin: 0;
  font-size: 40px;
  font-weight: 600;
  letter-spacing: 6px;
  line-height: 1.1;
}

/**
 * 钤印：把品牌名收成一方小印。
 *
 * 取篆刻的样子 —— 朱红方框、白文（字反白）、微微歪一点。
 * 歪 2 度是刻意的：手钤的印不会正，正了就变成印刷品。
 * 用 fire 色（赤陶）而不是正红：正红在这个低饱和色板里会跳出画面。
 */
.seal {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border: 2px solid var(--bk-on-dark-fire, #b49288);
  border-radius: 4px;
  color: var(--bk-on-dark-fire, #b49288);
  background: color-mix(in srgb, var(--bk-fire-500) 14%, transparent);
  font-family: 'STKaiti', 'KaiTi', 'STSong', 'Songti SC', 'SimSun', serif;
  font-size: 17px;
  line-height: 1;
  transform: rotate(-2deg);
  user-select: none;
}

.seal__char {
  display: block;
  transform: translateY(0.5px);
}

.auth__tagline {
  margin: 0 0 30px;
  font-size: 14px;
  letter-spacing: 1.4px;
  color: var(--bk-aside-text);
  opacity: 0.9;
}

/* ── 三条承诺 ── */
.points {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 14px;
}

.points li {
  display: grid;
  gap: 3px;
  padding-left: 12px;
  border-left: 2px solid var(--bk-wood-600);
}

.points b {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
}

.points span {
  font-size: 12px;
  line-height: 1.75;
  color: var(--bk-aside-text-dim);
}

/* ── 底部 ── */
.auth__brand-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 11.5px;
  letter-spacing: 0.4px;
  color: var(--bk-aside-text-dim);
}

.auth__brand-foot-line {
  width: 22px;
  height: 2px;
  border-radius: 1px;
  background: linear-gradient(90deg, var(--bk-wood-500), var(--bk-fire-500));
  flex-shrink: 0;
}

/* ── 表单区 ───────────────────────────────────────────── */
.auth__panel {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  overflow: hidden;
  background: var(--bk-surface);
  border-left: 1px solid var(--bk-line-2);
}

/**
 * 聚宝盆暗纹。
 *
 * ★ 位置要避开表单。实测踩到的坑：原先垂直居中摆，盆、元宝、铜钱
 *   正好压在输入框和「登录」按钮上 —— 透明度 0.075 时几乎看不见，
 *   调到看得见之后又会把表单衬得发花。
 *   现在整幅**下移**，让盆与铜钱落在表单下方的空白处，
 *   上半部分只剩祥云，正好从表单背后淡淡透出来。
 *
 * 水平居中于右侧面板：面板 520px、纹样 320px，视觉上比表单块略宽，
 * 像一块铺在下面的底纹，而不是一张贴上去的图。
 *
 * 透明度 0.16：白底上约等于 #dcdcdc 的视觉重量 ——
 * 远看是一片若有若无的深绿，近看才认得出是盆、铜钱与祥云。
 */
.panel-pattern {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -6%);
  opacity: 0.16;
  z-index: 0;
}

/* 四角回纹要贴着表单块，所以这块要相对定位并留出角饰的余量 */
.auth__panel-inner {
  position: relative;
  /* ★ 必须显式抬到暗纹之上。它原本没被定位、z-index 不生效，
     暗纹会盖在表单上 —— 虽然只有 7.5% 不透明度，输入框仍会发灰。 */
  z-index: 1;
  width: 100%;
  max-width: 400px;
  padding: 26px 24px;
}

/* 回纹角饰：只画左上角一次，其余三角旋转镜像 */
.knot {
  position: absolute;
  opacity: 0.75;
}

.knot--tl {
  top: 0;
  left: 0;
}

.knot--tr {
  top: 0;
  right: 0;
  transform: rotate(90deg);
}

.knot--br {
  right: 0;
  bottom: 0;
  transform: rotate(180deg);
}

.knot--bl {
  left: 0;
  bottom: 0;
  transform: rotate(270deg);
}

.auth__head {
  margin-bottom: 22px;
}

.auth__head h2 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
}

/* ── 窄屏 ── */
@media (max-width: 980px) {
  .auth {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }

  .auth__brand {
    padding: 20px 24px 22px;
  }

  .auth__brand-top {
    padding-bottom: 0;
    border-bottom: none;
  }

  /* 窄屏只留名字与一句话，其余收起 —— 一屏要放下表单 */
  .auth__brand-main {
    margin: 14px 0 0;
  }

  .auth__name {
    font-size: 26px;
    letter-spacing: 4px;
  }

  .title-row {
    margin-bottom: 6px;
  }

  .seal {
    width: 30px;
    height: 30px;
    font-size: 13px;
    border-width: 1.5px;
  }

  .auth__tagline {
    margin-bottom: 0;
  }

  .points,
  .auth__brand-foot,
  .brand-cloud,
    .brand-eave,
  .deco--dots,
  .deco--glow-2 {
    display: none;
  }

  /* 窄屏表单区空间紧，回纹四角与聚宝盆一起收掉 */
  .knot,
  .panel-pattern {
    display: none;
  }

  .auth__panel-inner {
    padding: 0;
  }
}
</style>
