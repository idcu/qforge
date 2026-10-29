/**
 * 搜索与筛选（公共抽象）
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /**
   * 检索用文本（公共纯函数）：题干 + 选项 + 答案/填空/参考答案 + 解析 + 材料 + 分类 + 标签，
   * 材料题递归子问题。判分与去重基于原始文本，这里只做归一后的拼接。
   */
  function haystack(q) {
    if (!q) return '';
    const parts = [
      q.question, q.analysis, q.category, (q.tags || []).join(' '),
      q.answer, q.reference_answer, q.material,
      (q.options || []).map((o) => (o.letter || '') + ' ' + (o.text || '')).join(' '),
      (q.blanks || []).map((b) => b.answer || b).join(' ')
    ];
    (q.children || []).forEach((c) => parts.push(haystack(c)));
    return QB.normalizeAnswer(parts.filter(Boolean).join(' '));
  }

  QB.SearchFilter = {
    haystack,
    /** 关键词匹配（题干/选项/答案/参考答案/解析/材料/分类/标签；材料题递归子问题） */
    search(questions, keyword) {
      const kw = QB.normalizeAnswer(keyword, { stripPunctuation: false });
      if (!kw) return (questions || []).slice();
      return (questions || []).filter((q) => haystack(q).indexOf(kw) >= 0);
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