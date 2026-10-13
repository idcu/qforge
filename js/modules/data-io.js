/**
 * 数据导入编排
 * 导入：选文件 → 解析(registry) → 预览校验 → QuestionRepo.insertMany 落库（复用数据层，不重复实现落库）
 * 导出统一走 js/modules/exporter.js（QB.Exporters，注册表式多格式）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const UI = QB.UIRenderer;

  const ACCEPT = '.json,.csv,.tsv,.txt,.md,.markdown,.xlsx,.docx';

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
      let rows = QB.CONFIG.TYPES.map((t) =>
        '<tr><td>' + QB.typeLabel(t) + '</td><td>' + (stats.byType[t] || 0) + '</td></tr>').join('');

      const warnHtml = result.warnings && result.warnings.length
        ? '<div class="section-title">校验提示（' + result.warnings.length + '）</div>' +
          '<ul class="warn-list">' + result.warnings.slice(0, 50).map((w) => '<li>' + QB.escapeHtml(w) + '</li>').join('') + '</ul>' +
          (result.warnings.length > 50 ? '<div class="li-meta">… 其余省略</div>' : '')
        : '<div class="li-meta" style="margin-top:10px">未发现明显问题。</div>';

      UI.openModal(
        '<h3>导入预览</h3>' +
        '<div class="li-meta">目标题库：' + QB.escapeHtml(bank.name) + '　格式：' + QB.escapeHtml(result.format) + '</div>' +
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

  /**
   * 完整导入流程
   * @returns {Promise<{inserted,duplicates,skipped,total}|null>}
   */
  async function importFlow(bank) {
    if (!bank) { UI.toast('请先创建一个题库', 'err'); return null; }
    const file = await pickFile();
    if (!file) return null;

    UI.toast('正在解析 ' + file.name + ' …');
    let result;
    try {
      result = await QB.Importers.runImport(file);
    } catch (e) {
      UI.toast('导入失败：' + e.message, 'err');
      return null;
    }

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
      UI.toast('导入完成：新增 ' + res.inserted + ' · 重复跳过 ' + res.duplicates + ' · 库内共 ' + res.total, 'ok');
      return res;
    } catch (e) {
      UI.toast('写入失败：' + e.message, 'err');
      return null;
    }
  }

  QB.DataIO = { pickFile, importFlow };
})(window);