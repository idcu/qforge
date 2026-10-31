/**
 * 导入编排（公共抽象）
 * 三种入口共用同一「解析 → 预览校验 → insertMany 落库」流程：
 *   - importFlow：选择文件
 *   - importFile：拖拽得到的 File
 *   - importTextFlow：剪贴板粘贴文本（自动嗅探 JSON / Markdown-行式）
 * 解析走 registry / importers，落库复用 QuestionRepo.insertMany，本模块不重复实现。
 * 导出统一走 js/modules/exporter.js（QB.Exporters）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const UI = QB.UIRenderer;

  const ACCEPT = '.json,.csv,.tsv,.txt,.md,.markdown,.xlsx,.docx,.qbk';

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

  function showPreview(bank, result) {
    return new Promise((resolve) => {
      const stats = result.stats || { byType: {} };
      const rows = QB.CONFIG.TYPES.map((t) =>
        '<tr><td>' + QB.typeLabel(t) + '</td><td>' + (stats.byType[t] || 0) + '</td></tr>').join('');

      const warnHtml = result.warnings && result.warnings.length
        ? '<div class="section-title">校验提示（' + result.warnings.length + '）</div>' +
          '<ul class="warn-list">' + result.warnings.slice(0, 50).map((w) => '<li>' + QB.escapeHtml(w) + '</li>').join('') +
          (result.warnings.length > 50 ? '<div class="li-meta">… 其余省略</div>' : '')
        : '<div class="li-meta" style="margin-top:10px">未发现明显问题。</div>';

      UI.openModal(
        '<h3>导入预览</h3>' +
        '<div class="li-meta">目标题库：' + QB.escapeHtml(bank.name) + '　格式：' + QB.escapeHtml(result.format) + '</div>' +
        UI.renderImportChecksum(result.meta) +
        '<table class="preview-table"><thead><tr><th>题型</th><th>数量</th></tr></thead>' +
        '<tbody>' + rows +
        '<tr><td><b>合计</b></td><td><b>' + (stats.total || 0) + '</b></td></tr>' +
        '<tr><td>文件内重复</td><td>' + (stats.inFileDuplicates || 0) + '</td></tr>' +
        '</tbody></table>' +
        warnHtml +
        '<div class="checkbox-row"><input type="radio" id="mode-merge" name="imp-mode" value="merge" checked>' +
        '<label for="mode-merge">合并（保留已有题目，跳过重复）</label></div>' +
        '<div class="checkbox-row"><input type="radio" id="mode-over" name="imp-mode" value="overwrite">' +
        '<label for="mode-over">覆盖（清空该题库后写入）</label></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
        '<button class="btn" data-action="modal-ok">导入</button></div>',
        (modal) => {
          modal.querySelector('[data-action="modal-cancel"]').onclick = () => { UI.closeModal(); resolve(null); };
          modal.querySelector('[data-action="modal-ok"]').onclick = () => {
            const mode = modal.querySelector('#mode-over').checked ? 'overwrite' : 'merge';
            UI.closeModal();
            resolve({ mode: mode });
          };
        }
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

  /** 解析结果 → 预览 → 落库（文件/粘贴/拖拽/URL 共用）；source 为来源描述 */
  async function commitImport(bank, result, source) {
    if (!result.questions.length) {
      UI.toast('未解析出任何题目', 'err');
      return null;
    }
    const choice = await showPreview(bank, result);
    if (!choice) return null;
    try {
      const res = await QB.DB.questions.insertMany(bank.id, result.questions, {
        dedupe: QB.CONFIG.DEDUPE_ON_IMPORT,
        mode: choice.mode
      });
      if (source) await stampSource(bank, source);
      UI.toast('导入完成：新增 ' + res.inserted + ' · 重复跳过 ' + res.duplicates + ' · 库内共 ' + res.total, 'ok');
      return res;
    } catch (e) {
      UI.toast('写入失败：' + e.message, 'err');
      return null;
    }
  }

  /** File 对象 → 解析（拖拽/选文件共用） */
  async function parseFile(file) {
    return QB.Importers.runImport(file);
  }

  /** 粘贴文本嗅探：JSON 走 JsonImporter，其余按行式（Markdown/纯文本，LineParser 同源） */
  function parsePastedText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('内容为空');
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      return QB.JsonImporter.parse({ text: trimmed, fileName: '粘贴.json' });
    }
    return QB.MdImporter.parse({ text: trimmed, fileName: '粘贴.md' });
  }

  /** 选择文件完整流程 */
  async function importFlow(bank) {
    if (!bank) { UI.toast('请先创建一个题库', 'err'); return null; }
    const file = await pickFile();
    if (!file) return null;
    return importFile(bank, file);
  }

  /** 指定 File 的完整流程（拖拽用，kind 区分选文件/拖拽） */
  async function importFile(bank, file, kind) {
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
    return commitImport(bank, result, source);
  }

  /** 剪贴板粘贴导入 */
  function importTextFlow(bank) {
    if (!bank) { UI.toast('请先创建一个题库', 'err'); return null; }
    return new Promise((resolve) => {
      UI.openModal(
        '<h3>粘贴文本导入</h3>' +
        '<div class="li-meta">支持 JSON（标准结构/数组）或行式题目，格式同 Markdown 导入：' +
        '「<code>1. 题干</code> / <code>A. 选项</code> / <code>答案：X</code> / <code>解析：…</code> / <code>分类：…</code>」。</div>' +
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
            const validated = QB.Adapters.validateQuestions(parsed.questions || []);
            UI.closeModal();
            const res = await commitImport(bank, {
              questions: parsed.questions || [],
              warnings: (parsed.warnings || []).concat(validated.warnings || []),
              format: '粘贴·' + (parsed.format || 'text'),
              stats: validated.stats
            }, QB.Source.makeSource(QB.Source.KINDS.PASTE, { uri: '剪贴板' }));
            resolve(res);
          };
        }
      );
    });
  }

  /** 网络地址导入弹窗（输入 URL → 拉取 → 同一预览流程） */
  function importUrlFlow(bank, presetUrl) {
    if (!bank) { UI.toast('请先创建一个题库', 'err'); return null; }
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      UI.toast('file:// 双击打开时网络导入受限，请用 GitHub Pages 或本地服务打开', 'err');
      return null;
    }
    return new Promise((resolve) => {
      UI.openModal(
        '<h3>从网络地址导入</h3>' +
        '<div class="li-meta">输入题目文件的 http(s) 直链（json / csv / tsv / txt / md / xlsx / docx）。' +
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
            UI.closeModal();
            resolve(await commitImport(bank, result, source));
          };
        }
      );
    });
  }

  /** 刷新 URL 来源：checksum 相同提示无更新，否则重新拉取并走预览（合并去重） */
  async function refreshUrlFlow(bank) {
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
    return commitImport(bank, result, nextSource);
  }

  QB.DataIO = {
    pickFile, importFlow, importFile, importTextFlow, importUrlFlow, refreshUrlFlow,
    parsePastedText, parseFile, commitImport, stampSource
  };
})(window);
