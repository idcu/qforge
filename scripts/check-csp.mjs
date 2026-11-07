/**
 * check-csp.mjs —— CSP 三处同步门禁（零依赖，只读；R-13）
 *
 * 背景：`connect-src` 的实际策略由两处字面量决定——`index.html` 的 CSP meta 与
 * `scripts/lib/security-headers.mjs` 的 `CSP`（HTTP 头）。部署清单
 * `NETWORK.CSP_CONNECT_ALLOWLIST`（`js/config.js`）只是文档，浏览器不看它。
 * 三处此前靠人工同步，容易「白名单写了、meta 没写」→ 用户以为放行了、实际被 CSP 拦截。
 *
 * 判据（全部只加严）：
 *   1. index.html 存在 CSP meta，且与 security-headers.mjs 的 `CSP` 逐字符一致；
 *   2. `CSP_CONNECT_ALLOWLIST` 可解析，每一项都是合法 origin（http/https/ws/wss）；
 *   3. 两处 `connect-src` 的非 origin 指令词（如 `'self'`）一致；
 *   4. 白名单 origin 集合 == meta 的 connect-src origin 集合 == HTTP 头 origin 集合（双向）；
 *   5. 两处 `connect-src` 的 origin 集合一致（多一个少一个都红）。
 *
 * 用法：
 *   node scripts/check-csp.mjs            校验仓库（0 通过 / 1 违约）
 *   node scripts/check-csp.mjs --selftest 负例自检（1 = 存在未拦截的注入）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSP as HEADER_CSP } from './lib/security-headers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SELFTEST = process.argv.slice(2).includes('--selftest');

/** index.html 的 CSP meta（与 pwa.test 的解析口径一致） */
const META_RE = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i;
/** config.js 的白名单数组（允许跨行；数组体内先去掉注释，避免注释里的引号被当成条目） */
const ALLOWLIST_RE = /CSP_CONNECT_ALLOWLIST\s*:\s*\[([\s\S]*?)\]/;
const ORIGIN_TOKEN_RE = /^(?:https?|wss?):\/\/[^\s]+$/i;

export function connectTokens(policy, name) {
  const parts = String(policy || '').split(';').map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const words = p.split(/\s+/);
    if (words[0] === name) return words.slice(1);
  }
  return null;
}

/** 归一化 origin：去尾斜杠（`https://a/` 与 `https://a` 视为同一出口） */
export function normalizeOrigin(token) {
  const u = new URL(token);
  return (u.protocol + '//' + u.host).toLowerCase();
}

/** 去掉数组体内的注释（引号内的 `//` 是 URL 的一部分，不能当注释截断） */
export function stripComments(body) {
  let out = '';
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const n = body[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n || ''; i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) i++;
      i++; // 跳过闭合的 '/'
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < body.length && body[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

export function allowlistOf(configSrc) {
  const m = ALLOWLIST_RE.exec(String(configSrc || ''));
  if (!m) return null;
  const body = stripComments(m[1]);
  return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => (x[1] !== undefined ? x[1] : x[2]));
}

/**
 * 纯函数：返回 { problems, stats }，便于 selftest 注入。
 * @param {{indexHtml:string, headerCsp:string, configSrc:string}} input
 */
export function analyze(input) {
  const problems = [];
  const meta = META_RE.exec(String(input.indexHtml || ''));
  const metaCsp = meta ? meta[1] : '';

  if (!meta) problems.push('index.html 缺少 CSP meta');
  if (meta && metaCsp !== input.headerCsp) {
    problems.push('index.html 的 CSP meta 与 scripts/lib/security-headers.mjs 的 CSP 不逐字符一致');
  }

  const metaConnect = connectTokens(metaCsp, 'connect-src');
  const headerConnect = connectTokens(input.headerCsp, 'connect-src');
  if (!metaConnect) problems.push('index.html 的 CSP meta 缺少 connect-src');
  if (!headerConnect) problems.push('security-headers.mjs 的 CSP 缺少 connect-src');

  const metaOrigins = new Set((metaConnect || []).filter((t) => ORIGIN_TOKEN_RE.test(t)).map(normalizeOrigin));
  const headerOrigins = new Set((headerConnect || []).filter((t) => ORIGIN_TOKEN_RE.test(t)).map(normalizeOrigin));
  const metaBase = (metaConnect || []).filter((t) => !ORIGIN_TOKEN_RE.test(t)).sort().join(' ');
  const headerBase = (headerConnect || []).filter((t) => !ORIGIN_TOKEN_RE.test(t)).sort().join(' ');
  if (metaConnect && headerConnect && metaBase !== headerBase) {
    problems.push("两处 connect-src 的非 origin 指令不一致：meta [" + metaBase + "] / header [" + headerBase + "]");
  }

  const allow = allowlistOf(input.configSrc);
  if (allow === null) problems.push('js/config.js 缺少可解析的 CSP_CONNECT_ALLOWLIST 数组');
  const allowOrigins = new Set();
  (allow || []).forEach((entry) => {
    if (!ORIGIN_TOKEN_RE.test(entry)) {
      problems.push('CSP_CONNECT_ALLOWLIST 条目不是合法 origin（仅 http/https/ws/wss）：「' + entry + '」');
      return;
    }
    allowOrigins.add(normalizeOrigin(entry));
  });

  allowOrigins.forEach((o) => {
    if (!metaOrigins.has(o)) problems.push('白名单声明了 ' + o + '，但 index.html 的 connect-src 未包含');
    if (!headerOrigins.has(o)) problems.push('白名单声明了 ' + o + '，但 security-headers.mjs 的 connect-src 未包含');
  });
  metaOrigins.forEach((o) => {
    if (!allowOrigins.has(o)) problems.push('index.html 的 connect-src 出现未登记 origin ' + o + '（应加入 CSP_CONNECT_ALLOWLIST）');
    if (!headerOrigins.has(o)) problems.push('index.html 的 connect-src 出现 ' + o + '，但 HTTP 头未包含');
  });
  headerOrigins.forEach((o) => {
    if (!allowOrigins.has(o)) problems.push('security-headers.mjs 的 connect-src 出现未登记 origin ' + o + '（应加入 CSP_CONNECT_ALLOWLIST）');
    if (!metaOrigins.has(o)) problems.push('security-headers.mjs 的 connect-src 出现 ' + o + '，但 meta 未包含');
  });

  return {
    problems,
    stats: { allow: allowOrigins.size, metaOrigins: metaOrigins.size, headerOrigins: headerOrigins.size, base: metaBase }
  };
}

/* ============================ 负例自检 ============================ */

if (SELFTEST) {
  const withConnect = (origins) => {
    const extra = origins.map((o) => ' ' + o).join('');
    return HEADER_CSP.replace("connect-src 'self'", "connect-src 'self'" + extra);
  };
  const fixture = (o) => {
    const opt = o || {};
    const header = opt.headerCsp || HEADER_CSP;
    return {
      indexHtml: opt.indexHtml != null ? opt.indexHtml
        : '<meta http-equiv="Content-Security-Policy" content="' + header + '" />',
      headerCsp: header,
      configSrc: opt.configSrc != null ? opt.configSrc
        : 'CSP_CONNECT_ALLOWLIST: [' + (opt.allow || '') + ']'
    };
  };
  const cases = [
    {
      name: '默认策略（白名单为空、connect-src 仅 self）',
      expect: 0,
      input: fixture({})
    },
    {
      name: '白名单与两处 connect-src 完全一致',
      expect: 0,
      input: (() => {
        const h = withConnect(['https://api.example.test']);
        return {
          indexHtml: '<meta http-equiv="Content-Security-Policy" content="' + h + '" />',
          headerCsp: h,
          configSrc: "CSP_CONNECT_ALLOWLIST: ['https://api.example.test']"
        };
      })()
    },
    {
      name: '白名单有、meta 无（本次新增判据）',
      expect: 1,
      input: fixture({ configSrc: "CSP_CONNECT_ALLOWLIST: ['https://api.example.test']" })
    },
    {
      name: 'meta 有、白名单无',
      expect: 1,
      input: (() => {
        const h = withConnect(['https://api.example.test']);
        return {
          indexHtml: '<meta http-equiv="Content-Security-Policy" content="' + h + '" />',
          headerCsp: h,
          configSrc: 'CSP_CONNECT_ALLOWLIST: []'
        };
      })()
    },
    {
      name: 'meta 与 HTTP 头策略不一致',
      expect: 1,
      input: fixture({ indexHtml: '<meta http-equiv="Content-Security-Policy" content="' + HEADER_CSP + "; img-src 'none'\" />" })
    },
    {
      name: '白名单条目不是 origin',
      expect: 1,
      input: fixture({ configSrc: "CSP_CONNECT_ALLOWLIST: ['api.example.test']" })
    }
  ];
  let caught = 0;
  console.log('== check-csp 负例自检 ==');
  cases.forEach((c) => {
    const n = analyze(c.input).problems.length;
    const hit = c.expect ? n > 0 : n === 0;
    if (hit) caught++;
    console.log('  ' + (hit ? '✓' : '✗') + ' ' + c.name
      + '（期望 ' + (c.expect ? '红' : '绿') + '，实际 ' + (n ? '红 ' + n + ' 处' : '绿') + '）');
  });
  console.log('自检: ' + caught + '/' + cases.length + ' 符合预期');
  process.exitCode = caught === cases.length ? 0 : 1;
} else {
  const input = {
    indexHtml: fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
    headerCsp: HEADER_CSP,
    configSrc: fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8')
  };
  const res = analyze(input);
  console.log('check-csp: 策略 2 处（index.html meta / security-headers.mjs），白名单 '
    + res.stats.allow + ' 项，connect-src 基数 [' + res.stats.base + ']，' + res.problems.length + ' 处不一致');
  res.problems.forEach((p) => console.error('  ✗ ' + p));
  process.exitCode = res.problems.length ? 1 : 0;
}
