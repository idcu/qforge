/**
 * 组卷蓝图单元测试（Node）
 * 运行：node scripts/blueprint.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

function mk(type, i, extra) {
  return Object.assign({
    id: 'q' + i, type: type, question: type + ' 题 ' + i,
    options: type === 'judge' ? [] : [
      { letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }, { letter: 'C', text: '丙' }
    ],
    answer: type === 'judge' ? '正确' : (type === 'multi' ? 'AB' : 'A'),
    difficulty: 0, category: '', tags: []
  }, extra || {});
}
const pool = [];
for (let i = 0; i < 10; i++) pool.push(mk('single', i, { difficulty: (i % 5) + 1, category: i % 2 ? '奇数类' : '偶数类', tags: i % 3 === 0 ? ['重点'] : [] }));
for (let i = 10; i < 16; i++) pool.push(mk('judge', i));
for (let i = 16; i < 20; i++) pool.push(mk('multi', i));

section('按题型数量组卷');
{
  const r = QB.Blueprint.compose(pool, { seed: 1, keepOrder: true, items: [{ type: 'single', count: 3 }, { type: 'judge', count: 2 }] });
  eq(r.questions.length, 5, '3 单选 + 2 判断 = 5');
  const types = {};
  r.questions.forEach((q) => { types[q.type] = (types[q.type] || 0) + 1; });
  eq(types.single, 3, '单选 3');
  eq(types.judge, 2, '判断 2');
  eq(r.shortages.length, 0, '无缺口');
}
{
  const r = QB.Blueprint.compose(pool, { seed: 1, items: [{ type: 'multi', count: 9 }] });
  eq(r.questions.length, 4, '多选只有 4，实际 4');
  eq(r.shortages.length, 1, '产生缺口');
  eq(r.shortages[0].want, 9, '缺口 want=9');
  eq(r.shortages[0].got, 4, '缺口 got=4');
}

section('分类 / 难度 / 标签过滤');
{
  const r = QB.Blueprint.compose(pool, { seed: 2, category: '偶数类', items: [{ type: 'single', count: 10 }] });
  eq(r.questions.length, 5, '偶数类单选共 5（i=0,2,4,6,8）');
  ok(r.questions.every((q) => q.category === '偶数类'), '结果均属偶数类');
  const hard = QB.Blueprint.compose(pool, { seed: 2, minDifficulty: 4, items: [{ type: 'single', count: 10 }] });
  eq(hard.questions.length, 4, '难度≥4 的单选 4 道（d=4,5,4,5）');
  ok(hard.questions.every((q) => q.difficulty >= 4), '难度下限生效');
  const range = QB.Blueprint.compose(pool, { seed: 2, minDifficulty: 2, maxDifficulty: 3, items: [{ type: 'single', count: 10 }] });
  ok(range.questions.every((q) => q.difficulty >= 2 && q.difficulty <= 3), '难度闭区间生效');
  const tagged = QB.Blueprint.compose(pool, { seed: 2, tags: ['重点'], items: [{ type: 'single', count: 10 }] });
  ok(tagged.questions.every((q) => (q.tags || []).indexOf('重点') >= 0), '标签过滤生效');
}

section('可用数量与可复现');
{
  const av = QB.Blueprint.availability(pool, {});
  eq(av.single, 10, 'availability.single=10');
  eq(av.judge, 6, 'availability.judge=6');
  const a = QB.Blueprint.compose(pool, { seed: 7, items: [{ type: 'single', count: 5 }] }).questions.map((q) => q.id).join(',');
  const b = QB.Blueprint.compose(pool, { seed: 7, items: [{ type: 'single', count: 5 }] }).questions.map((q) => q.id).join(',');
  eq(a, b, '相同 seed 抽题可复现');
  ok(!pool.some((q) => q._moved), '组卷不修改题池');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('组卷蓝图单元测试全部通过 ✅');