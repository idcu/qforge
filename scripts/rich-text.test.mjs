/**
 * 富文本渲染器单元测试（纯函数，Node）
 * 覆盖：转义防注入、上标/下标语法、裸 ^/_ 不误伤、toPlain、null 安全。
 * 运行：node scripts/rich-text.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));

let pass = 0;
const failures = [];
function ok(c, l, extra) { if (c) { pass++; console.log('  ✓ ' + l + (extra ? '  ' + extra : '')); } else { failures.push(l); console.log('  ✗ ' + l + (extra ? '  ' + extra : '')); } }
function eq(a, b, l) { ok(a === b, l, '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }
const { render, toPlain } = QB.RichText;

section('空值与原样输出');
eq(render(null), '', 'render(null)');
eq(render(undefined), '', 'render(undefined)');
eq(render(0), '0', 'render(0) 转字符串');
eq(render('普通中文题干，不含记号'), '普通中文题干，不含记号', '普通文本原样');

section('HTML 转义（防注入）');
eq(render('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;', '标签转义');
eq(render('a & b < c > d'), 'a &amp; b &lt; c &gt; d', '& <> 转义');
eq(render('"引号" \'单引号\''), '&quot;引号&quot; &#39;单引号&#39;', '引号转义');
eq(render('x^{<img src=x onerror=alert(1)>}'),
  'x<sup>&lt;img src=x onerror=alert(1)&gt;</sup>', '上标内部仍转义（无注入）');

section('上标/下标');
eq(render('x^{2}'), 'x<sup>2</sup>', '基本上标');
eq(render('a_{n}'), 'a<sub>n</sub>', '基本下标');
eq(render('a_{n+1}^{2}'), 'a<sub>n+1</sub><sup>2</sup>', '下标+上标连用');
eq(render('H_{2}O 与 E=mc^{2}'), 'H<sub>2</sub>O 与 E=mc<sup>2</sup>', '化学式与公式混排');
eq(render('10^{3} = 1000'), '10<sup>3</sup> = 1000', '数字上标');

section('裸符号不误伤（必须花括号定界）');
eq(render('E=mc^2 但没括号'), 'E=mc^2 但没括号', '裸 ^ 原样');
eq(render('snake_case 命名'), 'snake_case 命名', '裸 _ 原样');
eq(render('2^3 与 a_b'), '2^3 与 a_b', '裸 ^ _ 均原样');
eq(render('^{}'), '<sup></sup>', '空上标也转换（显式语法）');

section('toPlain 去记号');
eq(toPlain('x^{2}'), 'x2', '上标去记号保留内容');
eq(toPlain('a_{n+1}^{2}'), 'an+12', '连续记号展开');
eq(toPlain('E=mc^2'), 'E=mc^2', '裸符号保留');
eq(toPlain('<b>x'), '<b>x', 'toPlain 不转义（契约：HTML 前调用方自行转义）');
eq(toPlain(null), '', 'toPlain(null)');

section('与 escapeHtml 的安全组合（列表用法）');
eq(QB.escapeHtml(toPlain('x^{2}<b>')), 'x2&lt;b&gt;', 'toPlain 后转义可安全入 HTML');

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('FAILED: ' + f)); process.exit(1); }
console.log('富文本渲染器单元测试全部通过 ✅');
