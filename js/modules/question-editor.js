/**
 * 题目编辑器（本期：接口对接 + UI 入口预留）
 * 数据层契约（QuestionRepository）已完整实现并在此对接；题目增删改查的交互界面
 * 计划于后续版本提供，届时直接复用以下方法，无需改动数据层。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  QB.QuestionEditor = {
    /** 新增单题（接口已就绪） */
    create(bankId, question) {
      return QB.DB.questions.create(bankId, question);
    },

    /** 修改单题 */
    update(id, patch) {
      return QB.DB.questions.update(id, patch);
    },

    /** 删除单题 */
    remove(id) {
      return QB.DB.questions.remove(id);
    },

    /** 批量新增 */
    insertMany(bankId, questions, options) {
      return QB.DB.questions.insertMany(bankId, questions, options);
    },

    /** 批量删除 */
    removeMany(ids) {
      return QB.DB.questions.removeMany(ids);
    },

    /** UI 入口（预留）：说明当前版本状态 */
    openReservedDialog() {
      QB.UIRenderer.openModal(
        '<h3>题目管理</h3>' +
        '<p>逐题新增 / 修改 / 删除、批量新增 / 批量删除功能正在开发中，将在后续版本提供。</p>' +
        '<p class="li-meta">数据层接口已完成对接（QuestionRepository），当前可通过「导入」批量写入题目。</p>' +
        '<div class="modal-actions"><button class="btn" data-action="modal-cancel">知道了</button></div>',
        (modal) => {
          modal.querySelector('[data-action="modal-cancel"]').onclick = () => QB.UIRenderer.closeModal();
        }
      );
    }
  };
})(window);