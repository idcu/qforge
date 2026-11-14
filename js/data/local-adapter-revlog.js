/**
 * local-adapter 拆分 · 评分日志分段追加布局（公共抽象 QB.RevlogStore）
 * user:revlogMeta + user:revlog:<i> 分段追加、FIFO 裁剪、重映射与合并策略。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Storage = QB.Storage;
  const K = QB.KEYS;

  const Core = QB.LocalAdapterCore;

  const REVLOG_MAX = (QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.REVLOG_MAX) || 20000; // revlog FIFO 上限
  const REVLOG_SEG_SIZE = 200; // 分段追加日志每段条数（单次评分只重写尾段）
  const REVLOG_LAYOUT_VERSION = 2;

  /* ---------------- 评分日志分段追加布局（公共抽象 QB.RevlogStore） ----------------
   * 旧布局 user:revlog 为单数组（每次追加重写全量，O(n)）。
   * schema v5：user:revlog:meta {v,segSize,first,last,count} + user:revlog:<i> 分段数组。
   * 追加只读写尾段（O(segSize)，与总条数无关）；FIFO 裁剪只动首段；list 仍返回整表。
   */
  function revlogMetaOf() {
    const m = Storage.getFresh(K.revlogMeta, null);
    return (m && m.v === REVLOG_LAYOUT_VERSION &&
      typeof m.first === 'number' && typeof m.last === 'number' &&
      typeof m.count === 'number') ? m : null;
  }

  function revlogSegOf(i) {
    const v = Storage.getFresh(K.revlogSeg(i), null);
    return Array.isArray(v) ? v : [];
  }

  /** 补 id/时间戳 + 只保留可序列化字段（追加与整表重建共用） */
  function normalizeLogEntries(entries, t0) {
    const out = [];
    (entries || []).forEach((e) => {
      if (!e) return;
      const entry = { id: QB.uid('rl'), t: e.t || t0, h: e.h, r: e.r };
      if (e.b) entry.b = e.b;
      out.push(entry);
    });
    return out;
  }

  const RevlogStore = {
    SEG_SIZE: REVLOG_SEG_SIZE,
    MAX: REVLOG_MAX,

    meta: revlogMetaOf,
    seg: revlogSegOf,

    /** 整表读取（旧整表键存在时仍可读；迁移后走分段） */
    list() {
      const meta = revlogMetaOf();
      if (!meta) {
        const legacy = Storage.getFresh(K.revlog, null);
        return Array.isArray(legacy) ? legacy : [];
      }
      let out = [];
      for (let i = meta.first; i <= meta.last; i++) out = out.concat(revlogSegOf(i));
      return out;
    },

    count() {
      const meta = revlogMetaOf();
      if (meta) return meta.count;
      const legacy = Storage.getFresh(K.revlog, null);
      return Array.isArray(legacy) ? legacy.length : 0;
    },

    /** 把旧整表数组转为分段（幂等；先写分段再写清单，最后删旧键） */
    convertLegacy() {
      if (revlogMetaOf()) {
        // 清单已存在：旧整表键只可能是历史残留（list 以清单为准），直接清除避免双份数据
        if (Storage.getFresh(K.revlog, null) !== null) Storage.remove(K.revlog);
        return false;
      }
      const legacy = Storage.getFresh(K.revlog, null);
      const list = Array.isArray(legacy) ? legacy.slice(-REVLOG_MAX) : [];
      // 无旧整表数据时不写空清单：避免启动期把内部初始化写成“业务键”，
      // 导致 IDB 不可用回落时 marker 被误降级为 ls-fallback（C007）。
      if (!list.length) {
        if (legacy !== undefined) Storage.remove(K.revlog);
        return false;
      }
      const segs = [];
      for (let i = 0; i < list.length; i += REVLOG_SEG_SIZE) segs.push(list.slice(i, i + REVLOG_SEG_SIZE));
      segs.forEach((seg, i) => Storage.setSync(K.revlogSeg(i), seg));
      Storage.setSync(K.revlogMeta, {
        v: REVLOG_LAYOUT_VERSION, segSize: REVLOG_SEG_SIZE,
        first: 0, last: segs.length - 1, count: list.length
      });
      if (legacy !== undefined) Storage.remove(K.revlog);
      return true;
    },

    /**
     * 清空全部分段键、清单与旧整表键（整表重建/删库用）。
     * 删库级联（removeBank→replaceAll→clear）在「其他库未水合」时处于分阶段部分视图：
     * 严格读取下 `keys()` 无法证明全量视图会抛 NotHydratedError，导致删除半途失败。
     * 分段键是全局键族（user:revlog:<i>，不归属任何题库），不需要题目库键集：
     *   - 优先沿用 `keys()`：保留清单外孤儿分段的清理能力，strict=false 路径逐字不变；
     *   - 仅在严格守卫拒绝（部分视图）时，按清单 first..last 显式枚举分段键。
     * 崩溃窗口中清单已落后于实际分段的孤儿键不在枚举范围（见 docs/STORAGE.md 遗留风险）。
     */
    clear() {
      let all = null;
      try {
        all = Storage.keys();
      } catch (e) {
        if (!e || e.code !== 'STORAGE_NOT_HYDRATED') throw e;
      }
      if (all) {
        all.forEach((k) => {
          if (k === K.revlogMeta) return;
          if (k.indexOf('user:revlog:') === 0 && /^\d+$/.test(k.slice('user:revlog:'.length))) Storage.remove(k);
        });
      } else {
        const meta = revlogMetaOf();
        if (meta) {
          for (let i = meta.first; i <= meta.last; i++) Storage.remove(K.revlogSeg(i));
        }
      }
      Storage.remove(K.revlogMeta);
      Storage.remove(K.revlog);
    },

    /** 用完整列表重建分段（备份恢复/迁移重映射用；O(n) 但非热路径） */
    replaceAll(list) {
      const src = (Array.isArray(list) ? list : []).slice(-REVLOG_MAX);
      RevlogStore.clear();
      const segs = [];
      for (let i = 0; i < src.length; i += REVLOG_SEG_SIZE) segs.push(src.slice(i, i + REVLOG_SEG_SIZE));
      segs.forEach((seg, i) => Storage.setSync(K.revlogSeg(i), seg));
      Storage.setSync(K.revlogMeta, {
        v: REVLOG_LAYOUT_VERSION, segSize: REVLOG_SEG_SIZE,
        first: 0, last: segs.length - 1, count: src.length
      });
      Core.bumpRevlogRev();
    },

    /**
     * 追加（热路径）：只读写尾段 + 必要时裁剪首段。
     * 返回 {added, rollback}：调用方（状态+日志一次提交）失败时用 rollback 恢复日志。
     */
    appendInternal(entries) {
      const t0 = Core.now();
      const normalized = normalizeLogEntries(entries, t0);
      if (!normalized.length) return { added: 0, rollback: function () {} };
      RevlogStore.convertLegacy();
      const prevMeta = revlogMetaOf();
      const touched = new Map(); // i -> 变更前快照（null=不存在），回滚用
      const written = new Set(); // 本批已重写过的分段键
      // 读分段并登记变更前快照；返回可变副本（后续 push/splice 不会污染回滚快照）。
      // 同一段在本批只解析一次：原实现 revlogSegOf() 取值后 touch() 会对同一个键再 getFresh 一次。
      const readSeg = (i) => {
        if (!touched.has(i)) {
          const raw = Storage.getFresh(K.revlogSeg(i), null);
          touched.set(i, raw);
          return Array.isArray(raw) ? raw.slice() : [];
        }
        // 已登记快照：本批重写过该段时保持原语义（读回落盘值），否则直接复用快照，省掉重复 JSON.parse
        const raw = written.has(i) ? Storage.getFresh(K.revlogSeg(i), null) : touched.get(i);
        return Array.isArray(raw) ? raw.slice() : [];
      };
      const meta = Object.assign({ v: REVLOG_LAYOUT_VERSION, segSize: REVLOG_SEG_SIZE, first: 0, last: 0, count: 0 }, prevMeta || {});
      let idx = meta.count ? meta.last : 0;
      if (!meta.count) { meta.first = 0; meta.last = 0; }
      const rollback = function () {
        // 回滚只改内存/待写队列，最后统一落盘：配额失败时逐个 setSync 会在第一个键再次抛错，
        // 导致后续键没来得及回滚（状态半写）。set 不立即落盘，forceSync 失败由调用方兜底。
        touched.forEach((value, i) => {
          if (value === null || value === undefined) Storage.remove(K.revlogSeg(i));
          else Storage.set(K.revlogSeg(i), value);
        });
        if (prevMeta) Storage.set(K.revlogMeta, prevMeta);
        else Storage.remove(K.revlogMeta);
      };
      try {
        let seg = readSeg(idx); // 副本：失败时不能污染 touched 中用于回滚的旧数组
        normalized.forEach((entry) => {
          if (seg.length >= REVLOG_SEG_SIZE) {
            Storage.setSync(K.revlogSeg(idx), seg);
            written.add(idx);
            idx += 1;
            seg = readSeg(idx);
          }
          seg.push(entry);
        });
        Storage.setSync(K.revlogSeg(idx), seg);
        written.add(idx);
        meta.last = idx;
        meta.count += normalized.length;

        // FIFO：只裁首段
        let overflow = meta.count - REVLOG_MAX;
        while (overflow > 0) {
          const first = readSeg(meta.first);
          if (!first.length) { meta.first += 1; continue; }
          if (first.length <= overflow) {
            overflow -= first.length;
            Storage.remove(K.revlogSeg(meta.first));
            written.add(meta.first);
            meta.first += 1;
          } else {
            first.splice(0, overflow);
            Storage.setSync(K.revlogSeg(meta.first), first);
            written.add(meta.first);
            overflow = 0;
          }
        }
        if (meta.count > REVLOG_MAX) meta.count = REVLOG_MAX;
        if (meta.first > meta.last) { meta.first = 0; meta.last = -1; meta.count = 0; }
        Storage.setSync(K.revlogMeta, meta);
        Core.bumpRevlogRev();
        return { added: normalized.length, rollback: rollback };
      } catch (e) {
        // 写入中途失败：appendInternal 自己先回滚本次改动再抛，调用方无需也无法拿到 rollback
        rollback();
        throw e;
      }
    },

    /** h 字段重映射（只重写含命中条目的分段；旧整表布局就地重写） */
    remap(mapping) {
      if (!mapping || !mapping.size) return 0;
      const meta = revlogMetaOf();
      if (!meta) {
        const legacy = Storage.getFresh(K.revlog, null);
        if (!Array.isArray(legacy)) return 0;
        let n = 0;
        const next = legacy.map((e) => {
          if (!e || !mapping.has(e.h)) return e;
          n++;
          return Object.assign({}, e, { h: mapping.get(e.h) });
        });
        if (n) { Storage.setSync(K.revlog, next); Core.bumpRevlogRev(); }
        return n;
      }
      let n = 0;
      for (let i = meta.first; i <= meta.last; i++) {
        const seg = revlogSegOf(i);
        let changed = false;
        const next = seg.map((e) => {
          if (!e || !mapping.has(e.h)) return e;
          changed = true; n++;
          return Object.assign({}, e, { h: mapping.get(e.h) });
        });
        if (changed) Storage.setSync(K.revlogSeg(i), next);
      }
      if (n) Core.bumpRevlogRev();
      return n;
    },

    /** 删库级联：移除该库（b === bankId）的日志，旧无 b 记录保留 */
    removeBank(bankId) {
      const list = RevlogStore.list();
      const kept = list.filter((e) => !e || e.b !== bankId);
      if (kept.length === list.length) return 0;
      RevlogStore.replaceAll(kept); // replaceAll 内已自增 revlogRev
      return list.length - kept.length;
    }
  };

  const revlog = {
    list() { return RevlogStore.list(); },
    /** revlog 写修订号（同步数值；append/record/cascade/backup 后自增） */
    revision() { return Core.revlogRevision(); },
    /**
     * 构造追加后的新数组（纯函数，不落盘）：补 id/时间戳 + FIFO 裁剪。
     * 保留为公共纯函数（测试/历史调用方）；热路径改用 RevlogStore.appendInternal。
     */
    build(base, entries) {
      const list = Array.isArray(base) ? base.slice() : [];
      if (!entries || !entries.length) return list;
      list.push.apply(list, normalizeLogEntries(entries, Core.now()));
      if (list.length > REVLOG_MAX) list.splice(0, list.length - REVLOG_MAX);
      return list;
    },
    /** 追加并返回整表（对外契约不变；内部热路径不调用，避免 O(n) 物化） */
    async append(entries) {
      RevlogStore.appendInternal(entries);
      return RevlogStore.list();
    }
  };

  if (typeof Storage.registerMerge === 'function') {

    // revlog 分段：按条目 id 并集，避免另一标签的追加被整段覆盖
    const SEG_PREFIX = 'user:revlog:';
    Storage.registerMerge(
      (key) => key.indexOf(SEG_PREFIX) === 0 && /^\d+$/.test(key.slice(SEG_PREFIX.length)),
      (local, incoming) => {
        if (!Array.isArray(local)) return incoming;
        if (!Array.isArray(incoming)) return local;
        const seen = new Set(local.map((e) => e && e.id));
        const out = local.slice();
        incoming.forEach((e) => { if (!e || !seen.has(e.id)) out.push(e); });
        return out;
      }
    );
    Storage.registerMerge(
      (key) => key === K.revlogMeta,
      (local, incoming) => {
        if (!local || typeof local !== 'object') return incoming;
        if (!incoming || typeof incoming !== 'object') return local;
        return {
          v: Math.max(local.v || 0, incoming.v || 0),
          segSize: incoming.segSize || local.segSize,
          first: Math.min(local.first || 0, incoming.first || 0),
          last: Math.max(local.last == null ? -1 : local.last, incoming.last == null ? -1 : incoming.last),
          count: Math.max(local.count || 0, incoming.count || 0)
        };
      }
    );
  }

  QB.RevlogStore = RevlogStore;          // 评分日志分段追加布局（migrate/backup 复用）
  QB.REVLOG_LAYOUT_VERSION = REVLOG_LAYOUT_VERSION;
  Core.revlog = revlog;
  Core.REVLOG_MAX = REVLOG_MAX;
})(window);
