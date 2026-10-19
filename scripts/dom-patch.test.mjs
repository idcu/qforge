/**
 * DOM 增量更新对账逻辑单元测试（Node）
 * 覆盖 QB.DomPatch.plan / normalize：变化检测、新增/移除、顺序调整、去重与空区域过滤。
 * 说明：dom-patch 的 plan 不触碰 DOM，可在 Node 直接加载验证；patch 的 DOM 写入由浏览器端验证。
 * 运行：node scripts/dom-patch.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');

// 以 window 作为 global 执行 IIFE（与浏览器加载方式一致）；plan 不依赖 document
const win = {};
new Function('window', 'globalThis', fs.readFileSync(path.join(QB_DIR, 'js/modules/dom-patch.js'), 'utf8'))(win, win);
const DP = win.QB.DomPatch;

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function deepEq(a, b, l) { eq(JSON.stringify(a), JSON.stringify(b), l); }
function section(t) { console.log('\n== ' + t + ' =='); }

const R = (key, html) => ({ key: key, html: html });

section('首次渲染：全部区域为「变化」（需新建）');
{
  const p = DP.plan(null, [R('a', 'A'), R('b', 'B')]);
  deepEq(p.order, ['a', 'b'], '顺序 = 输入顺序');
  deepEq(p.changed, ['a', 'b'], '全部需重建（无上次快照）');
  deepEq(p.unchanged, [], '无未变区域');
  deepEq(p.removed, [], '无移除区域');
}

section('内容完全一致：全部「不重建」');
{
  const prev = { a: 'A', b: 'B' };
  const p = DP.plan(prev, [R('a', 'A'), R('b', 'B')]);
  deepEq(p.changed, [], '无区域需重建');
  deepEq(p.unchanged, ['a', 'b'], '全部保持原节点');
  deepEq(p.removed, [], '无移除');
}

section('单区域内容变化：仅该区域重建');
{
  const prev = { a: 'A', b: 'B', c: 'C' };
  const p = DP.plan(prev, [R('a', 'A'), R('b', 'B2'), R('c', 'C')]);
  deepEq(p.changed, ['b'], '仅 b 需重建');
  deepEq(p.unchanged, ['a', 'c'], 'a/c 不重建');
  deepEq(p.removed, [], '无移除');
}

section('新增 / 移除区域');
{
  const prev = { a: 'A', b: 'B' };
  const p = DP.plan(prev, [R('a', 'A'), R('b', 'B'), R('c', 'C')]);
  deepEq(p.changed, ['c'], '新增区域需重建（插入）');
  deepEq(p.removed, [], '无移除');

  const p2 = DP.plan(prev, [R('a', 'A')]);
  deepEq(p2.changed, [], '保留区域未变化');
  deepEq(p2.removed, ['b'], '消失区域被移除');
}

section('顺序调整：不触发重建，仅移动');
{
  const prev = { a: 'A', b: 'B' };
  const p = DP.plan(prev, [R('b', 'B'), R('a', 'A')]);
  deepEq(p.order, ['b', 'a'], '顺序随输入更新');
  deepEq(p.changed, [], '内容未变 → 不重建（交由 patch 原地移动）');
  deepEq(p.unchanged, ['b', 'a'], '两块均保持原节点');
}

section('健壮性：空区域过滤、重复 key 去重、空输入');
{
  const p = DP.plan(null, [R('a', 'A'), R('b', ''), null, R('a', 'A2')]);
  deepEq(p.order, ['a'], '空 html / 空元素被过滤，重复 key 只保留首个');
  deepEq(p.changed, ['a'], '仅保留的有效区域需重建');

  const p2 = DP.plan(null, []);
  deepEq(p2.order, [], '空输入 → 空顺序');
  deepEq(p2.changed, [], '空输入 → 无变化');
  deepEq(p2.removed, [], '空输入 → 无移除');

  const p3 = DP.plan({ a: 'A' }, []);
  deepEq(p3.removed, ['a'], '本次为空 → 上次区域全部移除');

  deepEq(DP.normalize(null), [], 'normalize(null) → 空数组');
}

section('列表场景：移除一条只影响被移除区域与计数区域');
{
  const items = [
    { k: 'k1', h: '<div class="list-item" data-region="i-k1">1</div>' },
    { k: 'k2', h: '<div class="list-item" data-region="i-k2">2</div>' },
    { k: 'k3', h: '<div class="list-item" data-region="i-k3">3</div>' }
  ];
  const regions = [{ key: 'toolbar', html: '<div class="toolbar" data-region="toolbar">T</div>' }]
    .concat(items.map((it) => R('i-' + it.k, it.h)))
    .concat([R('pager', '<div class="pager" data-region="pager">3 题</div>')]);
  const prev = {};
  regions.forEach((r) => { prev[r.key] = r.html; });

  const after = [{ key: 'toolbar', html: '<div class="toolbar" data-region="toolbar">T</div>' }]
    .concat(items.slice(1).map((it) => R('i-' + it.k, it.h)))
    .concat([R('pager', '<div class="pager" data-region="pager">2 题</div>')]);
  const p = DP.plan(prev, after);
  deepEq(p.removed, ['i-k1'], '被删条目区域移除');
  deepEq(p.changed, ['pager'], '仅计数区域需重建');
  deepEq(p.unchanged, ['toolbar', 'i-k2', 'i-k3'], '工具栏与未涉及条目保持原节点');
}

section('子区域（格级）：frame 稳定、contentOf 取帧、snapshot 快照');
{
  const card1 = { key: 'card', frame: 'F', sub: [{ key: 'n', into: 'c', html: '1' }, { key: 'cell0', into: 'g', html: '<b class="x">0</b>' }] };
  const card2 = { key: 'card', frame: 'F', sub: [{ key: 'n', into: 'c', html: '2' }, { key: 'cell0', into: 'g', html: '<b class="x">0</b>' }] };
  const card3 = { key: 'card', frame: 'F2', sub: card2.sub };
  eq(DP.contentOf(card1), 'F', 'contentOf：有 frame 取 frame（与子区域内容无关）');
  eq(DP.contentOf(R('a', 'A')), 'A', 'contentOf：无 frame 取 html');
  const p1 = DP.plan(DP.snapshot([card1]), [card2]);
  deepEq(p1.unchanged, ['card'], '帧未变 → 顶层「不重建」（子区域变化不触发整区域重建）');
  const p2 = DP.plan(DP.snapshot([card1]), [card3]);
  deepEq(p2.changed, ['card'], '帧变化 → 顶层重建');
  const s = DP.snapshot([card1, R('b', 'B')]);
  deepEq(Object.keys(s), ['card', 'b'], 'snapshot 键序与区域顺序一致');
  eq(s.card, 'F', 'snapshot 存 frame 而非 html');

  const n = DP.normalize([{ key: 'k', frame: 'F', sub: [{ key: 's', into: 'c', html: 'x' }] }]);
  eq(n.length, 1, 'normalize：仅 frame 的区域不被过滤');
  ok(n[0].sub && n[0].sub.length === 1, 'normalize：保留 sub');
  deepEq(DP.normalize([{ key: 'k2' }]), [], 'normalize：html/frame 皆空 → 过滤');
}

section('子区域分组：groupSub 按容器归组、去重、剔除不合法项');
{
  const g = DP.groupSub([
    { key: 'n', into: 'c', html: '1' },
    { key: 'a', into: 'g', html: 'A' },
    { key: 'b', into: 'g', html: 'B' },
    { key: 'a', into: 'g', html: 'A2' },
    { key: 'bad', into: 'g' },
    null
  ]);
  deepEq(Array.from(g.keys()), ['c', 'g'], '分组键序 = 首次出现顺序');
  deepEq(g.get('c').map((s) => s.key), ['n'], '单元素容器');
  deepEq(g.get('g').map((s) => s.key), ['a', 'b'], '同容器按声明顺序，重复 key 只保留首个');
  eq(DP.groupSub(null).size, 0, 'groupSub(null) → 空分组');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('DOM 增量更新对账单元测试全部通过 ✅');
