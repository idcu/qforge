/**
 * 极简 XML 解析器单元测试（零依赖，Node 执行）
 * 覆盖：结构/顺序、属性引号、实体（含字符引用）、注释/PI/CDATA/DOCTYPE、
 *       命名空间 getAttributeNS、深度先序遍历、畸形 XML 报错。
 * 运行：node scripts/xml-lite.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const { QB } = await createHarness(QB_DIR);

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { failures.push(label); console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, '(期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + ')');
}
function section(t) { console.log('\n== ' + t + ' =='); }
function throws(fn, label) {
  let t = false, msg = '';
  try { fn(); } catch (e) { t = true; msg = e.message; }
  ok(t, label, msg ? '错误：' + msg : '');
}

section('基础结构与遍历顺序');
{
  const doc = QB.XmlLite.parse('<root><a>1</a><b><c>2</c></b><a>3</a></root>');
  const as = doc.getElementsByTagName('a');
  eq(as.length, 2, '同名标签取全部（2 个 a）');
  eq(as[0].textContent, '1', '深度先序：第一个 a');
  eq(as[1].textContent, '3', '深度先序：第二个 a');
  eq(doc.getElementsByTagName('c')[0].textContent, '2', '深层标签可取');
  const b = doc.getElementsByTagName('b')[0];
  eq(b.getElementsByTagName('a').length, 0, '后代查询不跨出当前节点（b 内无 a）');
  eq(b.getElementsByTagName('c').length, 1, '后代查询含子级');
}

section('自闭合/空白/文本拼接');
{
  const doc = QB.XmlLite.parse('<?xml version="1.0"?>\n<r><x v="1"/><y>  保留 空格 </y><p>前<b>中</b>后</p></r>');
  eq(doc.getElementsByTagName('x').length, 1, '自闭合标签可解析');
  eq(doc.getElementsByTagName('x')[0].getElementsByTagName('*').length, 0, '自闭合无子节点');
  eq(doc.getElementsByTagName('y')[0].textContent, '  保留 空格 ', '文本空白原样保留（等价 preserve）');
  eq(doc.getElementsByTagName('p')[0].textContent, '前中后', '跨子元素 textContent 拼接');
}

section('属性（引号/缺省/null）');
{
  const el = QB.XmlLite.parse("<r><x a='单' b=\"双\" c=\"A&gt;B\"/></r>").getElementsByTagName('x')[0];
  eq(el.getAttribute('a'), '单', '单引号属性');
  eq(el.getAttribute('b'), '双', '双引号属性');
  eq(el.getAttribute('c'), 'A>B', '属性值实体解码');
  eq(el.getAttribute('missing'), null, '缺失属性返回 null');
}

section('实体与字符引用');
{
  eq(QB.XmlLite.decodeEntities('a&amp;b&lt;c&gt;d&quot;e&apos;f'), 'a&b<c>d"e\'f', '五个预定义实体');
  eq(QB.XmlLite.decodeEntities('&#65;&#x4e2d;'), 'A中', '十进制/十六进制字符引用');
  const el = QB.XmlLite.parse('<r><v>1 &lt; 2 &amp; 3</v></r>').getElementsByTagName('v')[0];
  eq(el.textContent, '1 < 2 & 3', '元素文本实体解码');
}

section('注释 / 处理指令 / CDATA / DOCTYPE 跳过');
{
  const xml = '<?xml version="1.0"?>\n<!DOCTYPE x [<!ENTITY ignored "x">]>\n' +
    '<!-- 注释 <tag> --><r><?app process?>前<![CDATA[<原样>&保留]]>后</r>';
  const doc = QB.XmlLite.parse(xml);
  eq(doc.getElementsByTagName('r').length, 1, '根元素存在');
  eq(doc.getElementsByTagName('tag').length, 0, '注释中的伪标签不解析');
  eq(doc.getElementsByTagName('r')[0].textContent, '前<原样>&保留后', 'CDATA 原样进入文本');
  eq(doc.getElementsByTagName('x').length, 0, 'DOCTYPE 内声明不产生元素（且未解析实体/不发 DTD 请求）');
}

section('命名空间（getAttributeNS / 原样前缀）');
{
  const xml = '<w:root xmlns:w="http://w" xmlns:r="http://r" xmlns:a="http://a">' +
    '<w:p><a:blip r:embed="rId1"/><a:link r:link="rId2"/></w:p></w:root>';
  const blip = QB.XmlLite.parse(xml).getElementsByTagName('a:blip')[0];
  eq(blip.getAttributeNS('http://r', 'embed'), 'rId1', 'r:embed 按命名空间 URI 解析');
  eq(blip.getAttributeNS('http://r', 'id'), null, '不存在的 NS 属性为 null');
  eq(blip.getAttribute('r:embed'), 'rId1', '限定名直接取也兼容');
}

section('默认命名空间与继承的 xmlns');
{
  const xml = '<rels xmlns="http://rel"><Relationship Id="r1" Type="http://x/image" Target="m/x.png"/></rels>';
  const rel = QB.XmlLite.parse(xml).getElementsByTagName('Relationship')[0];
  eq(rel.getAttribute('Id'), 'r1', '默认 ns 下标签按原样名命中');
  eq(rel.getAttribute('Target'), 'm/x.png', '属性正常');
}

section('畸形 XML 必须抛错（不静默产出错误树）');
{
  throws(() => QB.XmlLite.parse('<r><a></r></a>'), '闭合标签不匹配抛错');
  throws(() => QB.XmlLite.parse('<r><a></b></r>'), '错误嵌套抛错');
  throws(() => QB.XmlLite.parse('<r><a>text'), '未闭合标签抛错');
  throws(() => QB.XmlLite.parse('<!-- no end'), '未闭合注释抛错');
  throws(() => QB.XmlLite.parse('<![CDATA[ no end'), '未闭合 CDATA 抛错');
  throws(() => QB.XmlLite.parse('纯文本无根元素'), '无根元素抛错');
}

section('OOXML 真实片段回归（worksheet / document / rels）');
{
  const sheet = '<?xml version="1.0"?><worksheet xmlns="http://x"><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>题目</t></is></c><c r="B1"><v>42</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>0</v></c></row></sheetData></worksheet>';
  const doc = QB.XmlLite.parse(sheet);
  const rows = doc.getElementsByTagName('row');
  eq(rows.length, 2, 'worksheet：2 行');
  const cells = rows[0].getElementsByTagName('c');
  eq(cells.length, 2, '首行 2 个单元格');
  eq(cells[0].getElementsByTagName('t')[0].textContent, '题目', 'inlineStr 文本');
  eq(cells[1].getElementsByTagName('v')[0].textContent, '42', '数值单元格');

  const docx = '<w:document xmlns:w="http://w"><w:body>' +
    '<w:p><w:r><w:t xml:space="preserve">题干保留  空格</w:t></w:r></w:p></w:body></w:document>';
  const p = QB.XmlLite.parse(docx).getElementsByTagName('w:p')[0];
  eq(p.getElementsByTagName('w:t')[0].textContent, '题干保留  空格', 'docx 段落文本 + xml:space');

  const relsXml = '<Relationships xmlns="http://pkg"><Relationship Id="rId1" Type="http://rel/image" Target="media/1.png"/>' +
    '<Relationship Id="rId2" Type="http://rel/hyperlink" TargetMode="External" Target="https://x"/></Relationships>';
  const rels = QB.XmlLite.parse(relsXml).getElementsByTagName('Relationship');
  eq(rels.length, 2, 'rels：2 条关系');
  eq(rels[0].getAttribute('Id'), 'rId1', 'rels：Id 正确');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('极简 XML 解析器单元测试全部通过 ✅');
