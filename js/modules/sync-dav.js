/**
 * WebDAV 异步备份（坚果云 / Nextcloud / 群晖 WebDAV 等，零依赖）
 *
 * 固定对象名 PUT/GET，不用 PROPFIND：
 *   <目录>/qforge-backup-latest.bin   有图为 .qfbk（ZIP），无图为 JSON（接收端按 PK 头自识别）
 * 配置（含 Basic Auth 密码）存 localStorage，但**密码不以明文落盘**（C027）：
 *   - 密文：AES-GCM 256（Web Crypto，零依赖），每次保存随机 12 字节 IV，格式 `{v:2, ..., passEnc:{alg,iv,data}}`；
 *   - 密钥：`crypto.subtle.generateKey(..., false, ['encrypt','decrypt'])` 生成的**不可导出** CryptoKey，
 *     持久化在 IndexedDB `qforge-secrets/keys`（`dav`）；IndexedDB 不可用时退化为**仅内存会话密钥**，
 *     此时密码不落盘、刷新后需重新输入（UI 有可见提示）。
 *   - 旧版明文配置首次读取会自动「加密→回读校验→覆盖」，校验失败保留旧明文并给出可见错误。
 * 威胁模型（诚实声明，见 docs/SECURITY.md §9）：能防「只拿到 localStorage 拷贝/截图/同步」的明文泄露；
 * **不能防**同源 XSS（脚本可调用 decrypt）、恶意浏览器扩展、同机读盘/整 profile 拷贝、
 * 运行期内存转储，也不能替代应用专用密码。跨域 WebDAV 还受 CSP connect-src 白名单约束。
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

  /* ---------------- C027 密码加密（Web Crypto，零依赖） ---------------- */

  const SECRET_DB = 'qforge-secrets';
  const SECRET_STORE = 'keys';
  const SECRET_KEY_ID = 'dav';
  let sessionKey = null;          // CryptoKey（不可导出）；IndexedDB 不可用时仅存在内存
  let sessionKeyPersistent = false;

  function subtle() {
    const c = global.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    return c && c.subtle && typeof c.subtle.encrypt === 'function' ? c : null;
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64ToBytes(text) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(String(text), 'base64'));
    const bin = atob(String(text));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function idbOpen() {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null);
      try {
        const req = indexedDB.open(SECRET_DB, 1);
        req.onupgradeneeded = () => { try { req.result.createObjectStore(SECRET_STORE); } catch (e) { /* 已存在 */ } };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  async function idbGetKey() {
    const db = await idbOpen();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction(SECRET_STORE, 'readonly').objectStore(SECRET_STORE).get(SECRET_KEY_ID);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  async function idbPutKey(key) {
    const db = await idbOpen();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(SECRET_STORE, 'readwrite');
        tx.objectStore(SECRET_STORE).put(key, SECRET_KEY_ID);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  }

  /**
   * 取密钥：优先 IndexedDB 持久密钥；缺失且 create=true 时生成不可导出 AES-GCM key。
   * IndexedDB 不可用 → 生成仅内存会话密钥（仍加密，但不跨刷新）。
   */
  async function getKey(create) {
    if (sessionKey) return sessionKey;
    const c = subtle();
    if (!c) return null;
    let key = await idbGetKey();
    if (!key && create) {
      key = await c.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      sessionKeyPersistent = await idbPutKey(key);
    } else if (key) {
      sessionKeyPersistent = true;
    }
    if (key) sessionKey = key;
    return key;
  }

  /** 加密密码；返回 {enc, error}。crypto 不可用时不落盘（enc=null）。 */
  async function encryptPass(pass) {
    const c = subtle();
    if (!c) return { enc: null, error: '当前环境不支持 Web Crypto，密码不会落盘（仅本次会话可用）' };
    try {
      const key = await getKey(true);
      if (!key) return { enc: null, error: '无法创建加密密钥，密码不会落盘（仅本次会话可用）' };
      const iv = c.getRandomValues(new Uint8Array(12));
      const ct = await c.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(String(pass)));
      return { enc: { alg: 'AES-GCM', iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ct)) } };
    } catch (e) {
      return { enc: null, error: '密码加密失败：' + (e && e.message ? e.message : '未知错误') };
    }
  }

  /** 解密密码；失败返回 {pass:'', error}（调用方必须展示 error，不能静默当空密码）。 */
  async function decryptPass(enc) {
    const c = subtle();
    if (!c) return { pass: '', error: '当前环境不支持 Web Crypto，无法解密已保存密码，请重新输入' };
    if (!enc || !enc.iv || !enc.data) return { pass: '', error: '密码密文缺失，请重新输入' };
    const key = await getKey(false);
    if (!key) return { pass: '', error: '本机加密密钥不可用（IndexedDB 不可用或密钥已清理），请重新输入密码' };
    try {
      const pt = await c.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(enc.iv) }, key, base64ToBytes(enc.data)
      );
      return { pass: new TextDecoder().decode(pt) };
    } catch (e) {
      return { pass: '', error: '密码解密失败（密文损坏或密钥已变），请重新输入' };
    }
  }

  /* ---------------- 配置读写 ---------------- */

  /** 同步读取元数据（不含明文密码）：UI 展示 / 上传后记录 lastAt 用 */
  function getConfig() {
    const raw = QB.Storage.get(QB.KEYS.metaDav, null);
    if (!raw) return { baseUrl: '', user: '', hasPass: false };
    return {
      baseUrl: String(raw.baseUrl || ''),
      user: String(raw.user || ''),
      lastAt: raw.lastAt,
      lastName: raw.lastName,
      lastSize: raw.lastSize,
      hasPass: !!(raw.passEnc || (typeof raw.pass === 'string' && raw.pass)),
      v: raw.v || 1
    };
  }

  /**
   * 异步读取完整配置（含解密后的密码）。
   * 旧明文配置会就地迁移为 v2 密文；迁移失败/无密钥时返回 `passError`（调用方必须展示）。
   * @returns {Promise<{baseUrl,user,pass,lastAt?,lastName?,lastSize?,hasPass,migrated?,passError?}>}
   */
  async function loadConfig() {
    const raw = QB.Storage.get(QB.KEYS.metaDav, null);
    if (!raw) return { baseUrl: '', user: '', pass: '', hasPass: false };
    const out = {
      baseUrl: String(raw.baseUrl || ''),
      user: String(raw.user || ''),
      pass: '',
      lastAt: raw.lastAt,
      lastName: raw.lastName,
      lastSize: raw.lastSize,
      hasPass: true,
      v: raw.v || 1
    };
    if (raw.passEnc) {
      const d = await decryptPass(raw.passEnc);
      out.pass = d.pass;
      if (d.error) out.passError = d.error;
      return out;
    }
    if (typeof raw.pass === 'string' && raw.pass) {
      // 旧明文：先加密并回读校验，确认一致才覆盖；任何失败都不丢旧值（或至少给出可见错误）
      out.pass = raw.pass;
      const enc = await encryptPass(raw.pass);
      if (enc.enc) {
        const verify = await decryptPass(enc.enc);
        if (verify.pass === raw.pass) {
          QB.Storage.set(QB.KEYS.metaDav, {
            v: 2, baseUrl: out.baseUrl, user: out.user, passEnc: enc.enc,
            lastAt: out.lastAt, lastName: out.lastName, lastSize: out.lastSize
          });
          out.migrated = true;
          out.v = 2;
          return out;
        }
        out.passError = '密码迁移校验失败，旧明文未改动；请重新输入密码后保存';
        return out;
      }
      // Web Crypto / 密钥不可用：明文不能继续留在 localStorage；移除明文，保元数据，密码仅本次会话可用
      QB.Storage.set(QB.KEYS.metaDav, {
        v: 2, baseUrl: out.baseUrl, user: out.user,
        lastAt: out.lastAt, lastName: out.lastName, lastSize: out.lastSize
      });
      out.migrated = true;
      out.passPersisted = false;
      out.passError = enc.error || '密码无法加密保存；密钥不可用，请重新输入';
      return out;
    }
    return out;
  }

  /**
   * 保存配置（异步：密码先加密再落盘）。
   * `pass` 是字符串时按新值处理（空串=清除密文）；缺省 `pass` 字段时保留已存密文（仅更新 lastAt 等元数据）。
   */
  async function saveConfig(cfg) {
    cfg = cfg || {};
    const raw = QB.Storage.get(QB.KEYS.metaDav, null) || {};
    const clean = {
      v: 2,
      baseUrl: String((cfg.baseUrl !== undefined ? cfg.baseUrl : raw.baseUrl) || '').trim(),
      user: String((cfg.user !== undefined ? cfg.user : raw.user) || '').trim(),
      lastAt: cfg.lastAt !== undefined ? cfg.lastAt : raw.lastAt,
      lastName: cfg.lastName !== undefined ? cfg.lastName : raw.lastName,
      lastSize: cfg.lastSize !== undefined ? cfg.lastSize : raw.lastSize
    };
    let passText = '';
    let warning = '';
    if (typeof cfg.pass === 'string') {
      passText = cfg.pass;
      if (passText) {
        const enc = await encryptPass(passText);
        if (enc.enc) clean.passEnc = enc.enc;
        else warning = enc.error;
      }
    } else if (raw.passEnc) {
      clean.passEnc = raw.passEnc; // 仅更新元数据时保留密文
    } else if (typeof raw.pass === 'string' && raw.pass) {
      // 旧明文且未显式传 pass：迁移时不能把明文写回
      const enc = await encryptPass(raw.pass);
      if (enc.enc) clean.passEnc = enc.enc;
      else warning = enc.error;
    }
    QB.Storage.set(QB.KEYS.metaDav, clean);
    return Object.assign({}, clean, {
      pass: passText,
      passPersisted: !!clean.passEnc,
      passWarning: warning
    });
  }
  function clearConfig() { QB.Storage.remove(QB.KEYS.metaDav); }

  /** 校验并返回 {url, user, pass}；不合法抛错。cfg 应来自 loadConfig()（含解密后的 pass） */
  function validateConfig(cfg) {
    cfg = cfg || {};
    if (!cfg.baseUrl) throw new Error('请填写 WebDAV 目录地址');
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

  /** UTF-8 安全的 Basic 认证头（中文账号/应用密码不能直接 btoa，会抛 InvalidCharacterError） */
  function base64Utf8(text) {
    if (typeof TextEncoder !== 'undefined') {
      const bytes = new TextEncoder().encode(String(text));
      if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    return Buffer.from(String(text), 'utf-8').toString('base64');
  }

  function authHeader(user, pass) {
    return 'Basic ' + base64Utf8(user + ':' + pass);
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
    const cfg = opts.config || await loadConfig();
    if (!opts.config && cfg.passError) throw new Error(cfg.passError);
    const checked = validateConfig(cfg);
    const bundle = await QB.Backup.buildAssetBundle();
    let body, mime, assetCount;
    if (bundle) {
      body = bundle.content; mime = 'application/zip'; assetCount = bundle.assetCount;
    } else {
      QB.Storage.forceSync();
      body = JSON.stringify(await QB.Backup.buildBackup());
      mime = 'application/json;charset=utf-8';
      assetCount = 0;
    }
    const fetchImpl = opts.fetch || defaultFetch();
    const res = await fetchImpl(checked.url, {
      method: 'PUT',
      headers: { Authorization: authHeader(checked.user, checked.pass), 'Content-Type': mime },
      body: body
    });
    // 消费响应体（WebDAV/代理可能回非空 body）：未消费的 Response 被释放时浏览器会记
    // `net::ERR_ABORTED`——请求其实已成功（与 api-adapter.req 同一类噪声，见 CHANGELOG.internal.md）。
    try { await res.arrayBuffer(); } catch (e) { /* 消费失败不影响状态判定 */ }
    if (!res || OK_STATUS.indexOf(res.status) < 0) {
      const status = res && res.status;
      throw new Error(status === 401 || status === 403
        ? 'WebDAV 认证失败（401/403）：检查账号与应用密码'
        : 'WebDAV 上传失败（HTTP ' + (status || '无响应') + '）');
    }
    const size = body instanceof ArrayBuffer ? body.byteLength : body.length;
    const saved = await saveConfig(Object.assign({}, cfg, {
      pass: checked.pass, lastAt: Date.now(), lastName: FILE_NAME, lastSize: size
    }));
    return { ok: true, status: res.status, url: checked.url, size: size, assetCount: assetCount, config: saved };
  }

  /**
   * 下载云端备份并解析（不直接恢复，交给 Backup.confirmRestore 让用户选覆盖/合并）
   * @returns {Promise<{backup:Object, assets:Array, source:string}>}
   */
  async function fetchBackup(opts) {
    opts = opts || {};
    const cfg = opts.config || await loadConfig();
    if (!opts.config && cfg.passError) throw new Error(cfg.passError);
    const checked = validateConfig(cfg);
    const fetchImpl = opts.fetch || defaultFetch();
    const res = await fetchImpl(checked.url, {
      method: 'GET',
      headers: { Authorization: authHeader(checked.user, checked.pass) }
    });
    if (!res || res.status !== 200) {
      const status = res && res.status;
      if (res) { try { await res.arrayBuffer(); } catch (e) { /* 同上：消费以免记 ERR_ABORTED */ } }
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

  async function openFlow() {
    const cfg = await loadConfig();
    const esc = QB.Helpers.escapeHtml;
    const last = cfg.lastAt ? QB.Helpers.formatDate(cfg.lastAt) + '（' + Math.round((cfg.lastSize || 0) / 1024) + ' KB）' : '尚未上传';
    const passError = cfg.passError
      ? '<p class="li-meta" style="color:#c62828">' + esc(cfg.passError) + '</p>' : '';
    QB.UIRenderer.openModal(
      '<h3>WebDAV 云备份</h3>' +
      '<div class="qe-form">' +
      '<label class="qe-label">WebDAV 目录 URL（如 https://dav.jianguoyun.com/dav/我的备份/）</label>' +
      '<input type="text" data-dav="url" value="' + esc(cfg.baseUrl) + '" placeholder="目录地址，以 / 结尾" style="width:100%">' +
      '<label class="qe-label">账号</label><input type="text" data-dav="user" value="' + esc(cfg.user) + '" style="width:100%">' +
      '<label class="qe-label">密码 / 应用密码（AES-GCM 加密保存在本机，密钥不可导出）</label>' +
      '<input type="password" data-dav="pass" value="' + esc(cfg.pass) + '" style="width:100%">' +
      passError +
      '<p class="li-meta">加密边界（不夸大）：密码不再以明文写入 localStorage，能防「只拿到 localStorage 备份/截图」的泄露；但不能防同源 XSS、恶意浏览器扩展、同机读盘或整浏览器配置拷贝，也不能替代应用专用密码。建议使用应用专用密码，共享设备用完点「清除配置」。跨域 WebDAV 还需在 CSP connect-src 白名单放行该域。</p>' +
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
        const persist = async (conf) => {
          const saved = await saveConfig(conf);
          if (saved.passWarning) QB.UIRenderer.toast(saved.passWarning, 'err');
          return saved;
        };
        modal.querySelector('[data-dav="close"]').onclick = () => QB.UIRenderer.closeModal();
        modal.querySelector('[data-dav="clear"]').onclick = () => { clearConfig(); QB.UIRenderer.toast('已清除 WebDAV 配置', 'ok'); QB.UIRenderer.closeModal(); };
        modal.querySelector('[data-dav="up"]').onclick = async () => {
          const conf = read();
          try {
            await persist(conf);
            QB.UIRenderer.toast('正在上传备份…');
            const r = await upload({ config: conf });
            QB.UIRenderer.toast('已上传到 WebDAV（' + Math.round(r.size / 1024) + ' KB' + (r.assetCount ? '，含图 ' + r.assetCount + ' 张' : '') + '）', 'ok');
            QB.UIRenderer.closeModal();
          } catch (e) { QB.UIRenderer.toast('上传失败：' + e.message, 'err'); }
        };
        modal.querySelector('[data-dav="down"]').onclick = async () => {
          try {
            await persist(read());
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
    getConfig, loadConfig, saveConfig, clearConfig, validateConfig, targetUrl, authHeader,
    upload, fetchBackup, openFlow
  };
})(window);
