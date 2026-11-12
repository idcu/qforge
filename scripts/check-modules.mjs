/**
 * check-modules.mjs —— 装配顺序判据（零依赖）
 *
 * 这个项目用 classic `<script>` 顺序加载来"装配"模块：没有打包器，**顺序就是依赖图**。
 * 顺序错了的表现不在启动时报错，而在某个页面第一次用某个功能时才 `undefined`。
 *
 * 唯一事实源是 `contracts/modules.json`（装配清单）：它声明每个脚本的 id / 文件 / 层 / 前置依赖 /
 * 导出符号。清单分两段：
 *   - core（不带 load 字段）：`index.html` 的**投影**，判据核对两边逐条一致；
 *   - on-demand（`load: "on-demand"`）：不进首屏，由 `js/modules/loader.js` 的 `QB.BUNDLES`
 *     在用户动作时按序注入。
 *
 * 查九件事：
 *   1. 清单合法：schemaVersion=1、id 唯一、core 的 at 连续、每个文件都存在；
 *   2. `index.html` 的 `<script src>` 序列与 core 条目**逐条相等**（加/删/调序都要同步改清单）；
 *   3. `requires` 是数组、id 存在、不重复，且确实排在本条之前（加载期前置依赖 DAG：
 *      core 看 at 序号；on-demand 看所属 bundle 内的位置，跨包只允许依赖 core 或同包更早项）；
 *   4. 按需包合法：包内文件都存在、每个 on-demand 模块恰好出现在至少一个包里、包内无重复、
 *      包内顺序满足 requires；
 *   5. `keeps` 是数组且**每个声明都在本模块源码里有对应赋值**（防误删导出后静默 undefined）；
 *   6. 入口 `js/app.js` 最后、配置 `js/config.js` 最先（`sample-data` 例外）；
 *   7. `js/**` 下每个脚本都被引用（首屏或按需包；`js/workers/*` 例外，由 Worker 自己加载）；
 *   8. `index.html` 里写的每个 src 都真实存在；
 *   9. 依赖方向：`tier` 必须为枚举值，`requires` 的目标 `tier` 不得高于本条（L3 > L2 > L1 > L0）；
 *      确有向上依赖的必须登记 `allowUpward: [{id, until, reason}]`，到期即判红（不允许无限期挂账）。
 *      core 经 `QB.Loader.ensure` 取用的按需模块登记在 `lazyRequires`，且源码必须真的出现 `QB.Loader.ensure(`。
 *
 * 用法：
 *   node scripts/check-modules.mjs            校验仓库
 *   node scripts/check-modules.mjs --selftest 负例自检（乱序 / 不存在依赖 / 删导出 / tier 向上 / 例外到期 必须全红）
 * 退出码：0 通过；1 有违约（selftest 下：1 = 未全部拦截，0 = 全部拦截成功）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SAMPLE = 'js/data/sample-data.js';
const ENTRY = 'js/app.js';
const CONFIG = 'js/config.js';
const MANIFEST = path.join(ROOT, 'contracts', 'modules.json');
const LOADER = path.join(ROOT, 'js', 'modules', 'loader.js');

const problems = [];
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1].replace(/\\/g, '/'));
const localJs = srcs.filter((s) => s.startsWith('js/'));

let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (e) {
  problems.push('装配清单不可读：' + e.message);
}

/** 从 loader.js 解析按需包（唯一事实源在该文件；这里只读不写） */
function readBundles() {
  const bundles = new Map();
  if (!fs.existsSync(LOADER)) return bundles;
  const src = fs.readFileSync(LOADER, 'utf8');
  const start = src.indexOf('const BUNDLES = {');
  if (start < 0) return bundles;
  const end = src.indexOf('\n  };', start);
  const block = src.slice(start, end > 0 ? end : src.length);
  const re = /([A-Za-z_$][\w$]*)\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(block))) {
    const files = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    bundles.set(m[1], files);
  }
  return bundles;
}
const bundles = readBundles();

/** tier 方向：L3 表现 > L2 领域 > L1 数据 > L0 基础；P 为外围，不参与方向比较 */
const TIER_RANK = { L0: 0, L1: 1, L2: 2, L3: 3, P: null };
const isLazy = (m) => m.load === 'on-demand';

/** core 的顺序位置 / on-demand 在**每个**包含它的包里的位置（同一模块可被多个包复用） */
function positionTable(mods) {
  const pos = new Map();
  const core = mods.filter((m) => !isLazy(m)).sort((a, b) => a.at - b.at);
  core.forEach((m, i) => pos.set(m.id, { kind: 'core', index: i + 1 }));
  for (const [name, files] of bundles) {
    files.forEach((f, i) => {
      const m = mods.find((x) => String(x.file) === f);
      if (!m || !isLazy(m)) return;
      const cur = pos.get(m.id);
      if (cur && cur.kind === 'bundle') cur.placements.push({ bundle: name, index: i });
      else pos.set(m.id, { kind: 'bundle', placements: [{ bundle: name, index: i }] });
    });
  }
  return pos;
}

/** 1/2/3/4/5/9：纯清单校验（selftest 复用同一实现，避免自检与被检逻辑分叉） */
function checkManifest(mods, sources, today = new Date(), srcList = srcs, bundleMap = bundles) {
  const out = [];
  const stats = { upward: 0, allowed: 0 };
  const ids = new Set();
  const byId = new Map();
  const core = [];
  mods.forEach((m, i) => {
    if (ids.has(m.id)) out.push(`清单 id 重复：${m.id}`);
    ids.add(m.id);
    byId.set(m.id, m);
    if (isLazy(m)) {
      if (m.at !== undefined) out.push(`${m.id} 是按需模块，不应有 at（实际 ${m.at}）`);
      if (m.load !== 'on-demand') out.push(`${m.id} 的 load 只能是 "on-demand"（实际 ${m.load}）`);
    } else {
      core.push(m);
    }
    if (m.load !== undefined && m.load !== 'on-demand') out.push(`${m.id} 的 load 非法：${m.load}`);
    if (!Array.isArray(m.requires)) out.push(`${m.id} 缺少 requires 数组`);
    if (!Array.isArray(m.keeps)) out.push(`${m.id} 缺少 keeps 数组`);
  });
  core.forEach((m, i) => {
    if (m.at !== i + 1) out.push(`${m.id} 的 at 应为 ${i + 1}，实际 ${m.at}`);
  });

  /* 4. 按需包合法 */
  const fileToMod = new Map(mods.map((m) => [String(m.file), m]));
  const covered = new Set();
  for (const [name, files] of bundleMap) {
    if (!files.length) out.push(`按需包 ${name} 为空`);
    const seen = new Set();
    files.forEach((f, i) => {
      if (seen.has(f)) out.push(`按需包 ${name} 重复列出 ${f}`);
      seen.add(f);
      if (!fs.existsSync(path.join(ROOT, f))) out.push(`按需包 ${name} 的文件不存在：${f}`);
      const m = fileToMod.get(f);
      if (!m) out.push(`按需包 ${name} 的文件未在清单登记：${f}`);
      else if (!isLazy(m)) out.push(`按需包 ${name} 的文件 ${f} 未标 load:"on-demand"（它会同时进首屏）`);
      else covered.add(m.id);
    });
  }
  for (const m of mods) {
    if (!isLazy(m)) continue;
    if (!covered.has(m.id)) out.push(`按需模块 ${m.id}（${m.file}）没有被任何按需包包含`);
    if (!String(m.file).startsWith('js/') && !String(m.file).startsWith('ngm.vendor/')) {
      out.push(`${m.id} 的文件路径不在 js/ 或 ngm.vendor/ 下`);
    }
  }

  /* 9. 依赖方向（tier 不得向上；例外须登记且未到期） */
  mods.forEach((m) => {
    if (m.tier === undefined || TIER_RANK[m.tier] === undefined) {
      out.push(`${m.id} 的 tier 非法：${m.tier}（应为 L0 / L1 / L2 / L3 / P）`);
      return;
    }
    const allow = new Map();
    if (m.allowUpward !== undefined) {
      if (!Array.isArray(m.allowUpward)) {
        out.push(`${m.id} 的 allowUpward 必须是数组`);
      } else {
        m.allowUpward.forEach((e) => {
          if (!e || typeof e.id !== 'string' || typeof e.until !== 'string' || typeof e.reason !== 'string') {
            out.push(`${m.id} 的 allowUpward 条目必须含 id / until / reason`);
            return;
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(e.until)) {
            out.push(`${m.id} 的 allowUpward ${e.id} until 非法：${e.until}（应为 YYYY-MM-DD）`);
          } else if (new Date(e.until + 'T23:59:59Z') < today) {
            out.push(`${m.id} 的向上依赖例外 ${e.id} 已到期（until ${e.until}）：必须解除或重新评审，不得延期挂账`);
          }
          if (!ids.has(e.id)) out.push(`${m.id} 的 allowUpward 指向不存在的 id：${e.id}`);
          allow.set(e.id, e);
        });
      }
    }
    const rank = TIER_RANK[m.tier];
    if (rank === null) return; // P 不参与方向比较
    const used = new Set();
    for (const dep of m.requires || []) {
      const d = byId.get(dep);
      if (!d || TIER_RANK[d.tier] === null) continue;
      if (TIER_RANK[d.tier] > rank) {
        used.add(dep);
        if (allow.has(dep)) stats.allowed++;
        else {
          stats.upward++;
          out.push(`${m.id}（${m.tier}）向上依赖 ${dep}（${d.tier}）：未登记 allowUpward`);
        }
      }
    }
    allow.forEach((e, depId) => {
      if (!used.has(depId)) out.push(`${m.id} 登记了 allowUpward ${depId}，但当前已不构成向上依赖（请删除过期例外）`);
    });
  });

  // 2. index.html 与 core 条目逐条一致
  const declared = core.map((m) => String(m.file));
  if (declared.length !== srcList.length) {
    out.push(`index.html 有 ${srcList.length} 个 script，清单 core 有 ${declared.length} 条`);
  }
  for (let i = 0; i < Math.max(declared.length, srcList.length); i++) {
    if (declared[i] !== srcList[i]) {
      out.push(`第 ${i + 1} 项不一致：清单 ${declared[i] || '（无）'} / index.html ${srcList[i] || '（无）'}`);
      break; // 一次错位就够了，别刷屏
    }
  }

  // 3. requires 顺序（core 看 at；on-demand 看包内位置）
  const pos = positionTable(mods);
  mods.forEach((m) => {
    const seen = new Set();
    for (const dep of m.requires || []) {
      if (seen.has(dep)) out.push(`${m.id} 重复依赖 ${dep}`);
      seen.add(dep);
      if (!ids.has(dep)) { out.push(`${m.id} 依赖了清单里不存在的 id：${dep}`); continue; }
      const me = pos.get(m.id);
      const it = pos.get(dep);
      if (!me) { out.push(`${m.id} 没有加载位置（core 缺 at / 按需缺包）`); continue; }
      if (!it) { out.push(`${m.id} 依赖 ${dep}，但它没有加载位置`); continue; }
      if (me.kind === 'core') {
        if (it.kind !== 'core') out.push(`${m.id} 依赖按需模块 ${dep}：请改用 lazyRequires（经 QB.Loader.ensure 取用）`);
        else if (it.index >= me.index) out.push(`${m.id} 依赖 ${dep}，但 ${dep} 没有排它前面`);
      } else {
        if (it.kind === 'core') continue; // 依赖首屏已加载的模块
        // 同一模块可能在多个包里；只要有一个包满足「依赖同包且更早」即可
        const ok = me.placements.some((p) =>
          it.placements.some((q) => q.bundle === p.bundle && q.index < p.index));
        if (!ok) {
          const mine = me.placements.map((p) => p.bundle).join('/');
          const theirs = it.placements.map((p) => p.bundle).join('/');
          out.push(`${m.id} 依赖 ${dep}，但没有任何按需包同时满足「同包 + 更早」（我：${mine} / 它：${theirs}）`);
        }
      }
    }
    // lazyRequires：core → on-demand，且源码必须真的 await QB.Loader.ensure
    for (const dep of m.lazyRequires || []) {
      const d = byId.get(dep);
      if (!d) { out.push(`${m.id} 的 lazyRequires 指向不存在的 id：${dep}`); continue; }
      if (!isLazy(d)) out.push(`${m.id} 的 lazyRequires ${dep} 不是按需模块`);
      const src = sources.get(m.file);
      if (src != null && !/QB\.Loader\.ensure\s*\(/.test(src)) {
        out.push(`${m.id} 登记了 lazyRequires ${dep}，但源码里没有 QB.Loader.ensure( 调用`);
      }
    }
    for (const keep of m.keeps || []) {
      const re = definitionRe(keep);
      if (!re) {
        out.push(`${m.id} 的 keeps 路径非法：${keep}（仅支持 QB.X / window.X / globalThis.X）`);
        continue;
      }
      const src = sources.get(m.file);
      if (src == null) { // 文件存在性由第 1 条单独报，这里不重复刷屏
        continue;
      }
      if (!re.test(src)) out.push(`${m.id} 未导出声明的 ${keep}（源码里找不到对应赋值）`);
    }
  });
  return { problems: out, stats: stats };
}

function definitionRe(keep) {
  const m = /^(QB|window|globalThis)\.([A-Za-z_$][\w$]*)$/.exec(String(keep));
  if (!m) return null;
  const name = m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (m[1] === 'QB') return new RegExp('\\bQB\\.' + name + '\\s*=');
  // vendor 的 UMD 可能把根别名写成 global/root/self
  return new RegExp('\\b(?:window|globalThis|global|root|self)\\.' + name + '\\s*=');
}

let tierStats = { upward: 0, allowed: 0 };
if (manifest) {
  if (manifest.schemaVersion !== 1) problems.push(`schemaVersion 应为 1，实际 ${manifest.schemaVersion}`);
  const mods = manifest.modules || [];
  mods.forEach((m) => {
    if (!fs.existsSync(path.join(ROOT, String(m.file)))) {
      problems.push(`清单登记的文件不存在：${m.file}`);
    }
  });
  const sources = new Map(mods.map((m) => {
    const full = path.join(ROOT, String(m.file));
    return [m.file, fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null];
  }));
  const checked = checkManifest(mods, sources);
  problems.push(...checked.problems);
  tierStats = checked.stats;
}

/* 6. 入口最后 / 配置最先
   例外：清单里标了 loadAfterEntry: true 的「运行时路由」允许排在入口之后
   （入口只在 ready 后调用它们；此类模块自身不得在加载时执行依赖入口的逻辑）。 */
if (!localJs.includes(ENTRY)) problems.push(`找不到入口 ${ENTRY}`);
else if (localJs[localJs.length - 1] !== ENTRY) {
  const tailAllowed = new Set(((manifest && manifest.modules) || [])
    .filter((m) => m.loadAfterEntry === true).map((m) => String(m.file)));
  const after = localJs.slice(localJs.indexOf(ENTRY) + 1);
  const unexpected = after.filter((f) => !tailAllowed.has(f));
  if (unexpected.length) {
    const preview = unexpected.slice(0, 3).join(', ') + (unexpected.length > 3 ? ` 等 ${unexpected.length} 个` : '');
    problems.push(`${ENTRY} 不是最后一个 js 脚本，其后有未标 loadAfterEntry 的脚本：${preview}`);
  }
}
const firstJs = localJs.find((s) => s !== SAMPLE);
if (firstJs !== CONFIG) {
  problems.push(`第一个被加载的 js 脚本应是 ${CONFIG}，实际是 ${firstJs}`);
}

/* 7/8. 无孤儿 / 引用存在 */
for (const src of srcs) {
  if (!fs.existsSync(path.join(ROOT, src))) problems.push(`index.html 引用不存在：${src}`);
}
const bundleFiles = new Set();
for (const files of bundles.values()) for (const f of files) bundleFiles.add(f);
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, out); continue; }
    if (e.name.endsWith('.js')) out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
  return out;
};
for (const f of walk(path.join(ROOT, 'js'))) {
  if (f.startsWith('js/workers/')) continue;
  if (!srcs.includes(f) && !bundleFiles.has(f)) problems.push(`孤儿脚本（首屏与按需包都没有加载它）：${f}`);
}

/* 10. 离线：按需包必须全部进 SW 预缓存（首屏不请求它们，只能靠 install 预缓存） */
{
  const swPath = path.join(ROOT, 'sw.js');
  const swSrc = fs.existsSync(swPath) ? fs.readFileSync(swPath, 'utf8') : '';
  const coreBlock = /const CORE = \[([\s\S]*?)\];/.exec(swSrc);
  const precached = new Set(coreBlock ? [...coreBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/^\.\//, '')) : []);
  for (const [name, files] of bundles) {
    for (const f of files) {
      if (!precached.has(f)) problems.push(`按需包 ${name} 的 ${f} 未在 sw.js 的 CORE 预缓存（断网时该功能不可用）`);
    }
  }
}

/* ---- 负例自检：证明「乱序 / 不存在依赖 / 删导出 / tier 向上 / 例外到期」真的会被判红 ---- */
if (process.argv.includes('--selftest')) {
  const mods = manifest.modules;
  const baseSources = new Map(mods.map((m) => [m.file, fs.readFileSync(path.join(ROOT, m.file), 'utf8')]));
  const cloneMods = () => JSON.parse(JSON.stringify(mods));
  const cases = [
    ['乱序（交换第 2/3 项）', () => {
      const bad = cloneMods();
      const tmp = bad[1];
      bad[1] = bad[2];
      bad[2] = tmp;
      return checkManifest(bad, baseSources).problems.some((p) => p.includes('项不一致'));
    }],
    ['不存在依赖（requires 指向 ghost）', () => {
      const bad = cloneMods();
      bad[2].requires = (bad[2].requires || []).concat('ghost.module');
      return checkManifest(bad, baseSources).problems.some((p) => p.includes('不存在的 id'));
    }],
    ['删导出（移除 QB.Storage 赋值）', () => {
      const bad = mods.map((m) => ({ ...m }));
      const sources = new Map(baseSources);
      const target = bad.find((m) => (m.keeps || []).includes('QB.Storage'));
      const src = sources.get(target.file);
      sources.set(target.file, src.replace(/\bQB\.Storage\s*=/, '/* removed */'));
      return checkManifest(bad, sources).problems.some((p) => p.includes('未导出声明的 QB.Storage'));
    }],
    ['core 直接依赖按需模块（未走 lazyRequires）', () => {
      const bad = cloneMods();
      const lazy = bad.find((m) => m.load === 'on-demand');
      const core = bad.find((m) => !m.load && m.id !== 'app');
      core.requires = (core.requires || []).concat(lazy.id);
      return checkManifest(bad, baseSources).problems.some((p) => p.includes('改用 lazyRequires'));
    }],
    ['按需模块缺包', () => {
      const bad = cloneMods();
      const lazy = bad.find((m) => m.load === 'on-demand');
      const map = new Map(bundles);
      for (const [k, v] of map) map.set(k, v.filter((f) => f !== lazy.file));
      return checkManifest(bad, baseSources, new Date(), srcs, map).problems.some((p) => p.includes('没有被任何按需包包含'));
    }],
    ['tier 向上依赖未登记', () => {
      const bad = cloneMods();
      const low = bad.find((m) => m.tier === 'L0');
      const high = bad.find((m) => m.tier === 'L3' && !m.load);
      low.requires = (low.requires || []).concat(high.id);
      return checkManifest(bad, baseSources).problems.some((p) => p.includes('未登记 allowUpward'));
    }],
    ['allowUpward 已到期（until 2000-01-01）', () => {
      const bad = cloneMods();
      const low = bad.find((m) => m.tier === 'L0');
      const high = bad.find((m) => m.tier === 'L3' && !m.load);
      low.requires = (low.requires || []).concat(high.id);
      low.allowUpward = [{ id: high.id, until: '2000-01-01', reason: 'selftest' }];
      return checkManifest(bad, baseSources).problems.some((p) => p.includes('已到期'));
    }],
    ['tier 非法（写成 L9）', () => {
      const bad = cloneMods();
      bad[2].tier = 'L9';
      return checkManifest(bad, baseSources).problems.some((p) => p.includes('tier 非法'));
    }]
  ];
  let caught = 0;
  console.log('== check-modules 负例自检 ==');
  cases.forEach(([name, run]) => {
    const ok = run();
    if (ok) caught++;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok ? '：已拦截' : '：未拦截（判据失效）'));
  });
  console.log(`自检: ${caught}/${cases.length} 已拦截`);
  process.exitCode = caught === cases.length ? 0 : 1;
} else {
  const layerCount = manifest ? new Set((manifest.modules || []).map((m) => m.layer)).size : 0;
  const keepCount = manifest ? (manifest.modules || []).reduce((n, m) => n + (m.keeps || []).length, 0) : 0;
  const lazyCount = manifest ? (manifest.modules || []).filter((m) => m.load === 'on-demand').length : 0;
  const tierDist = manifest
    ? Object.entries((manifest.modules || []).reduce((acc, m) => {
        acc[m.tier] = (acc[m.tier] || 0) + 1;
        return acc;
      }, {})).map(([t, n]) => t + ':' + n).join(' ')
    : '';
  console.log(`modules: ${localJs.length} 个本地脚本 + ${srcs.length - localJs.length} 个 vendor（首屏），`
    + `${manifest ? (manifest.modules || []).length : 0} 条清单（其中按需 ${lazyCount} 条 / ${bundles.size} 个包），`
    + `${layerCount} 层，${keepCount} 个导出符号，${problems.length} 处违约`);
  console.log(`tier: ${tierDist}；未登记向上依赖 ${tierStats.upward}，已登记例外 ${tierStats.allowed}`);
  for (const p of problems) console.error('  - ' + p);
  process.exitCode = problems.length ? 1 : 0;
}
