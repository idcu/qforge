/**
 * wire（snake_case，见 docs/API-CONTRACT.md）↔ 本地（camelCase）字段映射。
 *
 * 唯一实现：api-adapter 的 fromWire* 与 backup.js 的跨布局转换共用，禁止各自复制。
 *   - from = wire → 本地（REST 响应与后端备份载荷同构）
 *   - to   = 本地 → wire 的**全量导出**口径（含 id/时间戳，供备份跨布局转换）
 * 注意：api-adapter 的 toWire*（请求体塑形，服务端补戳 id/bank_id/created_at）用途不同，
 * 保留在 api-adapter（见 docs/API-CONTRACT.md §7）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /* 复习调度设置（bank.sched）唯一映射：本地 camelCase ↔ wire snake_case。
   * 唯一实现供 QB.Wire.bank 与 api-adapter.toWireBank 复用，禁止各自手写字段表。 */
  const SCHED_TO_WIRE = {
    newPerDay: 'new_per_day', reviewPerDay: 'review_per_day',
    requestRetention: 'request_retention', maximumIntervalDays: 'maximum_interval_days',
    learningSteps: 'learning_steps', leechThreshold: 'leech_threshold',
    fuzz: 'fuzz', fuzzMaxDays: 'fuzz_max_days', easyDays: 'easy_days', leechAction: 'leech_action'
  };

  /** 本地 sched → wire（只输出已定义键；learningSteps 秒数组浅拷贝） */
  function schedTo(s) {
    if (!s) return null;
    const out = {};
    Object.keys(SCHED_TO_WIRE).forEach((k) => {
      if (s[k] === undefined) return;
      out[SCHED_TO_WIRE[k]] = Array.isArray(s[k]) ? s[k].slice() : s[k];
    });
    return out;
  }

  /** wire sched → 本地（缺省键保留 undefined，由 QB.SchedSettings.normalize 统一补默认） */
  function schedFrom(w) {
    if (!w) return null;
    return {
      newPerDay: w.new_per_day,
      reviewPerDay: w.review_per_day,
      requestRetention: w.request_retention,
      maximumIntervalDays: w.maximum_interval_days,
      learningSteps: Array.isArray(w.learning_steps) ? w.learning_steps.slice() : w.learning_steps,
      leechThreshold: w.leech_threshold,
      fuzz: w.fuzz,
      fuzzMaxDays: w.fuzz_max_days,
      easyDays: Array.isArray(w.easy_days) ? w.easy_days.slice() : w.easy_days,
      leechAction: w.leech_action
    };
  }

  const bank = {
    from(w) {
      return {
        id: w.id, name: w.name, description: w.description || '', category: w.category || '',
        // 来源溯源（file/paste/drop/url）：题库元数据的一部分，API/备份必须与 local 同链路保留
        source: w.source || null,
        // 复习调度设置（可选）：wire snake_case ↔ 本地 camelCase；缺失时为 null（使用默认限额）
        sched: schedFrom(w.sched),
        createdAt: w.created_at, updatedAt: w.updated_at
      };
    },
    to(b) {
      const out = {
        id: b.id, name: b.name, description: b.description || '', category: b.category || '',
        source: b.source || null,
        created_at: b.createdAt, updated_at: b.updatedAt
      };
      if (b.sched) out.sched = schedTo(b.sched);
      return out;
    },
    schedTo: schedTo,
    schedFrom: schedFrom
  };

  const question = {
    from(w) {
      const out = {
        id: w.id, bankId: w.bank_id, type: w.type,
        material: w.material, children: (w.children || []).map(question.from),
        question: w.question, options: w.options || [], answer: w.answer,
        blanks: w.blanks || [], reference_answer: w.reference_answer || '',
        analysis: w.analysis || '', category: w.category || '', source: w.source || '',
        difficulty: w.difficulty || 0, tags: w.tags || [],
        contentHash: w.content_hash, createdAt: w.created_at, updatedAt: w.updated_at
      };
      if (w.score !== undefined) out.score = w.score;
      return out;
    },
    to(q) {
      const out = { id: q.id, bank_id: q.bankId, type: q.type };
      if (q.material !== undefined) out.material = q.material;
      if (q.children !== undefined) out.children = q.children.map(question.to);
      out.question = q.question;
      out.options = q.options || [];
      out.answer = q.answer;
      out.blanks = q.blanks || [];
      out.reference_answer = q.reference_answer || '';
      out.analysis = q.analysis || '';
      out.category = q.category || '';
      out.source = q.source || '';
      out.difficulty = q.difficulty || 0;
      out.tags = q.tags || [];
      if (q.score !== undefined) out.score = q.score;
      const hash = q.contentHash || (q.type ? QB.makeContentHash(q) : undefined);
      if (hash) out.content_hash = hash;
      out.created_at = q.createdAt;
      out.updated_at = q.updatedAt;
      return out;
    }
  };

  const wrong = {
    from(w) { return { questionKey: w.question_key, wrongCount: w.wrong_count, lastAt: w.last_at }; },
    to(x) { return { question_key: x.questionKey, wrong_count: x.wrongCount, last_at: x.lastAt }; }
  };

  const favorite = {
    from(f) { return { questionKey: f.question_key, addedAt: f.added_at }; },
    to(f) { return { question_key: f.questionKey, added_at: f.addedAt }; }
  };

  const attempt = {
    from(w) {
      return {
        id: w.id, bankId: w.bank_id, bankName: w.bank_name, mode: w.mode,
        total: w.total, correct: w.correct, wrong: w.wrong, partial: w.partial || 0,
        score: w.score, accuracy: w.accuracy, byType: w.by_type || {},
        pending: w.pending || 0, unanswered: w.unanswered || 0,
        durationMs: w.duration_ms || 0, focusLeaves: w.focus_leaves || 0, createdAt: w.created_at
      };
    },
    to(r) {
      const map = { bankId: 'bank_id', bankName: 'bank_name', byType: 'by_type', durationMs: 'duration_ms', focusLeaves: 'focus_leaves', createdAt: 'created_at' };
      const out = {};
      Object.keys(r || {}).forEach((k) => { out[map[k] || k] = r[k]; });
      return out;
    }
  };

  QB.Wire = { bank, question, wrong, favorite, attempt };
})(window);
