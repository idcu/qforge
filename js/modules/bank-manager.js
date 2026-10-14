/**
 * 多题库管理：新建 / 重命名 / 删除（级联）/ 导入示例
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const UI = QB.UIRenderer;

  QB.BankManager = {
    /** 新建题库（弹窗表单） */
    create() {
      return new Promise((resolve) => {
        UI.openModal(
          '<h3>新建题库</h3>' +
          '<div class="field"><label>题库名称</label><input id="bk-name" type="text" placeholder="例如：物业管理知识题库" /></div>' +
          '<div class="field"><label>分类（可选）</label><input id="bk-cat" type="text" placeholder="例如：物业" /></div>' +
          '<div class="field"><label>描述（可选）</label><textarea id="bk-desc" placeholder="简要说明"></textarea></div>' +
          '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
          '<button class="btn" data-action="modal-ok">创建</button></div>',
          (modal) => {
            const nameEl = modal.querySelector('#bk-name');
            nameEl.focus();
            modal.querySelector('[data-action="modal-cancel"]').onclick = () => { UI.closeModal(); resolve(null); };
            const ok = async () => {
              const name = nameEl.value.trim();
              if (!name) { UI.toast('请填写题库名称', 'err'); return; }
              const bank = await QB.DB.banks.create({
                name: name,
                category: modal.querySelector('#bk-cat').value.trim(),
                description: modal.querySelector('#bk-desc').value.trim()
              });
              UI.closeModal();
              UI.toast('题库已创建', 'ok');
              resolve(bank);
            };
            modal.querySelector('[data-action="modal-ok"]').onclick = ok;
            nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
          }
        );
      });
    },

    /** 重命名 */
    rename(bank) {
      return new Promise((resolve) => {
        UI.openModal(
          '<h3>重命名题库</h3>' +
          '<div class="field"><label>题库名称</label><input id="bk-name" type="text" value="' + QB.escapeHtml(bank.name) + '" /></div>' +
          '<div class="field"><label>描述</label><textarea id="bk-desc">' + QB.escapeHtml(bank.description || '') + '</textarea></div>' +
          '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
          '<button class="btn" data-action="modal-ok">保存</button></div>',
          (modal) => {
            const nameEl = modal.querySelector('#bk-name');
            nameEl.focus();
            modal.querySelector('[data-action="modal-cancel"]').onclick = () => { UI.closeModal(); resolve(null); };
            modal.querySelector('[data-action="modal-ok"]').onclick = async () => {
              const name = nameEl.value.trim();
              if (!name) { UI.toast('题库名称不能为空', 'err'); return; }
              const updated = await QB.DB.banks.update(bank.id, {
                name: name,
                description: modal.querySelector('#bk-desc').value.trim()
              });
              UI.closeModal();
              UI.toast('已保存', 'ok');
              resolve(updated);
            };
          }
        );
      });
    },

    /** 删除（级联删除题目与用户数据） */
    async remove(bank) {
      const ok = await UI.confirmDialog(
        '确定删除题库「' + bank.name + '」吗？该题库下的题目、复习计划、错题、收藏、该题库训练权重及历史记录都会被一并删除，且不可恢复。',
        '删除'
      );
      if (!ok) return false;
      await QB.DB.banks.remove(bank.id, { cascade: true });
      UI.toast('题库已删除', 'ok');
      return true;
    },

    /** 导入内置示例题目 */
    async importSample(bankId) {
      const res = await QB.DB.questions.insertMany(bankId, QB.SAMPLE.questions, { dedupe: true });
      UI.toast('已导入示例题目：新增 ' + res.inserted + '，重复 ' + res.duplicates, 'ok');
      return res;
    }
  };
})(window);