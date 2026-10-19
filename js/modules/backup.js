/**
 * 全量备份 / 恢复（跨设备、跨浏览器迁移本地数据）
 * 纯函数 buildBackup/applyBackup 不依赖 DOM（可单测）；openFlow 负责文件下载/选择。
 * 备份内容：Storage 中以应用前缀开头的全部逻辑键（题库、题目、错题、收藏、SRS、历史、偏好）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const MAGIC = 'qforge-backup';

  /**
   * 敏感字段脱敏（备份可安全分享/外发/上云）：当前覆盖 meta:dav.pass（WebDAV 密码）。
   * 纯函数、不改输入；非密字段（地址/账号/上次同步信息）保留，恢复后需重填密码。
   */
  function redactSecrets(data) {
    const out = {};
    Object.keys(data).forEach((k) => {
      const v = data[k];
      if (k === QB.KEYS.metaDav && v && typeof v === 'object' && !Array.isArray(v)) {
        const copy = Object.assign({}, v);
        delete copy.pass;
        out[k] = copy;
      } else {
        out[k] = v;
      }
    });
    return out;
  }

  /** 读取全部应用数据键 → {key: value}（唯一实现：buildBackup 与数据层 backup.export 共用） */
  function readAllData() {
    QB.Storage.forceSync(); // 确保防抖写入的数据已落盘
    const data = {};
    QB.Storage.keys().forEach((k) => { data[k] = QB.Storage.get(k); });
    return data;
  }

  /** 读取全部应用数据 → 备份对象（值为已解析的 JS 对象；敏感密码已脱敏） */
  function buildBackup(now) {
    return {
      app: MAGIC,
      version: QB.CONFIG.VERSION,
      exportedAt: new Date(now == null ? Date.now() : now).toISOString(),
      data: redactSecrets(readAllData())
    };
  }

  function isBackup(obj) {
    return obj && typeof obj === 'object' && obj.app === MAGIC && obj.data && typeof obj.data === 'object';
  }

  /**
   * 恢复「数据载荷」（不含 app/version 外壳）。**唯一实现**：applyBackup 与数据层 backup.import 共用。
   * @param {Object} data 逻辑键 → 值
   * @param {'replace'|'merge'} mode
   *   replace（默认）= 先内存快照旧数据，全量写入成功后再删除载荷中不存在的旧键，
   *     任一步失败尽力回滚到快照后抛出（不再先删后写、失败即全丢）；
   *   merge = 同名逻辑键覆盖（保留其余现有数据）。
   * @returns {{keys:number, mode:string}}
   */
  function applyData(data, mode) {
    data = data || {};
    const m = mode === 'merge' ? 'merge' : 'replace';

    if (m === 'merge') {
      Object.keys(data).forEach((k) => QB.Storage.set(k, data[k]));
      QB.Storage.forceSync();
      return { keys: Object.keys(data).length, mode: m };
    }

    const oldKeys = QB.Storage.keys();
    const snapshot = oldKeys.map((k) => [k, QB.Storage.get(k)]);
    const written = [];
    try {
      Object.keys(data).forEach((k) => {
        QB.Storage.set(k, data[k]);
        written.push(k);
      });
      QB.Storage.forceSync();
      oldKeys.filter((k) => !Object.prototype.hasOwnProperty.call(data, k))
        .forEach((k) => QB.Storage.remove(k));
      QB.Storage.forceSync();
    } catch (e) {
      console.error('[Backup] 恢复失败，尝试回滚到恢复前快照：', e);
      try {
        written.forEach((k) => {
          const old = snapshot.find((pair) => pair[0] === k);
          if (old) QB.Storage.set(k, old[1]);
          else QB.Storage.remove(k);
        });
        QB.Storage.forceSync();
      } catch (rollbackErr) {
        console.error('[Backup] 回滚也失败：', rollbackErr);
      }
      throw e;
    }
    return { keys: Object.keys(data).length, mode: m };
  }

  /**
   * 恢复备份（含外壳校验）
   * @param {Object} backup 备份对象
   * @param {{mode?:'replace'|'merge'}} opts
   * @returns {{keys:number, mode:string}}
   */
  function applyBackup(backup, opts) {
    if (!isBackup(backup)) throw new Error('不是有效的 qforge 备份文件');
    return applyData(backup.data, (opts || {}).mode);
  }

  /* ---------------- 含图片资产的备份包（.qfbk：backup.json + assets/*） ---------------- */

  /** 扫描全部题库的题目，返回被引用的资产 id 集合 */
  async function globallyReferencedAssetIds() {
    const ids = [];
    const banks = await QB.DB.banks.list();
    for (const bank of banks) {
      const { items } = await QB.DB.questions.list(bank.id, {});
      QB.Qbk.referencedIds(items).forEach((id) => { if (ids.indexOf(id) < 0) ids.push(id); });
    }
    return ids;
  }

  /**
   * 有图片资产时打 ZIP 包；无资产返回 null（调用方走纯 JSON 旧路径，保持兼容）
   * @returns {Promise<{content:ArrayBuffer, assetCount:number}|null>}
   */
  async function buildAssetBundle() {
    QB.Storage.forceSync();
    const assets = await QB.Assets.allEntries();
    if (!assets.length) return null;
    const payload = buildBackup();
    return {
      content: QB.Qbk.buildBundle('backup.json', JSON.stringify(payload, null, 2), assets),
      assetCount: assets.length
    };
  }

  /** 恢复备份包中的资产：replace 先清空 IDB，merge 仅覆盖写入 */
  async function restoreAssets(assets, mode) {
    if (mode === 'replace') await QB.Assets.clear();
    await QB.Assets.putEntries(assets);
    return assets.length;
  }

  /** 解析备份文件：自动识别 ZIP 包（PK 头）或 JSON */
  async function parseBackupFile(buffer) {
    const bytes = new Uint8Array(buffer);
    if (QB.Qbk.isZipBytes(bytes)) {
      const bundle = await QB.Qbk.parseBundle(buffer, { jsonName: 'backup.json' });
      return { backup: JSON.parse(bundle.text), assets: bundle.assets };
    }
    const text = QB.decodeUtf8(bytes);
    return { backup: JSON.parse(text), assets: [] };
  }

  /* ---------------- 浏览器外壳 ---------------- */

  async function download(filename) {
    const bundle = await buildAssetBundle();
    let blob, name;
    if (bundle) {
      blob = new Blob([bundle.content], { type: 'application/zip' });
      name = filename || ('qforge-backup-' + new Date().toISOString().slice(0, 10) + '.qfbk');
    } else {
      const payload = buildBackup();
      blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      name = filename || ('qforge-backup-' + new Date().toISOString().slice(0, 10) + '.json');
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { filename: name, assetCount: bundle ? bundle.assetCount : 0 };
  }

  /** 恢复确认弹窗（文件恢复与 WebDAV 恢复共用） */
  function confirmRestore(parsed) {
    return new Promise((resolve, reject) => {
      try {
        const backup = parsed.backup;
        const used = QB.Storage.usageBytes();
        const keys = Object.keys(backup.data || {});
        QB.UIRenderer.openModal(
          '<h3>恢复备份</h3>' +
          '<p>备份包含 <b>' + keys.length + '</b> 个数据键' +
          (parsed.assets.length ? '、<b>' + parsed.assets.length + '</b> 张图片' : '') +
          '，导出时间：' +
          QB.Helpers.escapeHtml(backup.exportedAt || '未知') +
          (parsed.source ? '<br>来源：' + QB.Helpers.escapeHtml(parsed.source) : '') + '</p>' +
          '<div class="checkbox-row"><input type="radio" name="bk-mode" id="bk-replace" value="replace" checked>' +
          '<label for="bk-replace">覆盖恢复（清空现有全部数据后写入，推荐）</label></div>' +
          '<div class="checkbox-row"><input type="radio" name="bk-mode" id="bk-merge" value="merge">' +
          '<label for="bk-merge">合并恢复（同名键覆盖，保留其余现有数据与图片）</label></div>' +
          '<p class="li-meta">当前已用约 ' + Math.round(used / 1024) + ' KB。恢复后建议刷新页面。</p>' +
          '<div class="modal-actions"><button class="btn btn-ghost" data-bk="cancel">取消</button>' +
          '<button class="btn btn-danger" data-bk="ok">确认恢复</button></div>',
          (modal) => {
            modal.querySelector('[data-bk="cancel"]').onclick = () => { QB.UIRenderer.closeModal(); resolve(null); };
            modal.querySelector('[data-bk="ok"]').onclick = async () => {
              const mode = modal.querySelector('#bk-merge').checked ? 'merge' : 'replace';
              try {
                const r = applyBackup(backup, { mode: mode });
                const imgCount = await restoreAssets(parsed.assets, mode);
                QB.UIRenderer.closeModal();
                QB.UIRenderer.toast('已恢复 ' + r.keys + ' 个数据键' + (imgCount ? '、' + imgCount + ' 张图片' : ''), 'ok');
                resolve({ keys: r.keys, mode: mode, assets: imgCount });
              } catch (e) {
                QB.UIRenderer.toast('恢复失败：' + e.message, 'err');
                reject(e);
              }
            };
          }
        );
      } catch (e) { reject(e); }
    });
  }

  function pickAndRestore() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.qfbk,application/json,application/zip';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            resolve(await confirmRestore(await parseBackupFile(reader.result)));
          } catch (e) { reject(e); }
        };
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsArrayBuffer(file);
      };
      document.body.appendChild(input);
      input.click();
      document.body.removeChild(input);
    });
  }

  /** 备份/恢复管理弹窗（含容量显示） */
  function openFlow() {
    const used = QB.Storage.usageBytes();
    const KB = Math.round(used / 1024);
    const warn = used > 4 * 1024 * 1024;
    QB.UIRenderer.openModal(
      '<h3>备份与恢复</h3>' +
      '<div class="card" style="margin:10px 0"><div class="li-meta">本地存储占用</div>' +
      '<div style="font-size:20px;font-weight:600;margin:4px 0">' + KB + ' KB' +
      (warn ? ' <span style="color:var(--warning);font-size:13px">（已超约 4MB，建议尽快备份并分库）</span>' : '') +
      '</div></div>' +
      '<p class="li-meta">备份包含全部题库、题目、错题、收藏、复习计划、历史记录、偏好与题目图片：无图时导出 .json，含图时自动打包为 .qfbk（ZIP）。可在另一台设备/浏览器恢复。</p>' +
      '<p class="li-meta" style="color:var(--text-light)">🔒 WebDAV 密码不会写入备份（地址/账号保留，恢复后需重新填写密码），备份文件可安全分享。</p>' +
      '<div class="modal-actions" style="justify-content:flex-start;flex-wrap:wrap">' +
      '<button class="btn" data-bk="export">下载全量备份</button>' +
      '<button class="btn btn-ghost" data-bk="import">从备份恢复</button>' +
      '<button class="btn btn-ghost" data-bk="dav">☁ WebDAV 云备份</button>' +
      '<button class="btn btn-ghost" data-bk="gc">清理未引用图片</button>' +
      '<button class="btn btn-ghost" data-bk="close">关闭</button></div>',
      (modal) => {
        modal.querySelector('[data-bk="close"]').onclick = () => QB.UIRenderer.closeModal();
        modal.querySelector('[data-bk="export"]').onclick = async () => {
          const r = await download();
          QB.UIRenderer.toast(r.assetCount ? '备份已生成（含图片 ' + r.assetCount + ' 张，.qfbk）' : '备份已生成（.json）', 'ok');
        };
        modal.querySelector('[data-bk="import"]').onclick = () => pickAndRestore();
        modal.querySelector('[data-bk="dav"]').onclick = () => {
          if (QB.SyncDAV) QB.SyncDAV.openFlow();
          else QB.UIRenderer.toast('WebDAV 模块未加载', 'err');
        };
        modal.querySelector('[data-bk="gc"]').onclick = async () => {
          try {
            const [referenced, all] = await Promise.all([globallyReferencedAssetIds(), QB.Assets.ids()]);
            const orphans = all.length - referenced.length;
            if (orphans <= 0) { QB.UIRenderer.toast('没有未引用的图片（共 ' + all.length + ' 张）'); return; }
            const ok = await QB.UIRenderer.confirmDialog('发现 ' + orphans + ' 张未被任何题目引用的图片（共 ' + all.length + ' 张），确认删除？', '删除');
            if (!ok) return;
            const removed = await QB.Assets.removeOrphans(referenced);
            QB.UIRenderer.toast('已清理 ' + removed.length + ' 张未引用图片', 'ok');
          } catch (e) { QB.UIRenderer.toast('清理失败：' + e.message, 'err'); }
        };
      }
    );
  }

  QB.Backup = {
    buildBackup, applyBackup, isBackup, redactSecrets, readAllData, applyData,
    buildAssetBundle, parseBackupFile, restoreAssets, globallyReferencedAssetIds,
    confirmRestore,
    download, pickAndRestore, openFlow
  };
})(window);