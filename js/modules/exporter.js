/**
 * 导出器·外壳：收集导出对象、下载/分享/分发流程与格式选择弹窗。
 * 七种格式构建器与历史归档纯函数已原样迁至 exporter-formats.js（QB.ExporterFormats），
 * 本文件保留 KINDS 收集入口与浏览器外壳，对外的 QB.Exporters 契约不变。
 *
 * 已支持 kind：bank（题库）、wrong（错题本）、favorites（收藏夹）、history（答题历史）
 *   - 前三种为题集（entries:[{question,meta}]），支持全部 7 格式；
 *   - history 为非题集结构（entries:[{record}]），仅支持 json/csv/xlsx/txt（统计归档，不导回）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const F = QB.ExporterFormats;

  /* ---------------- 收集导出对象 ---------------- */

  /** 统一题集载荷：{ kind, bank, entries:[{question, meta}] } */
  const KINDS = {
    bank: {
      label: F.KIND_LABELS.bank,
      async collect(bank) {
        const { items } = await QB.DB.questions.list(bank.id, {});
        return items.map((question) => ({ question: question, meta: {} }));
      }
    },
    wrong: {
      label: F.KIND_LABELS.wrong,
      async collect(bank) {
        const list = await QB.WrongBook.list(bank.id);
        return list.map((w) => ({ question: w.question, meta: { wrongCount: w.wrongCount || 1, lastAt: w.lastAt || 0 } }));
      }
    },
    favorites: {
      label: F.KIND_LABELS.favorites,
      async collect(bank) {
        const list = await QB.Favorites.list(bank.id);
        return list.map((f) => ({ question: f.question, meta: { addedAt: f.addedAt || 0 } }));
      }
    },
    // 非题集：entries 为 [{record}]；formats 限定可导出格式（统计归档，不做导回）
    history: {
      label: F.KIND_LABELS.history,
      unit: '条',
      formats: ['json', 'csv', 'xlsx', 'txt'],
      async collect(bank) {
        const records = await QB.History.list(bank.id);
        return records.map((record) => ({ record: record }));
      }
    }
  };

  /* ---------------- 纯函数入口（可测试） ---------------- */

  async function collect(kind, bank) {
    const def = KINDS[kind];
    if (!def) throw new Error('不支持的导出对象：' + kind);
    // 分阶段水合（Phase 0 批次2）：导出按库物化键，先确保目标库可见
    // （题库列表可导出任意库，非当前库默认不在同步视图里）。
    if (bank && bank.id && QB.Storage && QB.Storage.mode === 'idb' &&
        typeof QB.Storage.isBankHydrated === 'function' && !QB.Storage.isBankHydrated(bank.id)) {
      await QB.Storage.ensureBank(bank.id);
    }
    const entries = await def.collect(bank);
    return { kind: kind, bank: bank, entries: entries };
  }

  /* ---------------- C026 批注总量预算 ---------------- */

  // 只有这些格式会携带 annotation（CSV/Markdown/XLSX/DOCX/TXT 本来就不写该字段）
  const ANNOTATION_FORMATS = { qbk: true, json: true, html: true };

  function payloadQuestions(payload) {
    return ((payload && payload.entries) || []).map((e) => e.question);
  }

  /** 去掉题集里所有批注，返回新载荷（不修改原对象；本机数据完全不动） */
  function stripAnnotations(payload) {
    return {
      kind: payload.kind,
      bank: payload.bank,
      entries: (payload.entries || []).map((e) => {
        const q = Object.assign({}, e.question);
        delete q.annotation;
        return { question: q, meta: e.meta };
      })
    };
  }

  /**
   * 导出前的批注总量闸门（导出前提示 + 明确处理方式）：
   *   - 未超限：原样返回；
   *   - 超限：确认弹窗二选一（「不含批注继续导出」→ 返回剥离批注的新载荷；
   *     「取消」→ ok=false，调用方中止导出）。绝不静默截断或静默丢弃批注。
   * @returns {{ok:boolean, payload:Object, omitted:boolean, budget?:Object, canceled?:boolean}}
   */
  async function ensureAnnotationBudget(formatId, payload) {
    if (!QB.Annotation || typeof QB.Annotation.checkTotal !== 'function' ||
        !payload || payload.kind === 'history' || !ANNOTATION_FORMATS[formatId]) {
      return { ok: true, payload: payload, omitted: false };
    }
    const check = QB.Annotation.checkTotal(payloadQuestions(payload));
    if (check.ok) return { ok: true, payload: payload, omitted: false, budget: check };
    const text = QB.Annotation.overflowText(check, '');
    let proceed = false;
    if (QB.UIPort && typeof QB.UIPort.confirm === 'function') {
      proceed = await QB.UIPort.confirm(null, '不含批注继续导出', {
        lines: [
          text,
          '「不含批注继续导出」：题目、答案、解析与图片照常导出，仅省略批注；本机批注数据不变。',
          '「取消」：不导出，回到题库删减部分批注后重试。'
        ]
      });
    }
    if (!proceed) return { ok: false, canceled: true, payload: payload, omitted: false, budget: check };
    return { ok: true, payload: stripAnnotations(payload), omitted: true, budget: check };
  }

  function buildContent(formatId, payload) {
    const fmt = F.FORMATS.find((f) => f.id === formatId);
    if (!fmt) throw new Error('不支持的导出格式：' + formatId);
    if (fmt.async) throw new Error('该格式为异步构建，请用 buildAsync：' + formatId);
    return { content: fmt.build(payload), ext: fmt.ext, mime: fmt.mime };
  }

  /**
   * 同步/异步格式统一入口（qbk 需读 IndexedDB）
   * @param {Object} [opts] 透传给格式构建器；仅 buildQBK 识别 opts.distribute（分发题包）
   */
  async function buildAsync(formatId, payload, opts) {
    const fmt = F.FORMATS.find((f) => f.id === formatId);
    if (!fmt) throw new Error('不支持的导出格式：' + formatId);
    const r = await fmt.build(payload, opts);
    return {
      content: r && r.content != null ? r.content : r,
      ext: (r && r.ext) || fmt.ext,
      mime: (r && r.mime) || fmt.mime,
      assetCount: (r && r.assetCount) || 0,
      missing: (r && r.missing) || 0,
      manifest: (r && r.manifest) || null
    };
  }

  /* ---------------- 浏览器外壳 ---------------- */

  function download(filename, mime, content) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function chooseFormat(count, kindLabel, allowedIds, unit, kindId, returnFocusTo) {
    unit = unit || '题';
    const formats = F.FORMATS.filter((f) =>
      (!allowedIds || allowedIds.indexOf(f.id) >= 0) &&
      (!f.kinds || (kindId && f.kinds.indexOf(kindId) >= 0)));
    return new Promise((resolve) => {
      const radios = formats.map((f) =>
        '<div class="checkbox-row"><input type="radio" id="exp-fmt-' + f.id + '" name="exp-fmt" value="' + f.id + '"' + (f.id === 'json' ? ' checked' : '') + '>' +
        '<label for="exp-fmt-' + f.id + '">' + QB.escapeHtml(f.label) + '</label></div>').join('');
      QB.UIPort.openModal(
        '<h3>导出' + QB.escapeHtml(kindLabel) + '</h3>' +
        '<div class="li-meta">共 ' + count + ' ' + unit + '，请选择导出格式：</div>' + radios +
        '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
        '<button class="btn" data-action="modal-ok">导出</button></div>',
        (modal) => {
          modal.querySelector('[data-action="modal-cancel"]').onclick = () => { QB.UIPort.closeModal(); resolve(null); };
          modal.querySelector('[data-action="modal-ok"]').onclick = () => {
            const id = modal.querySelector('input[name="exp-fmt"]:checked').value;
            QB.UIPort.closeModal();
            resolve(id);
          };
        },
        undefined,
        returnFocusTo
      );
    });
  }

  /**
   * 完整导出流程：收集 → 选格式 → 构建 → 下载
   * @param {{kind:string, bank:Object}} opts
   */
  async function openFlow(opts) {
    const def = KINDS[opts.kind];
    if (!def) { QB.UIPort.toast('不支持的导出对象', 'err'); return null; }
    if (!opts.bank) { QB.UIPort.toast('请先选择题库', 'err'); return null; }

    let payload;
    try {
      payload = await collect(opts.kind, opts.bank);
    } catch (e) {
      QB.UIPort.toast('导出失败：' + e.message, 'err');
      return null;
    }
    if (!payload.entries.length) { QB.UIPort.toast(def.label + '为空，无可导出内容', 'err'); return null; }

    const unit = def.unit || '题';
    const formatId = await chooseFormat(payload.entries.length, def.label, def.formats, unit, opts.kind, opts.trigger);
    if (!formatId) return null;

    // C026：批注总量超限 → 导出前确认（不含批注继续 / 取消去清理），不静默丢批注
    const gate = await ensureAnnotationBudget(formatId, payload);
    if (!gate.ok) {
      QB.UIPort.toast('已取消导出：批注总量超限，请先删减批注后重试', 'err');
      return null;
    }
    payload = gate.payload;
    if (gate.omitted) QB.UIPort.toast('批注总量超限，已按确认省略批注导出（本机批注不变）', 'err');

    let built;
    try {
      built = await buildAsync(formatId, payload);
    } catch (e) {
      QB.UIPort.toast('导出失败：' + e.message, 'err');
      return null;
    }
    const filename = F.safeName(opts.bank.name) + '-' + def.label + '-' + payload.entries.length + unit + '-' + F.stamp() + '.' + built.ext;
    download(filename, built.mime, built.content);
    const imgNote = built.assetCount ? '，含图片 ' + built.assetCount + ' 张' : '';
    QB.UIPort.toast('已导出' + def.label + ' ' + payload.entries.length + ' ' + unit + '（' + formatId.toUpperCase() + imgNote + '）',
      built.missing ? 'err' : 'ok');
    if (built.missing) QB.UIPort.toast('有 ' + built.missing + ' 张引用图片缺失（未找到本地资产），仅导出占位标记', 'err');
    return { kind: opts.kind, format: formatId, count: payload.entries.length, filename: filename, assetCount: built.assetCount };
  }

  /**
   * 分发题包信息弹窗：版本/作者/描述
   * @param {'download'|'share'} [mode] share 模式只生成回链/分享码，不下载
   * @returns null（取消）或 {preview:true} 或 {version, author, description}
   */
  function askPackageInfo(bank, count, returnFocusTo, mode) {
    const share = mode === 'share';
    return new Promise((resolve) => {
      QB.UIPort.openModal(
        '<h3>' + (share ? '分享题包 · ' : '导出分发题包 · ') + QB.escapeHtml(bank.name) + '</h3>' +
        '<p class="li-meta">' + (share
          ? '生成自包含 .qbk 并转成 #share 回链 / 粘贴码，对方离线导入（无账号、不访问服务器）。'
          : '分发包在 .qbk 内附加 manifest.json（题包 id / 版本 / 题数 / 内容校验和），' +
            '对方导入时会核对清单与校验和。') + '共 ' + count + ' 题，含图片一并打包。</p>' +
        '<div class="qe-grid"><div><label class="qe-label">版本</label>' +
        '<input id="pkg-version" value="1.0.0" placeholder="如 1.0.0" /></div>' +
        '<div><label class="qe-label">作者（可选）</label><input id="pkg-author" placeholder="留空则不署名" /></div></div>' +
        '<label class="qe-label">描述（可选）</label>' +
        '<input id="pkg-desc" value="' + QB.escapeHtml(bank.description || '') + '" />' +
        '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
        (share ? '' : '<button class="btn btn-ghost" data-action="pkg-preview">只读预览</button>') +
        '<button class="btn" data-action="modal-ok">' + (share ? '生成分享链接/码' : '导出题包') + '</button></div>',
        (modal) => {
          const readInfo = () => ({
            version: (modal.querySelector('#pkg-version').value || '').trim() || '1.0.0',
            author: (modal.querySelector('#pkg-author').value || '').trim(),
            description: (modal.querySelector('#pkg-desc').value || '').trim()
          });
          modal.querySelector('[data-action="modal-cancel"]').onclick = () => { QB.UIPort.closeModal(); resolve(null); };
          const preview = modal.querySelector('[data-action="pkg-preview"]');
          if (preview) preview.onclick = () => { QB.UIPort.closeModal(); resolve({ preview: true }); };
          modal.querySelector('[data-action="modal-ok"]').onclick = () => { QB.UIPort.closeModal(); resolve(readInfo()); };
        },
        undefined,
        returnFocusTo
      );
    });
  }

  /** 只读预览：复用分享页（自包含 HTML，不联网、不上传），在新标签页打开 */
  async function openPreview(payload) {
    if (!QB.SharePage) { QB.UIPort.toast('分享页模块未加载', 'err'); return false; }
    let html;
    try {
      const built = await QB.SharePage.build(payload);
      // build() 契约为 { content, ext, mime, ... }；Blob 只能接收 HTML 字符串
      html = built && typeof built === 'object' ? built.content : built;
    } catch (e) {
      QB.UIPort.toast('预览生成失败：' + e.message, 'err');
      return false;
    }
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const win = window.open(url, '_blank');
    if (!win) {
      URL.revokeObjectURL(url);
      QB.UIPort.toast('浏览器拦截了新窗口，请允许本站弹窗后重试', 'err');
      return false;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  }

  /**
   * 分发公共步骤：收集 → 填题包信息 → 构建 qbk（distribute:true，含 manifest.json）
   * distributeFlow 与 shareFlow 共用，禁止各自复制一套 collect/buildAsync。
   * @param {'download'|'share'} [mode]
   * @returns null | {preview:true,payload} | {payload,info,built}
   */
  async function prepareDistribution(kind, bank, trigger, mode) {
    const def = KINDS[kind];
    if (!def) { QB.UIPort.toast('不支持的导出对象', 'err'); return null; }
    if (!bank) { QB.UIPort.toast('请先选择题库', 'err'); return null; }

    let payload;
    try {
      payload = await collect(kind, bank);
    } catch (e) {
      QB.UIPort.toast('导出失败：' + e.message, 'err');
      return null;
    }
    if (!payload.entries.length) { QB.UIPort.toast(def.label + '为空，无可导出内容', 'err'); return null; }

    // C026：分发题包 / 分享页都携带批注 → 同样先确认（超限时不含批注继续或取消）
    const gate = await ensureAnnotationBudget('qbk', payload);
    if (!gate.ok) {
      QB.UIPort.toast('已取消导出：批注总量超限，请先删减批注后重试', 'err');
      return null;
    }
    payload = gate.payload;
    if (gate.omitted) QB.UIPort.toast('批注总量超限，已按确认省略批注导出（本机批注不变）', 'err');

    const info = await askPackageInfo(bank, payload.entries.length, trigger, mode);
    if (!info) return null;
    if (info.preview) return { preview: true, payload };

    try {
      const built = await buildAsync('qbk', payload, {
        distribute: true,
        version: info.version,
        author: info.author,
        description: info.description
      });
      return { payload, info, built };
    } catch (e) {
      QB.UIPort.toast('导出失败：' + e.message, 'err');
      return null;
    }
  }

  /**
   * 分发题包流程：收集 → 填题包信息 → 构建（含 manifest.json）→ 下载；也可只生成只读预览
   * @param {{bank:Object, kind?:string}} opts
   */
  async function distributeFlow(opts) {
    const prep = await prepareDistribution((opts && opts.kind) || 'bank', opts && opts.bank, opts && opts.trigger, 'download');
    if (!prep) return null;
    if (prep.preview) {
      await openPreview(prep.payload);
      return { preview: true };
    }
    const { payload, info, built } = prep;
    const filename = F.packageFilename(opts.bank.name, info.version, payload.entries.length);
    download(filename, built.mime, built.content);
    const kb = (built.content.byteLength / 1024).toFixed(1);
    const imgNote = built.assetCount ? '，含图片 ' + built.assetCount + ' 张' : '';
    QB.UIPort.toast('已导出分发题包 v' + info.version + '（' + payload.entries.length + ' 题' + imgNote + '，' + kb + ' KB）',
      built.missing ? 'err' : 'ok');
    if (built.missing) QB.UIPort.toast('有 ' + built.missing + ' 张引用图片缺失（未找到本地资产），仅导出占位标记', 'err');
    return {
      kind: 'package', format: 'qbk', count: payload.entries.length, filename: filename,
      bytes: built.content.byteLength, assetCount: built.assetCount, manifest: built.manifest
    };
  }

  /** 复制到剪贴板：成功返回 true；不可用/被拒返回 false（由调用方降级为手动复制） */
  async function copyText(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(String(text || ''));
        return true;
      }
    } catch (e) { /* 用户拒绝或非安全上下文，走手动复制 */ }
    return false;
  }

  /** 分享结果弹窗：manifest（packageId/version/checksum）+ 回链 + 粘贴码，双形态可复制 */
  function showShareOptions(bank, prep, code, link, tooLong, returnFocusTo) {
    const esc = QB.escapeHtml;
    const m = prep.built.manifest || {};
    const count = prep.payload.entries.length;
    const kb = (prep.built.content.byteLength / 1024).toFixed(1);
    const imgNote = prep.built.assetCount ? '，含图片 ' + prep.built.assetCount + ' 张' : '';
    QB.UIPort.openModal(
      '<h3>分享题包 · ' + esc(bank.name) + '</h3>' +
      '<p class="li-meta">已生成自包含 .qbk（' + count + ' 题' + imgNote + '，' + kb + ' KB）。' +
      '对方打开回链或粘贴分享码即可离线导入：无账号、不访问服务器。</p>' +
      '<p class="li-meta">题包 <code>' + esc(m.packageId || '') + '</code> · v' + esc(m.version || '') +
      ' · 校验和 <code>' + esc(m.checksum || '') + '</code></p>' +
      (tooLong
        ? '<p class="li-meta">回链 ' + link.length + ' 字符，超过聊天软件常见上限；建议优先发送下方「分享码」。</p>'
        : '') +
      '<label class="qe-label">回链（#share= 片段）</label>' +
      '<textarea id="share-link" readonly rows="3" class="share-box">' + esc(link) + '</textarea>' +
      '<div class="toolbar"><button class="btn btn-sm btn-ghost" data-action="share-copy" data-copy="share-link">复制回链</button></div>' +
      '<label class="qe-label">分享码（粘贴导入）</label>' +
      '<textarea id="share-code" readonly rows="4" class="share-box">' + esc(code) + '</textarea>' +
      '<div class="toolbar"><button class="btn btn-sm btn-ghost" data-action="share-copy" data-copy="share-code">复制分享码</button></div>' +
      '<div class="modal-actions"><button class="btn" data-action="modal-ok">完成</button></div>',
      (modal) => {
        modal.querySelectorAll('[data-action="share-copy"]').forEach((btn) => {
          btn.onclick = async () => {
            const target = modal.querySelector('#' + btn.getAttribute('data-copy'));
            const text = target ? target.value : '';
            if (await copyText(text)) {
              btn.textContent = '已复制';
              QB.UIPort.toast('已复制到剪贴板', 'ok');
            } else if (target) {
              target.focus();
              target.select();
              QB.UIPort.toast('请手动复制（Ctrl+C）', 'ok');
            }
          };
        });
        modal.querySelector('[data-action="modal-ok"]').onclick = () => QB.UIPort.closeModal();
      },
      undefined,
      returnFocusTo
    );
  }

  /**
   * 分享流程：与分发共用 prepareDistribution，构建后不下载，改为生成 #share 回链 + 粘贴码
   * R-19：编码（Base64 约 1.33× 放大）之前先用字节数精确估算回链字符数；
   * 超软阈值先确认，取消则不编码、不构建大字符串。
   * @param {{bank:Object, kind?:string}} opts
   */
  async function shareFlow(opts) {
    if (!QB.ShareLink) { QB.UIPort.toast('分享码模块未加载', 'err'); return null; }
    const prep = await prepareDistribution((opts && opts.kind) || 'bank', opts && opts.bank, opts && opts.trigger, 'share');
    if (!prep) return null;
    if (prep.preview) { await openPreview(prep.payload); return { preview: true }; }

    const base = (typeof location !== 'undefined' && location.href) ? location.href : '';
    const softLimit = (QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.SHARE_URL_SOFT_LIMIT) || 64 * 1024;
    const estimatedChars = QB.ShareLink.estimateChars(prep.built.content.byteLength) +
      QB.ShareLink.buildLink(base, '').length;
    if (estimatedChars > softLimit) {
      const go = await QB.UIPort.confirm(
        '预计分享回链 ' + estimatedChars + ' 字符，超过分享链接上限 ' + softLimit + ' 字符（' +
        (prep.built.content.byteLength / 1024).toFixed(1) + ' KB 题包经 Base64 约放大 1.33 倍）。' +
        '继续将生成完整回链，对方可能无法直接打开；建议改为只发送分享码或导出分发题包文件。',
        '继续生成'
      );
      if (!go) {
        QB.UIPort.toast('已取消分享（题包过大，建议导出分发题包文件）', 'info');
        return null;
      }
    }

    const code = QB.ShareLink.encode(prep.built.content);
    const link = QB.ShareLink.buildLink(base, code);
    const tooLong = link.length > softLimit;
    showShareOptions(opts.bank, prep, code, link, tooLong, opts && opts.trigger);
    return {
      kind: 'share', format: 'qbk', count: prep.payload.entries.length,
      bytes: prep.built.content.byteLength, assetCount: prep.built.assetCount,
      code: code, link: link, tooLong: tooLong, estimatedChars: estimatedChars,
      manifest: prep.built.manifest
    };
  }

  QB.Exporters = {
    KINDS, FORMATS: F.FORMATS, collect, buildContent, buildAsync, openFlow, download,
    ensureAnnotationBudget,
    distributeFlow, shareFlow, openPreview,
    _toPlain: F.toPlain, _toTable: F.toTable, _toDocLines: F.toDocLines, _historyToTable: F.historyToTable,
    _packageFilename: F.packageFilename
  };
})(window);
