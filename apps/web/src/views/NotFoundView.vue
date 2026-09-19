<script setup lang="ts">
/**
 * 404 页面
 * ============================================================
 * 为什么这个页面不是"可有可无的装饰"：
 *
 *   没有它的时候，写错的 URL（比如曾经把 /vouchers/recognition 写成 /recognition）
 *   会被 router 接受、URL 也变了，但页面渲染出一片空白。
 *   空白会被理解成"这个功能没做"，而不是"路径写错了" ——
 *   排查方向从一开始就偏了。
 *
 *   有一个明确的 404 页，问题一眼定位：不是功能缺失，是链接写错了。
 */
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();

const attempted = computed(() => route.fullPath);
</script>

<template>
  <div class="bk-page">
    <div class="bk-card nf">
      <div class="nf__code">404</div>
      <div class="nf__title">这个地址没有对应的页面</div>
      <div class="nf__path">
        你访问的是 <code>{{ attempted }}</code>
      </div>

      <el-alert type="info" :closable="false" show-icon class="nf__tip">
        <div class="bk-hint">
          这通常是<b>链接写错了</b>，不是功能没做。可用的页面见左侧菜单。<br />
          如果你是从某个按钮点进来的，说明那个按钮的目标路径有问题 —— 请反馈具体是哪个按钮。
        </div>
      </el-alert>

      <div class="nf__actions">
        <el-button type="primary" @click="router.push('/dashboard')">回到总览</el-button>
        <el-button @click="router.back()">返回上一页</el-button>
      </div>

      <div class="bk-hint nf__nav">
        <b>常用入口</b><br />
        <el-link type="primary" @click="router.push('/vouchers')">凭证列表</el-link> ·
        <el-link type="primary" @click="router.push({ name: 'voucher-new' })">手工录入</el-link> ·
        <el-link type="primary" @click="router.push({ name: 'recognition' })">识别录入</el-link> ·
        <el-link type="primary" @click="router.push('/warehouse')">发票仓库</el-link> ·
        <el-link type="primary" @click="router.push('/print')">凭证册打印</el-link> ·
        <el-link type="primary" @click="router.push('/audit')">账务自检</el-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nf {
  max-width: 620px;
  margin: 48px auto;
  text-align: center;
}

.nf__code {
  font-size: 56px;
  font-weight: 700;
  line-height: 1.1;
  color: var(--bk-earth-500);
  letter-spacing: 2px;
}

.nf__title {
  font-size: 17px;
  font-weight: 600;
  margin: 6px 0 10px;
  color: var(--bk-ink);
}

.nf__path {
  font-size: 13px;
  color: var(--bk-ink-3);
  margin-bottom: 18px;
  word-break: break-all;
}

.nf__path code {
  padding: 2px 6px;
  background: var(--bk-earth-50);
  border-radius: 3px;
  color: var(--bk-earth-700);
}

.nf__tip {
  text-align: left;
  margin-bottom: 18px;
}

.nf__actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}

.nf__nav {
  margin-top: 22px;
  padding-top: 14px;
  border-top: 1px solid var(--bk-line);
  line-height: 2.2;
}
</style>
