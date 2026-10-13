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
          ' ' + QB.normalizeAnswer(q.category || '');
        return hay.indexOf(kw) >= 0;
      });
    },

    /** 组合筛选 */
    filter(questions, criteria) {
      criteria = criteria || {};
      let list = (questions || []).slice();
      if (criteria.type) list = list.filter((q) => q.type === criteria.type);
      if (criteria.category) list = list.filter((q) => (q.category || '') === criteria.category);
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
    }
  };
})(window);