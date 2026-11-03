#!/usr/bin/env node
/* check-ngm.mjs —— 消费方公共模块接线自检（零第三方依赖）
 *
 * 断言四件事：
 *   1. ngm.json 的每条依赖 ↔ ngm.lock 的模块条目一一对应，版本一致；
 *   2. ngm.vendor 下的物理模块目录与 lock 一一对应，无未登记模块；
 *   3. 源码/入口里出现的 ngm.vendor 路径都能归到已登记的 subPath；
 *   4. .ngm-version 与 lockfileVersion 2.0.0 存在且格式合理。
 *
 * 只读；不调用 ngm，不访问网络。CI 与本地测试都可直接运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_SLUG = 'gitee:idcu/ngm-repo';
const VENDOR_REPO = 'gitee.com/idcu/ngm-repo';
const LOCKFILE_VERSION = '2.0.0';
const errors = [];
const warnings = [];

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

function readJson(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    fail(`缺少 ${relPath}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    fail(`${relPath} 不是合法 JSON：${e.message}`);
    return null;
  }
}

function isSemver(v) {
  return typeof v === 'string' && /^[0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z.-]+)?$/.test(v);
}

function semverFromRef(ref) {
  const m = String(ref || '').match(/\/v([0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z.-]+)?)$/);
  return m ? m[1] : null;
}

function walkFiles(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'ngm.vendor') continue;
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      if (name === 'analysis' || name === 'data' || name.startsWith('.tmp-') || name === '.trae' || name === '.screenshots') continue;
      if (name === 'vendor' && path.basename(dir) === 'public') continue;
      walkFiles(abs, out);
    } else if (['.js', '.mjs', '.cjs', '.html'].includes(path.extname(name))) {
      out.push(abs);
    }
  }
}

const project = readJson('ngm.json');
const lock = readJson('ngm.lock');
const mappings = readJson('ngm.mappings.json');
const versionFile = path.join(ROOT, '.ngm-version');

if (!fs.existsSync(versionFile)) {
  fail('缺少 .ngm-version（消费方必须固定 ngm 构建版本）');
} else {
  const ngmVersion = fs.readFileSync(versionFile, 'utf8').trim();
  if (!isSemver(ngmVersion) || ngmVersion === '0.0.0-dev') {
    fail(`.ngm-version 的值不可用：${ngmVersion || '(空)'}`);
  }
}

if (project && lock) {
  const declared = new Map();
  for (const d of project.dependencies || []) {
    if (d.name !== REPO_SLUG) {
      fail(`ngm.json 出现非预期依赖仓库：${d.name}`);
      continue;
    }
    if (!d.path) {
      fail(`ngm.json 依赖缺少 path：${JSON.stringify(d)}`);
      continue;
    }
    if (d.refType !== 'tag') {
      fail(`${d.path} 的 refType 必须是 tag，实际 ${d.refType}`);
    }
    const version = semverFromRef(d.ref);
    if (!version) {
      fail(`${d.path} 的 ref 不是 <path>/v<semver>：${d.ref}`);
      continue;
    }
    if (d.ref !== `${d.path}/v${version}`) {
      fail(`${d.path} 的 ref 与 path 不一致：${d.ref}`);
    }
    if (declared.has(d.path)) {
      fail(`ngm.json 重复声明模块：${d.path}`);
      continue;
    }
    declared.set(d.path, { ...d, version });
  }

  if (!lock.dependencies || !Array.isArray(lock.dependencies)) {
    fail('ngm.lock 缺少 dependencies 数组');
  } else {
    if (lock.lockfileVersion !== LOCKFILE_VERSION) {
      fail(`ngm.lock lockfileVersion 应为 ${LOCKFILE_VERSION}，实际 ${lock.lockfileVersion}`);
    }
    const locked = new Map();
    for (const d of lock.dependencies) {
      if (d.name !== REPO_SLUG) {
        fail(`ngm.lock 出现非预期依赖仓库：${d.name}`);
        continue;
      }
      if (!d.subPath) {
        fail(`ngm.lock 条目缺少 subPath：${JSON.stringify(d)}`);
        continue;
      }
      if (locked.has(d.subPath)) {
        fail(`ngm.lock 重复模块：${d.subPath}`);
        continue;
      }
      if (!isSemver(d.version)) fail(`${d.subPath} 的 lock version 不可用：${d.version}`);
      if (!/^[0-9a-f]{40}$/.test(String(d.commit))) fail(`${d.subPath} 的 commit 不是 40 位十六进制：${d.commit}`);
      if (!/^sha256:[0-9a-f]{64}$/.test(String(d.moduleDigest))) fail(`${d.subPath} 缺少合法 moduleDigest：${d.moduleDigest}`);
      if (!/^(sha1|sha256):[0-9a-f]{40,64}$/.test(String(d.subtreeOid))) fail(`${d.subPath} 缺少合法 subtreeOid：${d.subtreeOid}`);
      if (d.vendorPath !== VENDOR_REPO) fail(`${d.subPath} 的 vendorPath 应为 ${VENDOR_REPO}，实际 ${d.vendorPath}`);
      locked.set(d.subPath, d);
    }

    for (const [subPath, d] of declared) {
      const l = locked.get(subPath);
      if (!l) {
        fail(`ngm.json 声明了 ${subPath}，但 ngm.lock 没有对应条目`);
        continue;
      }
      if (l.version !== d.version) {
        fail(`${subPath} 版本不一致：ngm.json ${d.version} / ngm.lock ${l.version}`);
      }
    }
    for (const subPath of locked.keys()) {
      if (!declared.has(subPath)) fail(`ngm.lock 登记了未声明模块：${subPath}`);
    }

    for (const [subPath, d] of declared) {
      const moduleDir = path.join(ROOT, 'ngm.vendor', VENDOR_REPO, subPath);
      if (!fs.existsSync(moduleDir)) {
        fail(`${subPath} 的 vendor 目录不存在：${rel(moduleDir)}`);
        continue;
      }
      const manifestPath = path.join(moduleDir, 'ngm.json');
      if (!fs.existsSync(manifestPath)) {
        fail(`${subPath} 的 vendor ngm.json 不存在：${rel(manifestPath)}`);
        continue;
      }
      try {
        const vm = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!String(vm.name || '').startsWith('@idcu/')) {
          fail(`${subPath} 的 vendor 模块名异常：${vm.name}`);
        }
        if (vm.version !== d.version) {
          fail(`${subPath} 的 vendor manifest 版本不一致：期望 ${d.version}，实际 ${vm.version}`);
        }
      } catch (e) {
        fail(`${subPath} 的 vendor ngm.json 不合法：${e.message}`);
      }
    }

    if (mappings) {
      const mapEntries = Array.isArray(mappings.mappings) ? mappings.mappings : [];
      const mapped = new Map();
      for (const m of mapEntries) {
        if (!m.path) continue;
        mapped.set(m.path, m);
        if (!declared.has(m.path)) fail(`ngm.mappings.json 登记了未声明模块：${m.path}`);
        if (m.to) {
          const abs = path.resolve(ROOT, m.to);
          if (!fs.existsSync(abs)) fail(`ngm.mappings.json 的 to 不存在：${m.to}`);
        }
      }
      for (const subPath of declared.keys()) {
        if (!mapped.has(subPath)) warn(`ngm.mappings.json 缺少 ${subPath} 的映射（不影响运行时）`);
      }
    }

    const vendorPackages = path.join(ROOT, 'ngm.vendor', VENDOR_REPO, 'packages');
    const found = new Set();
    if (fs.existsSync(vendorPackages)) {
      for (const domain of fs.readdirSync(vendorPackages)) {
        const domainDir = path.join(vendorPackages, domain);
        if (!fs.statSync(domainDir).isDirectory()) continue;
        for (const name of fs.readdirSync(domainDir)) {
          const moduleDir = path.join(domainDir, name);
          if (!fs.statSync(moduleDir).isDirectory()) continue;
          if (fs.existsSync(path.join(moduleDir, 'ngm.json'))) {
            found.add(`packages/${domain}/${name}`);
          }
        }
      }
    }
    for (const subPath of found) {
      if (!declared.has(subPath)) fail(`ngm.vendor 存在未登记模块：${subPath}`);
    }
    for (const subPath of declared.keys()) {
      if (!found.has(subPath)) fail(`ngm.vendor 缺少模块目录：${subPath}`);
    }

    const refCount = new Map();
    const files = [];
    walkFiles(ROOT, files);
    const refRe = /ngm\.vendor\/gitee\.com\/idcu\/ngm-repo\/(packages\/[A-Za-z0-9._/-]+)/g;
    for (const file of files) {
      if (file === fileURLToPath(import.meta.url)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(refRe)) {
        const refPath = match[1].replace(/\/$/, '');
        let owner = null;
        for (const subPath of declared.keys()) {
          if (refPath === subPath || refPath.startsWith(`${subPath}/`)) {
            owner = subPath;
            break;
          }
        }
        if (!owner) {
          fail(`${rel(file)} 引用了未登记 vendor 模块：${refPath}`);
        } else {
          refCount.set(owner, (refCount.get(owner) || 0) + 1);
        }
      }
    }
    for (const subPath of declared.keys()) {
      if (!refCount.has(subPath)) warn(`${subPath} 没有在源码/入口中以字面路径出现（可能由动态路径拼接）`);
    }

    const ngmVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '(missing)';
    /* 换行必须全 LF：moduleDigest 按**字节**算，CRLF 与 LF 是两个不同的内容。
       Windows 上 `core.autocrlf=true` 会在 checkout 时把 LF 换成 CRLF，于是 verify
       在本地红、在 Linux CI 绿——两边跑的是同一份代码，这类「平台相关」失效最难查。
       `.gitattributes` 的 `eol=lf` 是预防，这一条是**发现**：预防失效时它还在。 */
    const vendorDir = path.join(ROOT, 'ngm.vendor');
    const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.html']);
    const crlfFiles = [];
    const walkVendor = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        if (fs.statSync(abs).isDirectory()) { walkVendor(abs); continue; }
        if (!TEXT_EXT.has(path.extname(name))) continue;
        if (fs.readFileSync(abs).includes(0x0d)) crlfFiles.push(rel(abs));
      }
    };
    if (fs.existsSync(vendorDir)) walkVendor(vendorDir);
    if (crlfFiles.length) {
      fail(`ngm.vendor 里 ${crlfFiles.length} 个文件含 CRLF（应全为 LF）：${crlfFiles.slice(0, 3).join('、')}`
        + ' —— moduleDigest 按字节算，CRLF 会让 verify 在本机红、在 Linux CI 绿');
    }

    /* 适配层清单：公共模块升级改了导出名，适配层仍保留旧名字，调用方拿到 undefined，
       而没有任何东西会红。清单声明每个适配层依赖哪个公共模块、保留了哪些名字。
       反向扫全仓，保证新增适配层不会漏登记。 */
    const ADAPTER_MARK = /适配层|实现已抽到|实现由公共模块|保留原有.{0,20}全局导出名|适配 @idcu\//;
    const SKIP_SCAN = new Set(['node_modules', 'ngm.vendor', 'scripts', 'test', 'tests',
      'legacy', 'data', 'dist', 'analysis', '.trae', 'public', 'coverage', '.tmp']);
    const adapterFiles = [];
    const scanAdapters = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.') || SKIP_SCAN.has(name)) continue;
        const abs = path.join(dir, name);
        if (fs.statSync(abs).isDirectory()) { scanAdapters(abs); continue; }
        if (!name.endsWith('.js')) continue;
        if (ADAPTER_MARK.test(fs.readFileSync(abs, 'utf8').slice(0, 700))) adapterFiles.push(rel(abs));
      }
    };
    scanAdapters(ROOT);

    const adaptersDoc = readJson('contracts/adapters.json');
    if (!adaptersDoc) {
      fail('缺少 contracts/adapters.json（适配层清单本身也要在）');
    } else {
      const declaredPaths = new Set((project.dependencies || []).map((d) => d.path));
      const listed = new Set();
      for (const a of adaptersDoc.adapters || []) {
        listed.add(a.file);
        const full = path.join(ROOT, a.file);
        if (!fs.existsSync(full)) { fail(`适配层清单登记的文件不存在：${a.file}`); continue; }
        const src = fs.readFileSync(full, 'utf8');
        for (const m of a.modules || []) {
          if (!declaredPaths.has(m)) fail(`适配层 ${a.file} 声明依赖 ${m}，但 ngm.json 里没有`);
        }
        for (const k of a.keeps || []) {
          if (!src.includes(k)) fail(`适配层 ${a.file} 没有保留承诺的名字：${k}`);
        }
      }
      for (const f of adapterFiles) {
        if (!listed.has(f)) fail(`发现未登记的适配层：${f}（公共模块升级时它会静默失效）`);
      }
      console.log(`check-ngm: adapters ${listed.size} 条登记 / ${adapterFiles.length} 个实际适配层`);
    }

    if (errors.length) {
      console.error(`check-ngm: FAILED (${errors.length} error(s), ${warnings.length} warning(s))`);
      for (const e of errors) console.error(`  - ${e}`);
      for (const w of warnings) console.error(`  ! ${w}`);
      process.exit(1);
    }
    console.log(`check-ngm: OK (${declared.size} declared, ${locked.size} locked, ${found.size} vendor modules, ${refCount.size} referenced modules, ngm ${ngmVersion})`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }
}
