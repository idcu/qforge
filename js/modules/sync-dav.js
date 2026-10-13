/**
 * WebDAV 异步备份（坚果云 / Nextcloud / 群晖 WebDAV 等，零依赖）
 *
 * 固定对象名 PUT/GET，不用 PROPFIND：
 *   <目录>/qforge-backup-latest.bin   有图为 .qfbk（ZIP），无图为 JSON（接收端按 PK 头自识别）
 * 配置（含 Basic Auth 密码）存 localStorage（与题库数据同在本机，不上传第三方）。
 *
 * 重要限制（与 URL 导入相同的诚实声明）：
 *   浏览器跨域要求 WebDAV 服务对本站来源放行 CORS；坚果云等多数公共服务默认不发
 *   Access-Control-Allow-Origin，真机可能被浏览器拦截——此为服务端策略，非代码缺陷，
 *   需在自建/可配置 CORS 的 WebDAV 上使用。逻辑层以注入 fetch 的方式做单测。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const FILE_NAME = 'qforge-backup-latest.bin';
  const OK_STATUS = [200, 201, 204];

  function getConfig() {
    return QB.Storage.get(QB.KEYS.metaDav, null) || { baseUrl: '', user: '', pass: '' };
  }
  function saveConfig(cfg) {
    const clean = {
      baseUrl: String((cfg && cfg.baseUrl) || '').trim(),
      user: String((cfg && cfg.user) || '').trim(),
      pass: String((cfg && cfg.pass) || ''),
      lastAt: cfg && cfg.lastAt,
      lastName: cfg && cfg.lastName,
      lastSize: cfg && cfg.lastSize
    };
    QB.Storage.set(QB.KEYS.metaDav, clean);
    return clean;
  }
  function clearConfig() { QB.Storage.remove(QB.KEYS.metaDav); }

  /** 校验并返回 {url, user, pass}；不合法抛错 */
  function validateConfig(cfg) {
    cfg = cfg || getConfig();
    if (!cfg || !cfg.baseUrl) throw new Error('请填写 WebDAV 目录地址');
    let u;
    try { u = new URL(cfg.baseUrl); } catch (e) { throw new Error('WebDAV 地址不是合法 URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https 地址');
    if (!cfg.user) throw new Error('请填写 WebDAV 账号');
    if (!cfg.pass) throw new Error('请填写 WebDAV 密码/应用密码');
    return { url: targetUrl(cfg.baseUrl), user: cfg.user, pass: cfg.pass };
  }

  /** 目录 → 对象完整 URL（固定文件名；无尾斜杠自动补） */
  function targetUrl(baseUrl) {
    const base = /\/$/.test(baseUrl) ? baseUrl : baseUrl + '/';
    return new URL(FILE_NAME, base).href;
  }

  function authHeader(user, pass) {
    const raw = user + ':' + pass;
    const b64 = (typeof btoa !== 'undefined')
      ? btoa(raw)
      : Buffer.from(raw, 'utf-8').toString('base64');
    return 'Basic ' + b64;
  }

  function defaultFetch() {
    if (typeof fetch !== 'function') throw new Error('当前环境不支持 fetch');
    return fetch;
  }

  /**
   * 上传当前全量备份
   * @param {{config?:Object, fetch?:Function}} [opts] fetch 可注入（测试）
   */
  async function upload(opts) {
    opts = opts || {};
    const checked = validateConfig(opts.config);
    const bundle = await QB.Backup.buildAssetBundle();
    let body, mime, assetCount;
    if (bundle) {
      body = bundle.content; mime = 'application/zip'; assetCount = bundle.assetCount;
    } else {
      QB.Storage.forceSync();
      body = JSON.stringify(QB.Backup.buildBackup());
      mime = 'application/json;charset=utf-8';
      assetCount = 0;
    }
    const fetchImpl = opts.fetch || defaultFetch();
    const res = await fetchImpl(checked.url, {
      method: 'PUT',
      headers: { Authorization: authHeader(checked.user, checked.pass), 'Content-Type': mime },
      body: body
    });
    if (!res || OK_STATUS.indexOf(res.status) < 0) {
      const status = res && res.status;
      throw new Error(status === 401 || status === 403
        ? 'WebDAV 认证失败（401/403）：检查账号与应用密码'
        : 'WebDAV 上传失败（HTTP ' + (status || '无响应') + '）');
    }
    const size = body instanceof ArrayBuffer ? body.byteLength : body.length;
    const saved = saveConfig(Object.assign({}, opts.config || getConfig(), {
      lastAt: Date.now(), lastName: FILE_NAME, lastSize: size
    }));
    return { ok: true, status: res.status, url: checked.url, size: size, assetCount: assetCount, config: saved };
  }

  /**
   * 下载云端备份并解析（不直接恢复，交给 Backup.confirmRestore 让用户选覆盖/合并）
   * @returns {Promise<{backup:Object, assets:Array, source:string}>}
   */
  async function fetchBackup(opts) {
    opts = opts || {};
    const checked = validateConfig(opts.config);
    const fetchImpl = opts.fetch || defaultFetch();
    const res = await fetchImpl(checked.url, {
      method: 'GET',
      headers: { Authorization: authHeader(checked.user, checked.pass) }
    });
    if (!res || res.status !== 200) {
      const status = res && res.status;
      throw new Error(status === 401 || status === 403
        ? 'WebDAV 认证失败（401/403）'
        : status === 404 ? '云端没有备份文件（先上传一次）' : 'WebDAV 下载失败（HTTP ' + (status || '无响应') + '）');
    }
    const buffer = await res.arrayBuffer();
    const parsed = await QB.Backup.parseBackupFile(buffer);
    parsed.source = checked.url;
    return parsed;
  }

  /* ---------------- 浏览器设置弹窗 ---------------- */

  function openFlow() {
    const cfg = getConfig();
    const esc = QB.Helpers.escapeHtml;
    const last = cfg.lastAt ? QB.Helpers.formatDate(cfg.lastAt) + '（' + Math.round((cfg.lastSize || 0) / 1024) + ' KB）' : '尚未上传';
    QB.UIRenderer.openModal(
      '<h3>WebDAV 云备份</h3>' +
      '<div class="qe-form">' +
      '<label class="qe-label">WebDAV 目录 URL（如 https://dav.jianguoyun.com/dav/我的备份/）</label>' +
      '<input type="text" data-dav="url" value="' + esc(cfg.baseUrl) + '" placeholder="目录地址，以 / 结尾" style="width:100%">' +
      '<label class="qe-label">账号</label><input type="text" data-dav="user" value="' + esc(cfg.user) + '" style="width:100%">' +
      '<label class="qe-label">密码 / 应用密码（仅存本机 localStorage）</label>' +
      '<input type="password" data-dav="pass" value="' + esc(cfg.pass) + '" style="width:100%">' +
      '<p class="li-meta">上次上传：' + esc(last) + '　固定对象 ' + esc(FILE_NAME) + '</p>' +
      '<p class="li-meta">需要 WebDAV 服务允许本站 CORS 跨域访问；坚果云等公共服务默认可能被浏览器拦截，自建/Nextcloud 通常可配置。</p>' +
      '</div>' +
      '<div class="modal-actions" style="justify-content:flex-start;flex-wrap:wrap">' +
      '<button class="btn" data-dav="up">上传备份</button>' +
      '<button class="btn btn-ghost" data-dav="down">下载并恢复</button>' +
      '<button class="btn btn-ghost btn-danger-text" data-dav="clear">清除配置</button>' +
      '<button class="btn btn-ghost" data-dav="close">关闭</button></div>',
      (modal) => {
        const read = () => ({
          baseUrl: modal.querySelector('[data-dav="url"]').value,
          user: modal.querySelector('[data-dav="user"]').value,
          pass: modal.querySelector('[data-dav="pass"]').value,
          lastAt: cfg.lastAt, lastName: cfg.lastName, lastSize: cfg.lastSize
        });
        modal.querySelector('[data-dav="close"]').onclick = () => QB.UIRenderer.closeModal();
        modal.querySelector('[data-dav="clear"]').onclick = () => { clearConfig(); QB.UIRenderer.toast('已清除 WebDAV 配置', 'ok'); QB.UIRenderer.closeModal(); };
        modal.querySelector('[data-dav="up"]').onclick = async () => {
          const conf = read();
          try {
            saveConfig(conf);
            QB.UIRenderer.toast('正在上传备份…');
            const r = await upload({ config: conf });
            QB.UIRenderer.toast('已上传到 WebDAV（' + Math.round(r.size / 1024) + ' KB' + (r.assetCount ? '，含图 ' + r.assetCount + ' 张' : '') + '）', 'ok');
            QB.UIRenderer.closeModal();
          } catch (e) { QB.UIRenderer.toast('上传失败：' + e.message, 'err'); }
        };
        modal.querySelector('[data-dav="down"]').onclick = async () => {
          try {
            saveConfig(read());
            QB.UIRenderer.toast('正在从 WebDAV 拉取…');
            const parsed = await fetchBackup({ config: read() });
            await QB.Backup.confirmRestore(parsed); // 用户在恢复弹窗确认覆盖/合并
            QB.UIRenderer.closeModal();
          } catch (e) { QB.UIRenderer.toast('下载失败：' + e.message, 'err'); }
        };
      }
    );
  }

  QB.SyncDAV = {
    FILE_NAME,
    getConfig, saveConfig, clearConfig, validateConfig, targetUrl, authHeader,
    upload, fetchBackup, openFlow
  };
})(window);
