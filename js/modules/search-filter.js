/**
 * 搜索与筛选（公共抽象）
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  QB.SearchFilter = {
    /** 关键词匹配（题目 + 解析） */
    search(questions, keyword) {
      const kw = QB.normalizeAnswer(keyword, { stripPunctuation: false });
      if (!kw) return (questions || []).slice();
      return (questions || []).filter((q) => {
        const hay = QB.normalizeAnswer(q.question) + ' ' + QB.normalizeAnswer(q.analysis || '') +
          ' ' + QB.normalizeAnswer(q.category || '') + ' ' +
          QB.normalizeAnswer((q.tags || []).join(' '));
        return hay.indexOf(kw) >= 0;
      });
    },

    /** 组合筛选（criteria.tag：单标签；criteria.tags：标签数组，命中任一即可） */
    filter(questions, criteria) {
      criteria = criteria || {};
      let list = (questions || []).slice();
      if (criteria.type) list = list.filter((q) => q.type === criteria.type);
      if (criteria.category) list = list.filter((q) => (q.category || '') === criteria.category);
      const wanted = criteria.tags || (criteria.tag ? [criteria.tag] : null);
      if (wanted && wanted.length) {
        list = list.filter((q) => wanted.some((t) => (q.tags || []).indexOf(t) >= 0));
      }
      if (criteria.keyword) list = this.search(list, criteria.keyword);
      return list;
    },

    /** 关键词高亮（返回安全的 HTML） */
    highlight(text, keyword) {
      const safe = QB.escapeHtml(text || '');
      const kw = String(keyword || '').trim();
      if (!kw) return safe;
      const esc = QB.escapeHtml(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        return safe.replace(new RegExp(esc, 'gi'), (m) => '<span class="hl">' + m + '</span>');
      } catch (e) {
        return safe;
      }
    },

    /** 题库中出现的分类列表 */
    categories(questions) {
      const set = new Set();
      (questions || []).forEach((q) => { if (q.category) set.add(q.category); });
      return Array.from(set).sort();
    },

    /** 题库中出现的全部标签列表（排序去重） */
    tags(questions) {
      const set = new Set();
      (questions || []).forEach((q) => (q.tags || []).forEach((t) => set.add(t)));
      return Array.from(set).sort();
    }
  };
})(window);