/**
 * Anki Legacy 导入器（.apkg / collection.anki2|anki21）
 *
 * 设计取舍：
 *  - 以 note 为单位导入，而不是 card；多模板/多卡只保留 1 题并明确警告丢失项
 *  - cloze 一律降级为 essay：题干显示 [____]，参考答案汇总 cloze 内容
 *  - Front/Back 去 HTML 后判定 single/judge，判不了落 essay
 *  - media 清单 → QB.Assets 内容寻址；缺资产/音频只警告，不静默丢
 *  - .anki21b（zstd）显式拒绝，不做降级解析
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const FRONT_NAMES = ['front', 'question', '正面', '问题', '题干', 'recto', 'term', 'prompt'];
  const BACK_NAMES = ['back', 'answer', '背面', '答案', 'reponse', 'réponse', 'response', 'definition', 'def'];

  function decodeEntities(text) {
    if (QB.XmlLite && typeof QB.XmlLite.decodeEntities === 'function') return QB.XmlLite.decodeEntities(text);
    return String(text || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)));
  }

  function plainFieldName(name) {
    return String(name || '').trim().toLowerCase();
  }

  /**
   * Anki HTML → 纯文本；<img> 转资产占位符；[sound:] 丢弃并计数。
   * @param {string} html
   * @param {Object} ctx {mediaMarkers:Map, missing:Set, sounds:Set}
   */
  function htmlToText(html, ctx) {
    let s = String(html == null ? '' : html);
    s = s.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/\[sound:([^\]]+)\]/gi, function (m, name) {
      if (ctx) ctx.sounds.add(name);
      return '';
    });
    s = s.replace(/<img\b[^>]*\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi, function (m, rawSrc) {
      const src = decodeEntities(String(rawSrc).replace(/^['"]|['"]$/g, '').trim());
      if (!ctx) return '\n';
      const marker = ctx.mediaMarkers.get(src);
      if (marker) return '\n' + marker + '\n';
      if (!ctx.missing.has(src)) ctx.missing.add(src);
      return '\n[图片缺失：' + src + ']\n';
    });
    s = s.replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(div|p|li|tr|h[1-6]|blockquote|pre|table|tbody|thead)[^>]*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s).replace(/\u00a0/g, ' ');
    return s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 去掉 cloze 标记，保留空位；同时收集答案 */
  function stripCloze(text, answers) {
    return String(text || '').replace(/{{c\d+::([\s\S]*?)(?:::([\s\S]*?))?}}/g, function (m, body, hint) {
      const ans = htmlToText(body, null).trim();
      if (ans && answers.indexOf(ans) < 0) answers.push(ans);
      return hint ? '[____（' + htmlToText(hint, null).trim() + '）]' : '[____]';
    });
  }

  function hasCloze(text) {
    return /{{c\d+::/.test(String(text || ''));
  }

  function pickFieldIndexes(model) {
    const names = (model && Array.isArray(model.flds) ? model.flds : []).map((f) => plainFieldName(f.name));
    let front = -1;
    let back = -1;
    names.forEach(function (n, i) {
      if (front < 0 && FRONT_NAMES.indexOf(n) >= 0) front = i;
      if (back < 0 && BACK_NAMES.indexOf(n) >= 0) back = i;
    });
    if (front < 0) front = 0;
    if (back < 0 || back === front) back = names.length > 1 ? (front === 0 ? 1 : 0) : -1;
    return { front: front, back: back, names: names };
  }

  /** 只认显式判定词；不像 QB.parseBoolean 把 1/0 也当布尔（Anki 答案 1×1 = 1 很常见） */
  function explicitJudge(text) {
    const s = String(text || '').replace(/\s+/g, '').toLowerCase();
    if (['正确', '对', '是', '√', 'true', 'yes', 'no', '错误', '错', '否', '×', 'false'].indexOf(s) >= 0) {
      return ['正确', '对', '是', '√', 'true', 'yes'].indexOf(s) >= 0;
    }
    return null;
  }

  function parseOptionLines(lines) {
    const opts = [];
    const rest = [];
    lines.forEach(function (line) {
      if (/^\s*[A-Ha-h][.、)．:：]\s+\S/.test(line)) opts.push(line.trim());
      else rest.push(line);
    });
    return { options: opts, stem: rest.join('\n').trim() };
  }

  /**
   * Front/Back → 题型。能判单/判就判，否则 essay。
   * @returns {{raw:Object, type:string}}
   */
  function noteToRaw(front, back, model, tags, deckName, noteId) {
    const backText = String(back == null ? '' : back).trim();
    const isCloze = (model && Number(model.type) === 1) || hasCloze(front) || hasCloze(back);

    if (isCloze) {
      const answers = [];
      const q = stripCloze(front, answers).trim();
      return {
        raw: {
          type: 'essay',
          question: q,
          reference_answer: answers.join('；'),
          tags: tags,
          category: deckName,
          source: 'anki:' + noteId
        },
        type: 'essay',
        cloze: true
      };
    }

    const lines = String(front || '').split('\n');
    const parsed = parseOptionLines(lines);
    const letters = backText.replace(/[\s,，、]/g, '').toUpperCase();
    if (parsed.options.length >= 2 && /^[A-H]{1,4}$/.test(letters)) {
      const optionTexts = QB.Adapters.parseOptions(parsed.options);
      const valid = letters.split('').every((L) => optionTexts.some((o) => o.letter === L));
      if (valid) {
        return {
          raw: {
            type: letters.length > 1 ? 'multi' : 'single',
            question: parsed.stem,
            options: optionTexts,
            answer: letters,
            tags: tags,
            category: deckName,
            source: 'anki:' + noteId
          },
          type: letters.length > 1 ? 'multi' : 'single'
        };
      }
    }

    const judge = explicitJudge(backText);
    if (judge !== null) {
      return {
        raw: {
          type: 'judge',
          question: String(front || '').trim(),
          answer: judge ? '正确' : '错误',
          tags: tags,
          category: deckName,
          source: 'anki:' + noteId
        },
        type: 'judge'
      };
    }

    return {
      raw: {
        type: 'essay',
        question: String(front || '').trim(),
        reference_answer: backText,
        tags: tags,
        category: deckName,
        source: 'anki:' + noteId
      },
      type: 'essay'
    };
  }

  function emptyResult(format, warnings) {
    return { questions: [], warnings: warnings, format: format, stats: {}, meta: null };
  }

  async function parse(input) {
    const bytes = input && input.arrayBuffer;
    if (!bytes) return emptyResult('apkg', ['无法读取 .apkg：缺少二进制内容']);
    let entries;
    try {
      entries = await QB.ZipReader.readEntries(bytes);
    } catch (e) {
      return emptyResult('apkg', ['无法读取 .apkg（ZIP 损坏或不是 ZIP）：' + e.message]);
    }
    const cls = QB.AnkiPackage.classify(entries);
    if (!cls.supported) {
      return {
        questions: [],
        warnings: [cls.reason],
        format: 'apkg · ' + cls.label,
        stats: {},
        meta: { migration: { source: 'anki', version: cls.version, supported: false, reason: cls.reason } }
      };
    }
    if (cls.reason) {
      // 回退读取也应让用户知道
      // 继续解析，但把说明放进 warnings
    }

    let db;
    try {
      db = QB.SqliteReader.open(entries[cls.collectionName]);
    } catch (e) {
      return emptyResult('apkg · ' + cls.label, ['collection 数据库无法解析：' + e.message]);
    }

    let warnings = [];
    if (cls.reason) warnings.push(cls.reason);

    const notes = db.hasTable('notes') ? db.readTable('notes') : null;
    if (!notes) return emptyResult('apkg · ' + cls.label, ['collection 缺少 notes 表，无法按 note 导入。']);
    const cards = db.hasTable('cards') ? db.readTable('cards') : [];
    const revlogCount = db.hasTable('revlog') ? db.readTable('revlog').length : 0;

    const col = (db.readTable('col') || []).find((r) => r.id === 1) || {};
    let models = {};
    let decks = {};
    try { models = col.models ? JSON.parse(col.models) : {}; } catch (e) { warnings.push('models JSON 损坏，note type 字段名不可用，将按字段顺序取前两列。'); }
    try { decks = col.decks ? JSON.parse(col.decks) : {}; } catch (e) { decks = {}; }

    const cardsByNote = {};
    cards.forEach(function (c) {
      if (c && c.nid != null) {
        if (!cardsByNote[c.nid]) cardsByNote[c.nid] = [];
        cardsByNote[c.nid].push(c);
      }
    });

    // media 清单 → 资产（先建立原文件名 → marker）
    const mediaInfo = QB.AnkiPackage.readMediaMap(entries);
    warnings = warnings.concat(mediaInfo.warnings);
    const mediaMarkers = new Map();
    const missingMedia = new Set();
    const sounds = new Set();
    let assetCount = 0;
    let nonImageCount = 0;
    for (const name of Object.keys(mediaInfo.map)) {
      const entryName = mediaInfo.map[name];
      const assetBytes = entries[entryName];
      if (!assetBytes) {
        missingMedia.add(name);
        continue;
      }
      try {
        const mime = QB.Assets.mimeOfExt(/\.([a-z0-9]+)$/i.test(name) ? name.split('.').pop() : '');
        const id = await QB.Assets.put(assetBytes, mime);
        mediaMarkers.set(name, '![](asset:' + id + ')');
        assetCount++;
        if (!/^image\//i.test(mime)) nonImageCount++;
      } catch (e) {
        warnings.push('媒体入库失败：' + name + '（' + e.message + '）');
      }
    }

    const questions = [];
    const seen = new Set();
    const ctx = { mediaMarkers: mediaMarkers, missing: missingMedia, sounds: sounds };
    const stats = {
      notes: notes.length,
      cards: cards.length,
      revlog: revlogCount,
      imported: 0,
      skippedEmpty: 0,
      skippedDuplicate: 0,
      clozeNotes: 0,
      multiCardNotes: 0,
      lostCards: 0,
      missingFields: 0,
      noteTypes: Object.keys(models).length
    };
    const examples = { empty: [], missing: [], cloze: [], multi: [], extra: [] };
    const modelWarned = {};

    for (const note of notes) {
      const model = models[String(note.mid)] || null;
      const fields = String(note.flds == null ? '' : note.flds).split('\u001f');
      const idx = pickFieldIndexes(model);
      if (fields.length < 2) {
        stats.missingFields++;
        if (examples.missing.length < 5) examples.missing.push(note.id);
      }
      if (model && Array.isArray(model.flds) && model.flds.length > 2 && !modelWarned[note.mid]) {
        modelWarned[note.mid] = true;
        if (examples.extra.length < 5) {
          examples.extra.push((model.name || note.mid) + '（' + model.flds.length + ' 字段）');
        }
      }
      const frontHtml = fields[idx.front] == null ? '' : fields[idx.front];
      const backHtml = idx.back >= 0 && fields[idx.back] != null ? fields[idx.back] : '';
      const tags = QB.Adapters.normalizeTags(String(note.tags || '').split(/\s+/).filter(Boolean));
      const noteCards = cardsByNote[note.id] || [];
      const deck = noteCards.length && decks[String(noteCards[0].did)] ? decks[String(noteCards[0].did)].name : '';
      const converted = noteToRaw(htmlToText(frontHtml, ctx), htmlToText(backHtml, ctx), model, tags, deck, note.guid || note.id);
      if (converted.cloze) {
        stats.clozeNotes++;
        if (examples.cloze.length < 5) examples.cloze.push(note.id);
      }
      if (noteCards.length > 1) {
        stats.multiCardNotes++;
        stats.lostCards += noteCards.length - 1;
        if (examples.multi.length < 5) examples.multi.push(note.id + '（' + noteCards.length + ' 张卡）');
      }

      const standardized = QB.Adapters.toStandard(converted.raw);
      const q = standardized.question;
      if (!q.question) {
        stats.skippedEmpty++;
        if (examples.empty.length < 5) examples.empty.push(note.id);
        continue;
      }
      const hash = QB.makeContentHash(q);
      if (seen.has(hash)) {
        stats.skippedDuplicate++;
        continue;
      }
      seen.add(hash);
      questions.push(q);
    }
    stats.imported = questions.length;

    // 损失项：汇总在前，明细在后（预览只展示前若干条也不会丢掉总量）
    if (stats.lostCards > 0) {
      warnings.push('Anki 桥接：' + stats.multiCardNotes + ' 个 note 含多张 card，共 ' +
        stats.lostCards + ' 张卡的独立复习历史/独立调度丢失；已按 note 合并为 1 题。' +
        (examples.multi.length ? ' 例：' + examples.multi.join('、') : ''));
    }
    if (stats.clozeNotes > 0) {
      warnings.push('Anki 桥接：' + stats.clozeNotes + ' 个 cloze note 已降级为 essay（题干显示 [____]，参考答案汇总空位内容）；' +
        'cloze 的「每个空位一张卡」语义丢失。' + (examples.cloze.length ? ' 例：' + examples.cloze.join('、') : ''));
    }
    if (stats.skippedEmpty > 0) {
      warnings.push('Anki 桥接：' + stats.skippedEmpty + ' 个 note 题干为空，已跳过。' +
        (examples.empty.length ? ' note id：' + examples.empty.join('、') : ''));
    }
    if (stats.skippedDuplicate > 0) {
      warnings.push('Anki 桥接：' + stats.skippedDuplicate + ' 个 note 与包内其它题内容重复，已跳过（不造重复题）。');
    }
    if (stats.missingFields > 0) {
      warnings.push('Anki 桥接：' + stats.missingFields + ' 个 note 字段不足 2 个，参考答案为空。' +
        (examples.missing.length ? ' 例：' + examples.missing.join('、') : ''));
    }
    if (examples.extra.length) {
      warnings.push('Anki 桥接：部分 note type 超过 2 个字段，仅 Question/Front 与 Reponse/Back 参与导入，其余字段未映射。' +
        ' 例：' + examples.extra.join('、'));
    }
    if (missingMedia.size) {
      warnings.push('Anki 桥接：' + missingMedia.size + ' 个媒体在包内缺失，已保留「图片缺失」占位：' +
        Array.from(missingMedia).slice(0, 10).join('、'));
    }
    if (nonImageCount > 0) {
      warnings.push('Anki 桥接：' + nonImageCount + ' 个非图片媒体已入库，但当前渲染只支持图片，音频/附件不会显示。');
    }
    if (sounds.size) {
      warnings.push('Anki 桥接：' + sounds.size + ' 个 [sound:] 音频引用已移除（不支持音频播放）：' +
        Array.from(sounds).slice(0, 10).join('、'));
    }
    if (revlogCount > 0) {
      warnings.push('Anki 桥接：源包 revlog 共 ' + revlogCount + ' 条，本轮不导入复习调度历史；导入题按新题处理。');
    }
    if (!questions.length) warnings.push('Anki 桥接：没有可导入的 note（全部为空或字段缺失）。');

    return {
      questions: questions,
      warnings: warnings,
      format: 'apkg · ' + cls.label + '（' + cls.collectionName + '）',
      assetCount: assetCount,
      stats: stats,
      // 透传导入摘要：data-io 预览可直接展示 note→card 丢失项
      meta: {
        migration: {
          source: 'anki',
          version: cls.version,
          versionLabel: cls.label,
          collection: cls.collectionName,
          supported: true,
          stats: stats,
          media: { stored: assetCount, missing: missingMedia.size, nonImage: nonImageCount, sounds: sounds.size },
          revlogImported: 0
        }
      }
    };
  }

  QB.AnkiImporter = {
    exts: ['apkg'],
    binary: true,
    parse: parse,
    // 测试/探针复用的纯函数（唯一实现）
    htmlToText: htmlToText
  };
})(typeof window !== 'undefined' ? window : globalThis);
