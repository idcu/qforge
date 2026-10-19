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

section('图片资产占位');
{
  const id = 'as1a2b3c4d-12345';
  const html = render('见图 ![](asset:' + id + ') 说明');
  ok(html.indexOf('<img class="rt-img" data-asset="' + id + '"') >= 0, 'render 输出 data-asset 占位');
  ok(html.indexOf('src=') < 0, '占位无 src（等待 hydrate）');
  const withAlt = render('![电路图](asset:' + id + ')');
  ok(withAlt.indexOf('alt="电路图"') >= 0, 'alt 保留');
  const evil = render('![<script>](asset:' + id + ')');
  ok(evil.indexOf('<script>') < 0 && evil.indexOf('&lt;script&gt;') >= 0, 'alt 中 HTML 转义');
  const supAlt = render('![x^{2}](asset:' + id + ')');
  ok(supAlt.indexOf('<sup>', supAlt.indexOf('alt=')) < 0, 'alt 中上下标标签不进属性');
  eq(toPlain('前 ![](asset:' + id + ') 后'), '前 [图] 后', 'toPlain 图片→[图]');
  eq(toPlain('![电路](asset:' + id + ')'), '[电路]', 'toPlain 保留 alt 文案');
  const ids = QB.RichText.collectAssets(
    'a ![](asset:' + id + ')',
    '![](asset:as00000000-1)',
    '重复 ![](asset:' + id + ')');
  eq(ids.length, 2, 'collectAssets 跨参数去重（2 个）');
  ok(ids[0] === id && ids[1] === 'as00000000-1', 'collectAssets 保持出现顺序');
  const qIds = QB.RichText.questionAssetIds({
    question: '![](asset:as00000000-1)',
    options: [{ text: '![](asset:as00000000-1)' }, { text: '![](asset:as00000002-2)' }],
    analysis: '解析无图'
  });
  eq(qIds.length, 2, 'questionAssetIds 扫描题干/选项/分析去重');
  const mIds = QB.RichText.questionAssetIds({
    type: 'material',
    question: '引导语无图',
    material: '共享材料正文 ![](asset:as00000003-3)',
    options: [],
    children: [
      { type: 'single', question: '小问 ![](asset:as00000004-4)', options: [{ text: '![](asset:as00000003-3)' }], analysis: '' }
    ]
  });
  eq(mIds.length, 2, 'questionAssetIds 扫材料正文 + 递归小问（去重）');
  ok(mIds[0] === 'as00000003-3' && mIds[1] === 'as00000004-4', '材料题资产顺序：材料正文→小问');
}

section('编辑器光标插入（insertAtCursor）');
{
  const el = {
    value: '题干ABC', selectionStart: 2, selectionEnd: 2,
    events: 0, caret: null,
    dispatchEvent() { this.events++; },
    setSelectionRange(a) { this.caret = a; },
    focus() {}
  };
  QB.QuestionEditor.insertAtCursor(el, '![](asset:as00000000-1)');
  eq(el.value, '题干![](asset:as00000000-1)ABC', '插入到光标位置');
  eq(el.caret, 2 + '![](asset:as00000000-1)'.length, '光标移到插入内容后');
  eq(el.events, 1, '触发 input 事件');
  const el2 = { value: 'xyz', selectionStart: undefined, selectionEnd: undefined, dispatchEvent() {}, setSelectionRange() {}, focus() {} };
  QB.QuestionEditor.insertAtCursor(el2, '[图]');
  eq(el2.value, 'xyz[图]', '无选区信息时追加到末尾');
}

section('hydrate：资产绑定与缺失占位（假 DOM）');
await (async () => {
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  const id = await QB.Assets.put(new TextEncoder().encode('img-bytes'), 'image/png');
  let revoked = 0;
  let created = 0;
  const createdUrls = [];
  const prevDoc = globalThis.document;
  const prevCreate = URL.createObjectURL;
  const prevRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { const u = 'blob:mock/' + (++created); createdUrls.push(u); return u; };
  URL.revokeObjectURL = () => { revoked++; };
  globalThis.document = {
    createElement(tag) {
      created++;
      return { tagName: tag, className: '', textContent: '', style: {} };
    }
  };
  try {
    const replaced = [];
    const imgOk = { dataset: { asset: id }, alt: '图一', src: '', parentNode: { replaceChild(sp, img) { replaced.push([sp, img]); } } };
    const imgMiss = { dataset: { asset: 'asffffffff-9' }, alt: '缺图', src: '', parentNode: { replaceChild(sp, img) { replaced.push([sp, img]); } } };
    const root = { querySelectorAll: () => [imgOk, imgMiss] };
    await QB.RichText.hydrate(root);
    ok(/^blob:mock\//.test(imgOk.src), '命中资产：img.src 绑 blob URL（' + imgOk.src + '）');
    eq(imgMiss.src, '', '缺失资产：不设置 src');
    eq(replaced.length, 1, '缺失资产：替换 1 个节点');
    ok(replaced[0] && replaced[0][0] && replaced[0][0].className === 'rt-img-missing', '替换为 .rt-img-missing 占位');
    ok(replaced[0][0].textContent.indexOf('缺图') >= 0, '占位保留 alt 文案');

    // 第二轮 hydrate 回收上一轮 blob URL
    const imgOk2 = { dataset: { asset: id }, alt: '二', src: '', parentNode: { replaceChild() {} } };
    await QB.RichText.hydrate({ querySelectorAll: () => [imgOk2] });
    eq(revoked, 1, '新一轮 hydrate 回收上一轮 blob URL');
    ok(/^blob:mock\//.test(imgOk2.src), '第二轮正常绑定');

    // 无图片节点为空操作（且不触发 URL 回收）
    await QB.RichText.hydrate({ querySelectorAll: () => [] });
    eq(revoked, 1, '无节点时回收计数不变');
  } finally {
    globalThis.document = prevDoc;
    URL.createObjectURL = prevCreate;
    URL.revokeObjectURL = prevRevoke;
  }
})();

section('与 escapeHtml 的安全组合（列表用法）');
eq(QB.escapeHtml(toPlain('x^{2}<b>')), 'x2&lt;b&gt;', 'toPlain 后转义可安全入 HTML');

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('FAILED: ' + f)); process.exit(1); }
console.log('富文本渲染器单元测试全部通过 ✅');
