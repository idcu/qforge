/**
 * local-adapter 拆分 · 题库仓储（BankRepository）
 * 题库 CRUD 与「删库」入口；级联删除本体由 local-adapter-cascade.js 注册后调用。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Storage = QB.Storage;
  const K = QB.KEYS;

  const Core = QB.LocalAdapterCore;

  /** 级联删除由 local-adapter-cascade.js 在装配末期注册；未装配时显式失败，不静默留脏数据。 */
  function handleCascade(id) {
    const fn = QB.LocalAdapterCore.cascade;
    if (typeof fn !== 'function') throw new Error('级联删除未装配：缺少 local-adapter-cascade.js');
    return fn(id);
  }

  /* ---------------- BankRepository ---------------- */
  const banks = {
    async list() {
      return Storage.get(K.banks, []).slice();
    },
    async get(id) {
      return (await banks.list()).find((b) => b.id === id) || null;
    },
    async create(data) {
      const list = await banks.list();
      const t = Core.now();
      const bank = {
        id: QB.uid('bank'),
        name: (data && data.name) || '未命名题库',
        description: (data && data.description) || '',
        category: (data && data.category) || '',
        // 来源溯源（file/paste/drop/url）：与 api 的 wire.bank.from 同语义，缺省 null
        source: (data && data.source) || null,
        createdAt: t,
        updatedAt: t
      };
      if (data && data.sched) bank.sched = data.sched;
      list.push(bank);
      Storage.set(K.banks, list);
      return bank;
    },
    async update(id, patch, opts) {
      const list = await banks.list();
      const idx = list.findIndex((b) => b.id === id);
      if (idx < 0) throw new Error('题库不存在: ' + id);
      // 乐观并发（与 api 的 baseUpdatedAt → 409 同语义）：仅调用方显式提供基准时校验
      if (opts && opts.baseUpdatedAt !== undefined && opts.baseUpdatedAt !== null) {
        if (Number(list[idx].updatedAt) !== Number(opts.baseUpdatedAt)) {
          const e = new Error('题库已被其它端修改，请刷新后重试');
          e.status = 409;
          e.code = 'CONFLICT';
          throw e;
        }
      }
      list[idx] = Object.assign({}, list[idx], patch, { id: id, updatedAt: Core.now() });
      Storage.set(K.banks, list);
      if (patch && patch.sched !== undefined) Core.invalidateSchedCache(id); // C019：调度设置直改库
      return list[idx];
    },
    async remove(id, options) {
      const cascade = !options || options.cascade !== false;
      const list = (await banks.list()).filter((b) => b.id !== id);
      Storage.setSync(K.banks, list);
      Core.invalidateSchedCache(id); // C019：删库后丢弃该库调度缓存
      if (cascade) {
        // 分阶段水合（Phase 0 批次2）：级联删除按库枚举键（分片/复习状态），先确保该库可见；
        // 否则删除非当前库只会清掉元数据，题目与复习状态成为孤儿（占用空间且不随库删除）。
        if (Storage.mode === 'idb' && typeof Storage.isBankHydrated === 'function' && !Storage.isBankHydrated(id)) {
          await Storage.ensureBank(id);
        }
        handleCascade(id); // 级联清理由唯一入口负责（见下方 cascadeDelete）
      }
    }
  };

  QB.LocalAdapterCore.banks = banks;
})(window);
