/**
 * 应用上下文（当前主体 + 当前会计期间）
 * ============================================================
 * 几乎所有页面都需要「当前主体」和「当前期间」，放在 store 里统一管理，
 * 避免每个页面各自请求、各自缓存导致数据不一致。
 *
 * ★ 当前主体由 auth store 决定（它记住用户上次选的是哪家），
 *   这里只负责按那个 id 拉期间与科目表 —— 两处各存一份 currentEntityId
 *   必然会出现"顶栏显示 A 公司、页面数据是 B 公司"这种错位。
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  api,
  type AccountSummary,
  type EntitySummary,
  type PeriodSummary,
} from '@/api';
import { useAuthStore } from '@/stores/auth';

export const useAppStore = defineStore('app', () => {
  const entities = ref<EntitySummary[]>([]);
  const currentEntityId = ref<string>('');
  const periods = ref<PeriodSummary[]>([]);
  const currentPeriodId = ref<string>('');
  const accounts = ref<AccountSummary[]>([]);
  const loading = ref(false);
  const bootError = ref<string>('');

  const currentEntity = computed(() =>
    entities.value.find((e) => e.id === currentEntityId.value),
  );
  const currentPeriod = computed(() =>
    periods.value.find((p) => p.id === currentPeriodId.value),
  );

  /** 只保留末级且启用的科目 —— 只有这些允许记账 */
  const leafAccounts = computed(() => accounts.value.filter((a) => a.isLeaf && a.isActive));

  const accountByCode = computed(() => {
    const map = new Map<string, AccountSummary>();
    for (const a of accounts.value) map.set(a.code, a);
    return map;
  });

  const periodLabel = computed(() => {
    const p = currentPeriod.value;
    return p ? `${p.fiscalYear}-${String(p.month).padStart(2, '0')}` : '';
  });

  /** 当前期间是否可写（只有 OPEN 才能录凭证） */
  const periodWritable = computed(() => currentPeriod.value?.status === 'OPEN');

  async function bootstrap(): Promise<void> {
    loading.value = true;
    bootError.value = '';
    try {
      const auth = useAuthStore();
      entities.value = await api.entities();
      if (entities.value.length === 0) {
        bootError.value =
          '这个账号名下还没有公司。记账必须先有核算主体 —— 请先创建公司账套。';
        currentEntityId.value = '';
        periods.value = [];
        accounts.value = [];
        return;
      }

      // 跟着 auth store 选中的那家走；它记的是上次用的公司。
      // 若那家已不在列表里（权限被移除），退回第一家
      const preferred = auth.currentEntityId;
      const chosen =
        entities.value.find((e) => e.id === preferred)?.id ?? entities.value[0]!.id;
      currentEntityId.value = chosen;
      auth.selectEntity(chosen);

      periods.value = await api.periods(chosen);
      // 默认选中当年最近的可写期间，否则选最后一个
      const now = new Date();
      const sameYear = periods.value.filter((p) => p.fiscalYear === now.getFullYear());
      const openPeriod =
        sameYear.find((p) => p.month === now.getMonth() + 1 && p.status === 'OPEN') ??
        sameYear.find((p) => p.status === 'OPEN') ??
        periods.value[periods.value.length - 1];
      currentPeriodId.value = openPeriod?.id ?? '';

      accounts.value = await api.accounts(chosen);
    } catch (e) {
      bootError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  function selectEntity(id: string): void {
    currentEntityId.value = id;
  }

  function selectPeriod(id: string): void {
    currentPeriodId.value = id;
  }

  return {
    entities,
    currentEntityId,
    currentEntity,
    periods,
    currentPeriodId,
    currentPeriod,
    periodLabel,
    periodWritable,
    accounts,
    leafAccounts,
    accountByCode,
    loading,
    bootError,
    bootstrap,
    selectEntity,
    selectPeriod,
  };
});
