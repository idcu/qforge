/**
 * 导入编排（公共抽象）
 * 四个入口共用同一「解析 → 预览校验 → insertMany 落库」流程：
 *   - importFlow：选择文件
 *   - importFile：拖拽得到的 File
 *   - importTextFlow：剪贴板粘贴文本（虚拟文件名走 registry/sniff；JSON→.txt(Quizlet/CSV)→Markdown 回退）
 *   - importUrlFlow / refreshUrlFlow：网络地址（快照）
 * 四个入口解析一律经 QB.Importers.runImport（粘贴入口不维护第二条解析链），落库复用 QuestionRepo.insertMany。
 * 导出统一走 js/modules/exporter.js（QB.Exporters）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const UI = QB.UIRenderer;

  const ACCEPT = '.json,.csv,.tsv,.txt,.md,.markdown,.xlsx,.docx,.qbk,.apkg,.quizlet';

  function pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = ACCEPT;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = () => {
        const file = input.files && input.files[0] ? input.files[0] : null;
        document.body.removeChild(input);
        resolve(file);
      };
      input.click();
    });
  }

  /**
   * 导入预览
   * @param {string|null} [presetMode] 预选落库方式（G4 重复题包交互选定后带入）：'overwrite' 或 'merge'
   */
  function showPreview(bank, result, presetMode, returnFocusTo) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (settled) return; settled = true; resolve(value); };
      const stats = result.stats || { byType: {} };
      const rows = QB.CONFIG.TYPES.map((t) =>
        '<tr><td>' + QB.typeLabel(t) + '</td><td>' + (stats.byType[t] || 0) + '</td></tr>').join('');

      // 迁移桥接摘要：把「note→card / 多卡历史 / cloze 语义」的丢失项放在预览顶部，而不是只埋在警告里
      const mig = result.meta && result.meta.migration;
      let migHtml = '';
      if (mig && mig.source === 'anki' && mig.stats) {
        const s = mig.stats;
        const media = mig.media || {};
        migHtml = '<div class="section-title">Anki 迁移摘要</div><div class="li-meta">' +
          'note ' + s.notes + ' / card ' + s.cards + ' · 导入 ' + s.imported +
          ' · 跳过空题 ' + s.skippedEmpty + ' / 重复 ' + s.skippedDuplicate +
          ' · 多卡丢失 ' + s.lostCards + ' · cloze ' + s.clozeNotes +
          ' · 媒体 ' + (media.stored || 0) + '（缺失 ' + (media.missing || 0) + '，非图片 ' + (media.nonImage || 0) + '）' +
          ' · revlog ' + s.revlog + ' 条未导入（调度历史不迁移）</div>';
      } else if (mig && mig.source === 'quizlet' && mig.stats) {
        const s = mig.stats;
        migHtml = '<div class="section-title">Quizlet 迁移摘要</div><div class="li-meta">' +
          '行 ' + s.rows + ' · 导入 ' + s.imported + ' · 表头 ' + s.skippedHeader +
          ' · 非两列 ' + s.skippedBad + ' · 空 term ' + s.skippedEmpty + ' · 重复 ' + s.skippedDuplicate +
          ' · 全部为 essay（无选项/图片/在线进度）</div>';
      }

      const warnHtml = result.warnings && result.warnings.length
        ? '<div class="section-title">校验提示（' + result.warnings.length + '）</div>' +
          '<ul class="warn-list">' + result.warnings.slice(0, 50).map((w) => '<li>' + QB.escapeHtml(w) + '</li>').join('') +
          (result.warnings.length > 50 ? '<div class="li-meta">… 其余省略</div>' : '')
        : '<div class="li-meta" style="margin-top:10px">未发现明显问题。</div>';

      UI.openModal(
        '<h3>导入预览</h3>' +
        '<div class="li-meta">目标题库：' + QB.escapeHtml(bank.name) + '　格式：' + QB.escapeHtml(result.format) + '</div>' +
        UI.renderImportChecksum(result.meta) +
        migHtml +
        '<table class="preview-table"><thead><tr><th>题型</th><th>数量</th></tr></thead>' +
        '<tbody>' + rows +
        '<tr><td><b>合计</b></td><td><b>' + (stats.total || 0) + '</b></td></tr>' +
        '<tr><td>文件内重复</td><td>' + (stats.inFileDuplicates || 0) + '</td></tr>' +
        '</tbody></table>' +
        warnHtml +
        '<div class="checkbox-row"><input type="radio" id="mode-merge" name="imp-mode" value="merge"' +
        (presetMode === 'overwrite' ? '' : ' checked') + '>' +
        '<label for="mode-merge">合并（保留已有题目，跳过重复）</label></div>' +
        '<div class="checkbox-row"><input type="radio" id="mode-over" name="imp-mode" value="overwrite"' +
        (presetMode === 'overwrite' ? ' checked' : '') + '>' +
        '<label for="mode-over">覆盖（清空该题库后写入）</label></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
        '<button class="btn" data-action="modal-ok">导入</button></div>',
        (modal) => {
          modal.querySelector('[data-action="modal-cancel"]').onclick = () => { finish(null); UI.closeModal(); };
          modal.querySelector('[data-action="modal-ok"]').onclick = () => {
            const mode = modal.querySelector('#mode-over').checked ? 'overwrite' : 'merge';
            finish({ mode: mode });
            UI.closeModal();
          };
        },
        () => finish(null),
        returnFocusTo
      );
    });
  }

  /**
   * G4：同一题包 id+版本重复导入的显式交互 → 'skip' | 'merge' | 'overwrite'
   * Esc 语义与「跳过」一致（不写入任何题目）：弹窗被 UI.closeModal 关闭时通过 onClose 收口，
   * 保证 Promise 一定有终态，导入流程不会悬挂。
   */
  function askDuplicate(manifest, prev, returnFocusTo) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (settled) return; settled = true; resolve(value); };
      UI.openModal(
        '<h3>该题包已导入过</h3>' +
        '<div class="li-meta">题包 <b>' + QB.escapeHtml(manifest.title || '未命名') + '</b> v' +
        QB.escapeHtml(manifest.version || '') + '（id ' + QB.escapeHtml(manifest.packageId) + '）此前已导入本库' +
        (prev && prev.at ? '（' + QB.Helpers.formatDate(prev.at) + '）' : '') + '。</div>' +
        '<div class="li-meta">请选择处理方式：<br>· <b>跳过</b>：不写入任何题目<br>' +
        '· <b>并存</b>：合并导入，已存在题目按 contentHash 跳过<br>' +
        '· <b>覆盖</b>：清空本库现有题目后写入该题包</div>' +
        '<div class="modal-actions">' +
        '<button class="btn btn-ghost" data-action="dup-skip">跳过</button>' +
        '<button class="btn btn-ghost" data-action="dup-merge">并存</button>' +
        '<button class="btn" data-action="dup-over">覆盖</button></div>',
        (modal) => {
          // 先结算再关闭：closeModal 会触发 onClose（Esc 语义），已被 settle 防重
          const pick = (value) => () => { finish(value); UI.closeModal(); };
          modal.querySelector('[data-action="dup-skip"]').onclick = pick('skip');
          modal.querySelector('[data-action="dup-merge"]').onclick = pick('merge');
          modal.querySelector('[data-action="dup-over"]').onclick = pick('overwrite');
        },
        () => finish('skip'),
        returnFocusTo
      );
    });
  }

  /** 落库成功后更新题库来源（provenance） */
  async function stampSource(bank, source) {
    try {
      const updated = await QB.DB.banks.update(bank.id, { source: source }, { baseUpdatedAt: bank.updatedAt });
      bank.source = source;
      if (updated && updated.updatedAt) bank.updatedAt = updated.updatedAt;
    } catch (e) { /* 来源记录失败（含并发冲突）不影响题目导入 */ }
  }

  /**
   * 0 题 / 拒绝导入的可读原因（唯一实现）：
   * 优先取致命 errors（如材料题 <2 小问，整包拒绝），再取 migration.supported=false 的拒绝原因，
   * 最后补首条 warning；相同/包含关系只保留更长的一条，避免重复。
   * 无任何原因时保持旧文案「未解析出任何题目」。
   */
  function importFailureText(result) {
    const errors = ((result && result.errors) || []).filter(Boolean).map((e) => String(e).trim());
    const firstError = errors.length ? errors[0] : '';
    const mig = result && result.meta && result.meta.migration;
    const reason = mig && mig.supported === false && mig.reason ? String(mig.reason).trim() : '';
    const warnings = ((result && result.warnings) || []).filter(Boolean).map((w) => String(w).trim());
    const first = warnings.length ? warnings[0] : '';
    const primary = firstError || reason;
    if (!primary && !first) return '未解析出任何题目';
    if (!primary) return first;
    if (!first) return primary;
    if (first.indexOf(primary) >= 0 || primary.indexOf(first) >= 0) return primary.length >= first.length ? primary : first;
    return primary + '\n' + first;
  }

  /** 0 题且原因可读时弹可停留错误弹窗；无原因时保留旧 toast（D2：拒绝原因不能被吞） */
  function showImportFailure(result, returnFocusTo) {
    const text = importFailureText(result);
    if (text === '未解析出任何题目') { UI.toast(text, 'err'); return; }
    const rejected = ((result && result.errors) || []).length > 0;
    UI.openModal(
      '<h3>导入未完成</h3>' +
      '<div class="li-meta">' + (rejected ? '导入已被拒绝（未写入任何题目），原因如下：' : '没有可导入的题目，原因如下：') + '</div>' +
      '<div class="import-error" role="alert">' +
      QB.escapeHtml(text) + '</div>' +
      '<div class="modal-actions"><button class="btn" data-action="modal-ok">关闭</button></div>',
      (modal) => {
        const btn = modal.querySelector('[data-action="modal-ok"]');
        if (btn) btn.onclick = () => UI.closeModal();
      },
      undefined,
      returnFocusTo
    );
  }

  /** 来源弹窗内联展示 0 题原因（不关闭弹窗、不丢用户已输入内容） */
  function showInlineFailure(modal, result) {
    if (!modal || typeof document === 'undefined') return;
    let box = modal.querySelector('.import-error');
    if (!box) {
      box = document.createElement('div');
      box.className = 'import-error';
      box.setAttribute('role', 'alert');
      const actions = modal.querySelector('.modal-actions');
      if (actions && actions.parentNode) actions.parentNode.insertBefore(box, actions);
      else modal.appendChild(box);
    }
    const text = importFailureText(result);
    box.textContent = text;
    box.hidden = text === '未解析出任何题目';
  }

  /** 解析结果 → 预览 → 落库（文件/粘贴/拖拽/URL 共用）；source 为来源描述 */
  async function commitImport(bank, result, source, returnFocusTo) {
    // C015：致命校验错误（材料题 <2 小问）→ 整包拒绝，0 次写、不进入预览。
    // 必须先于「0 题」判断：此时 questions 可能非空（同包还有正常题），拒绝必须覆盖整包。
    if (result.errors && result.errors.length) {
      showImportFailure(result, returnFocusTo);
      return null;
    }
    if (!result.questions.length) {
      showImportFailure(result, returnFocusTo);
      return null;
    }
    // C026：单库批注总量预检（先于容量预检，避免被「存储空间不足」抢先、掩盖真正原因）。
    // 超限一律拒绝写入并给出可读处理方式，不静默截断/丢弃批注。
    const annotationCheck = QB.Annotation && QB.Annotation.checkTotal
      ? QB.Annotation.checkTotal(result.questions) : null;
    if (annotationCheck && !annotationCheck.ok) {
      showImportFailure({
        questions: [],
        errors: [QB.Annotation.overflowText(annotationCheck, '请删减批注后重试，或导入不含批注的版本；本次未写入任何题目。')]
      }, returnFocusTo);
      return null;
    }
    // G4：分发包重复导入识别（同 id+版本 → 显式选择；同 id 新版本 → 仅提示，按合并去重）
    const manifest = result.meta && result.meta.manifest;
    let presetMode = null;
    if (manifest) {
      const prevSame = QB.Package.findDuplicate(bank.id, manifest);
      if (prevSame) {
        const action = await askDuplicate(manifest, prevSame, returnFocusTo);
        if (!action || action === 'skip') {
          UI.toast('已跳过题包 v' + (manifest.version || ''), 'ok');
          return null;
        }
        presetMode = action;
      } else {
        const prevPkg = QB.Package.latestForPackage(bank.id, manifest.packageId);
        if (prevPkg) {
          UI.toast('题包 ' + (manifest.title || '') + ' 新版本 v' + (manifest.version || '') +
            '（已导入 v' + (prevPkg.version || '') + '），按合并去重导入');
        }
      }
    }
    // C006 容量预检：放不下就当场拒绝，不进入预览、不写任何键。
    // 预检只是闸门（按题 JSON 长度估算）；真正的保证在 insertMany 的落盘回读 + 回滚。
    if (QB.Quota && !QB.Quota.canFitQuestions(result.questions)) {
      const need = QB.Quota.estimateQuestions(result.questions);
      const remain = QB.Quota.remainingBytes();
      const limit = QB.Quota.limitBytes();
      showImportFailure({
        questions: [],
        warnings: ['存储空间不足：本次约需 ' + QB.Quota.formatBytes(need)
          + '，当前可用 ' + QB.Quota.formatBytes(remain)
          + '（已用 ' + QB.Quota.formatBytes(QB.Quota.usageBytes()) + ' / 上限 ' + QB.Quota.formatBytes(limit)
          + '）。请先导出备份并删除部分题库后重试。']
      }, returnFocusTo);
      return null;
    }
    const choice = await showPreview(bank, result, presetMode, returnFocusTo);
    if (!choice) return null;
    // C026：合并模式要算上库内已有批注（覆盖模式已在上方按本次题包单独判定）。
    // 保守口径：不扣除与已有题重复（会被跳过）的部分，宁可提前拒绝也不越限写入。
    if (choice.mode !== 'overwrite' && annotationCheck && annotationCheck.bytes > 0) {
      try {
        const existing = (await QB.DB.questions.list(bank.id, {})).items || [];
        const merged = QB.Annotation.checkTotal(existing.concat(result.questions));
        if (!merged.ok) {
          showImportFailure({
            questions: [],
            errors: [QB.Annotation.overflowText(merged, '合并后超出上限。请删减批注或改用「覆盖」导入；本次未写入任何题目。')]
          }, returnFocusTo);
          return null;
        }
      } catch (e) {
        // 读取失败不在这里阻断：真正的落盘失败仍由 insertMany 回滚 + 错误反馈兜底
      }
    }
    try {
      const res = await QB.DB.questions.insertMany(bank.id, result.questions, {
        dedupe: QB.CONFIG.DEDUPE_ON_IMPORT,
        mode: choice.mode
      });
      // 题目已落盘（insertMany 内已 flush + 回读校验）。来源/题包登记是**尽力而为**：
      // 它们失败不能把已成功的导入说成失败，更不能反向删题。
      if (source) await stampSource(bank, source);
      if (manifest) {
        try { QB.Package.recordImport(bank.id, manifest); } catch (e) {
          if (global.console) console.warn('[导入] 题包登记失败（不影响题目）：', e);
        }
      }
      UI.toast('导入完成：新增 ' + res.inserted + ' · 重复跳过 ' + res.duplicates + ' · 库内共 ' + res.total, 'ok');
      return res;
    } catch (e) {
      UI.toast('写入失败（已回滚到导入前状态）：' + e.message, 'err');
      return null;
    }
  }

  /** File 对象 → 解析（拖拽/选文件共用） */
  async function parseFile(file) {
    return QB.Importers.runImport(file);
  }

  /**
   * 分享码 / 回链 → runImport 结果（复用 qbk 导入器，不新建解析链）。
   * ShareLink.decode 只做字符集/前缀/字节上限校验；题包结构仍由 QbkImporter 统一校验。
   */
  async function parseShareCode(code) {
    if (!QB.ShareLink) throw new Error('分享码模块未加载');
    const arrayBuffer = QB.ShareLink.decode(code);
    return QB.Importers.runImport({ name: '分享码.qbk', arrayBuffer: arrayBuffer });
  }

  /**
   * 粘贴文本嗅探：不再维护第二条解析链，统一复用导入器注册表。
   *   0) C011：qfshare1: 分享码 / #share= 回链优先走 qbk 导入器；
   *   1) 以 { / [ 开头先按虚拟 .json 走 runImport（[材料题] 行式块在 JSON 语法失败时回退）；
   *   2) 再以虚拟 .txt 走 runImport，由 Quizlet（priority+sniff）接管两列 term/definition；
   *   3) 注册表无解析器接受（如 Markdown 标题行式）→ 回退 MdImporter，保持原行为。
   * 返回值一律为 runImport 形状（questions/warnings/format/stats/meta），调用方不得再次校验。
   */
  async function parsePastedText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('内容为空');
    // C011：分享码（qfshare1:…）或完整回链（…#share=…）优先走 qbk 导入器
    if (QB.ShareLink) {
      const shareCode = QB.ShareLink.extractCode(trimmed);
      if (shareCode) return parseShareCode(shareCode);
    }
    // 以 [ 开头的行式材料块（[材料题]）不能直接当 JSON；仅“JSON 语法失败”回退后续入口。
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      try {
        return await QB.Importers.runImport({ name: '粘贴.json', text: trimmed });
      } catch (e) {
        if (!/JSON 解析失败/.test(String(e && e.message))) throw e;
      }
    }
    let routed = null;
    try {
      routed = await QB.Importers.runImport({ name: '粘贴.txt', text: trimmed });
    } catch (e) {
      routed = null; // .txt 的 CSV 分支要求表头；不满足即视为未命中，交回 Markdown 行式解析
    }
    if (routed && routed.questions.length) return routed;
    const md = await QB.MdImporter.parse({ text: trimmed, fileName: '粘贴.md' });
    const validated = QB.Adapters.validateQuestions(md.questions || []);
    return {
      questions: md.questions || [],
      warnings: (md.warnings || []).concat(validated.warnings || []),
      errors: validated.errors || [],
      format: md.format || 'markdown',
      stats: validated.stats,
      meta: null
    };
  }

  /** 选择文件完整流程 */
  async function importFlow(bank, returnFocusTo) {
    if (!bank) { UI.toast('请先创建一个题库', 'err'); return null; }
    const file = await pickFile();
    if (!file) return null;
    return importFile(bank, file, undefined, returnFocusTo);
  }

  /** 指定 File 的完整流程（拖拽用，kind 区分选文件/拖拽） */
  async function importFile(bank, file, kind, returnFocusTo) {
    if (!bank) { UI.toast('请先创建一个题库', 'err'); return null; }
    UI.toast('正在解析 ' + file.name + ' …');
    let result;
    try {
      result = await parseFile(file);
    } catch (e) {
      UI.toast('导入失败：' + e.message, 'err');
      return null;
    }
    const source = QB.Source.makeSource(kind || QB.Source.KINDS.FILE, { uri: file.name || '' });
    return commitImport(bank, result, source, returnFocusTo);
  }

  /** 剪贴板粘贴导入（与文件/拖拽/URL 共用 registry 解析与 commitImport 落库） */
  function importTextFlow(bank, returnFocusTo) {
    if (!bank) { UI.toast('请先创建一个题库', 'err'); return null; }
    return new Promise((resolve) => {
      UI.openModal(
        '<h3>粘贴文本导入</h3>' +
        '<div class="li-meta">支持 JSON（标准结构/数组）、两列纯文本（Quizlet 的 term/definition，Tab/逗号/分号分隔均可），' +
        '或行式题目（格式同 Markdown：<code>1. 题干</code> / <code>A. 选项</code> / <code>答案：X</code> / <code>解析：…</code>）。</div>' +
        '<textarea id="paste-area" rows="12" style="width:100%;margin-top:8px" placeholder="把题目粘贴到这里…"></textarea>' +
        '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
        '<button class="btn" data-action="modal-ok">解析预览</button></div>',
        async (modal) => {
          modal.querySelector('[data-action="modal-cancel"]').onclick = () => { UI.closeModal(); resolve(null); };
          modal.querySelector('[data-action="modal-ok"]').onclick = async () => {
            const text = modal.querySelector('#paste-area').value;
            let parsed;
            try {
              parsed = await parsePastedText(text);
            } catch (e) {
              UI.toast('解析失败：' + e.message, 'err');
              return;
            }
            // 0 题：保留弹窗与已粘贴文本，就地显示拒绝原因（D2），不只提示「未解析出任何题目」
            if (!(parsed.questions || []).length) {
              showInlineFailure(modal, parsed);
              return;
            }
            UI.closeModal();
            resolve(await commitImport(bank, {
              questions: parsed.questions,
              warnings: parsed.warnings || [],
              format: '粘贴·' + (parsed.format || 'text'),
              stats: parsed.stats,
              meta: parsed.meta || null
            }, QB.Source.makeSource(QB.Source.KINDS.PASTE, { uri: '剪贴板' }), returnFocusTo));
          };
        },
        undefined,
        returnFocusTo
      );
    });
  }

  /** 网络地址导入弹窗（输入 URL → 拉取 → 同一预览流程） */
  function importUrlFlow(bank, presetUrl, returnFocusTo) {
    if (!bank) { UI.toast('请先创建一个题库', 'err'); return null; }
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      UI.toast('file:// 双击打开时网络导入受限，请用 GitHub Pages 或本地服务打开', 'err');
      return null;
    }
    return new Promise((resolve) => {
      UI.openModal(
        '<h3>从网络地址导入</h3>' +
        '<div class="li-meta">输入题目文件的 http(s) 直链（json / csv / tsv / txt(Quizlet) / md / xlsx / docx / qbk / apkg）。' +
        '远端文件作为快照保存到本地，可离线使用；服务器需允许跨域访问（CORS），否则请另存为文件后拖拽导入。上限 8MB。</div>' +
        '<input type="url" id="url-area" class="grow" style="width:100%;margin-top:8px" placeholder="https://example.com/questions.json" value="' +
        QB.escapeHtml(presetUrl || '') + '" />' +
        '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
        '<button class="btn" data-action="modal-ok">拉取并预览</button></div>',
        (modal) => {
          modal.querySelector('[data-action="modal-cancel"]').onclick = () => { UI.closeModal(); resolve(null); };
          modal.querySelector('[data-action="modal-ok"]').onclick = async () => {
            const url = modal.querySelector('#url-area').value;
            const checked = QB.Source.validateUrl(url);
            if (!checked.ok) { UI.toast(checked.reason, 'err'); return; }
            const btn = modal.querySelector('[data-action="modal-ok"]');
            btn.disabled = true; btn.textContent = '拉取中…';
            let snapshot;
            try {
              snapshot = await QB.Source.fetchSnapshot(url);
            } catch (e) {
              btn.disabled = false; btn.textContent = '拉取并预览';
              UI.toast('拉取失败：' + e.message, 'err');
              return;
            }
            let result;
            try {
              result = await QB.Importers.runImport({
                name: snapshot.name,
                text: snapshot.text,
                arrayBuffer: snapshot.arrayBuffer
              });
            } catch (e) {
              btn.disabled = false; btn.textContent = '拉取并预览';
              UI.toast('解析失败：' + e.message, 'err');
              return;
            }
            const source = QB.Source.makeSource(QB.Source.KINDS.URL, {
              uri: snapshot.url, fetchedAt: Date.now(), checksum: snapshot.checksum, refreshable: true
            });
            // 0 题：保留来源弹窗与 URL 输入，就地显示拒绝原因（D2），不再「先关闭再静默丢弃」
            if (!result.questions.length) {
              btn.disabled = false; btn.textContent = '拉取并预览';
              showInlineFailure(modal, result);
              return;
            }
            UI.closeModal();
            resolve(await commitImport(bank, result, source, returnFocusTo));
          };
        },
        undefined,
        returnFocusTo
      );
    });
  }

  /** 刷新 URL 来源：checksum 相同提示无更新，否则重新拉取并走预览（合并去重） */
  async function refreshUrlFlow(bank, returnFocusTo) {
    const src = bank && bank.source;
    if (!src || !src.refreshable || !src.uri) {
      UI.toast('该题库没有可刷新的网络来源', 'err');
      return null;
    }
    UI.toast('正在检查来源更新…');
    let snapshot;
    try {
      snapshot = await QB.Source.fetchSnapshot(src.uri);
    } catch (e) {
      UI.toast('刷新失败：' + e.message, 'err');
      return null;
    }
    if (snapshot.checksum === src.checksum) {
      UI.toast('来源内容无变化');
      return { unchanged: true };
    }
    let result;
    try {
      result = await QB.Importers.runImport({
        name: snapshot.name, text: snapshot.text, arrayBuffer: snapshot.arrayBuffer
      });
    } catch (e) {
      UI.toast('解析失败：' + e.message, 'err');
      return null;
    }
    const nextSource = QB.Source.makeSource(QB.Source.KINDS.URL, {
      uri: snapshot.url, fetchedAt: Date.now(), checksum: snapshot.checksum, refreshable: true
    });
    return commitImport(bank, result, nextSource, returnFocusTo);
  }

  QB.DataIO = {
    pickFile, importFlow, importFile, importTextFlow, importUrlFlow, refreshUrlFlow,
    parsePastedText, parseShareCode, parseFile, commitImport, stampSource,
    /** 0 题错误提示文案（纯函数；UI 与测试共用，避免两套文案） */
    importFailureText
  };
})(window);
