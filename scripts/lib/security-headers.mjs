/**
 * 静态站安全响应头（零依赖，scripts/serve.mjs 与 serve-api.mjs 共用）
 *
 * CSP 与 index.html 的 <meta http-equiv="Content-Security-Policy"> **必须逐字符一致**
 * （meta 覆盖任何静态托管；HTTP 头覆盖本地服务并在 meta 不支持的指令上补充）。
 * pwa.test.mjs 会比对两处策略，改动时请同步修改，避免出现「文档/头/页面」三套口径。
 *
 * 约束来源：
 *   - script-src 'self'：所有脚本均为外部文件（index.html 无内联 <script>），禁止 eval/inline；
 *   - style-src 'unsafe-inline'：渲染层大量使用 style="..." 内联样式（进度条/图表/弹窗），
 *     且为字符串模板拼接，无法改为 class；不引入 style 注入风险以外的放宽；
 *   - img-src data: blob:：图片资产存 IndexedDB，运行时经 createObjectURL 生成 blob:；
 *   - connect-src 'self'：默认只允许同源网络出口（C020 收紧）。前后端分离后端、WebDAV、
 *     URL 导入指向其他 origin 时，浏览器会按 CSP 拦截；部署方必须把该 origin **显式**加入
 *     NETWORK.CSP_CONNECT_ALLOWLIST 并同步改写本文件与 index.html 两处 connect-src
 *     （逐字符一致由 pwa.test 守护）。不做运行时二次校验，避免 API 模式每请求多一次判断。
 *   - worker-src 'self'：FSRS 训练 Worker 为同源 js/workers/fsrs-worker.js。
 *
 * frame-ancestors / X-Frame-Options 仅 HTTP 头生效（meta 里的 frame-ancestors 被浏览器忽略）。
 */
const HTML_EXT = /\.html?$/i;

export const CSP = [
  // file: 仅用于「双击 index.html」场景：file:// 的 origin 为 opaque，'self' 不匹配本地脚本/样式；
  // http(s) 页面本身受浏览器限制不能读取 file://，故该 scheme 放行不会扩大网络暴露面。
  "default-src 'self' file:",
  "script-src 'self' file:",
  "style-src 'self' 'unsafe-inline' file:",
  "img-src 'self' data: blob: file:",
  "font-src 'self' data: file:",
  // C020：默认仅同源。file:// 页面本身 origin 为 opaque，放行 file: 等于对本地任意文件开口子，
  // 且双击直开的离线场景不需要网络请求；跨源部署按文件头白名单说明显式追加 origin。
  "connect-src 'self'",
  "worker-src 'self' file:",
  "media-src 'self' blob: file:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

/** 所有静态响应附加的基础安全头（防 MIME 嗅探、控制 Referer） */
export function securityHeaders(filePath) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  };
  if (HTML_EXT.test(String(filePath || ''))) {
    headers['Content-Security-Policy'] = CSP + "; frame-ancestors 'none'";
    headers['X-Frame-Options'] = 'DENY';
  }
  return headers;
}
