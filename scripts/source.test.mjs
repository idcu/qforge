/**
 * 题库来源与网络导入单元测试（Node）
 * 覆盖：URL 校验、checksum、来源归一化、fetchSnapshot（注入 loader，含上限/超时）、
 * runImport 内存快照形态、快照→解析全链路。
 * 运行：node scripts/source.test.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const { QB } = await createHarness(QB_DIR);

let pass = 0;
const failures = [];
function ok(c, l, extra) { if (c) { pass++; console.log('  ✓ ' + l + (extra ? '  ' + extra : '')); } else { failures.push(l); console.log('  ✗ ' + l + (extra ? '  ' + extra : '')); } }
function eq(a, b, l) { ok(a === b, l, '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

const S = QB.Source;

section('URL 校验');
ok(!S.validateUrl('not a url').ok, '非法地址拒绝');
ok(!S.validateUrl('ftp://example.com/a.json').ok, '非 http(s) 协议拒绝');
ok(!S.validateUrl('javascript:alert(1)').ok, 'javascript: 拒绝');
ok(!S.validateUrl('https://example.com/noext').ok, '无扩展名拒绝');
ok(!S.validateUrl('https://example.com/a.exe').ok, '不支持扩展名拒绝');
const vj = S.validateUrl('https://example.com/dir/a.JSON?x=1');
ok(vj.ok && vj.ext === 'json', '合法 JSON（大写扩展名、带查询串）');
const vx = S.validateUrl('https://example.com/a.xlsx');
ok(vx.ok && vx.ext === 'xlsx', '合法 xlsx');

section('checksum 确定性');
eq(S.checksumText('hello'), S.checksumText('hello'), '同文本 checksum 相同');
ok(S.checksumText('hello') !== S.checksumText('hellp'), '不同文本 checksum 不同');
eq(/^[0-9a-f]{8}$/.test(S.checksumText('abc')), true, 'checksum 为 8 位十六进制');
const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
eq(S.checksumBytes(bytes), S.checksumBytes(new Uint8Array([1, 2, 3, 4, 5]).buffer), '字节 checksum 确定');

section('来源归一化（旧数据兼容）');
const def = S.normalize(null);
eq(def.kind, 'local', '无来源默认 local');
eq(def.refreshable, false, 'local 不可刷新');
const urlSrc = S.normalize({ kind: 'url', uri: 'https://x/a.json', fetchedAt: 1, checksum: 'ab', refreshable: true });
ok(urlSrc.refreshable && urlSrc.uri === 'https://x/a.json', 'url 来源保留可刷新');
const fakeRefresh = S.normalize({ kind: 'file', uri: 'a.csv', refreshable: true });
eq(fakeRefresh.refreshable, false, '非 url 强制 refreshable=false');

section('fetchSnapshot（注入 loader）');
{
  const text = JSON.stringify([{ type: 'judge', question: '网络题', answer: '正确' }]);
  const loader = async (url) => ({
    ok: true, status: 200,
    headers: { get: (k) => (k === 'content-length' ? String(new Blob([text]).size) : null) },
    text: async () => text, arrayBuffer: async () => new ArrayBuffer(0)
  });
  const snap = await S.fetchSnapshot('https://example.com/q.json', { loader: loader });
  eq(snap.name, 'q.json', '快照文件名取路径末段');
  eq(snap.ext, 'json', '扩展名 json');
  eq(snap.text, text, '文本快照内容');
  ok(/^[0-9a-f]{8}$/.test(snap.checksum), '文本快照带 checksum');
}

section('大小上限 8MB');
{
  const loader = async () => ({
    ok: true, status: 200, headers: { get: (k) => (k === 'content-length' ? String(S.URL_LIMIT_BYTES + 1) : null) }
  });
  let threw = false;
  try { await S.fetchSnapshot('https://example.com/big.json', { loader: loader }); } catch (e) { threw = /8MB/.test(e.message); }
  ok(threw, 'Content-Length 超限拒绝');

  // 无 Content-Length 但实际超长（约 16MB 文本）
  const big = 'x'.repeat(S.URL_LIMIT_BYTES * 2);
  const loader2 = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => big
  });
  let threw2 = false;
  try { await S.fetchSnapshot('https://example.com/big2.json', { loader: loader2 }); } catch (e) { threw2 = /8MB/.test(e.message); }
  ok(threw2, '实际内容超限拒绝');
}

section('HTTP 错误与超时');
{
  const errLoader = async () => ({ ok: false, status: 404 });
  let threw = false;
  try { await S.fetchSnapshot('https://example.com/missing.json', { loader: errLoader }); } catch (e) { threw = /404/.test(e.message); }
  ok(threw, 'HTTP 404 抛错');

  // loader 返回 null（无响应）：不得出现 "HTTP undefined"
  const nullLoader = async () => null;
  let nullMsg = '';
  try { await S.fetchSnapshot('https://example.com/none.json', { loader: nullLoader }); } catch (e) { nullMsg = e.message; }
  ok(/无响应/.test(nullMsg) && !/undefined/.test(nullMsg), '无响应时文案为「HTTP 无响应」（回归：运算符优先级导致 undefined）');

  // 超时：loader 收到 abort signal 后按 AbortError 拒绝
  const slowLoader = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  });
  let timedOut = false;
  try { await S.fetchSnapshot('https://example.com/slow.json', { loader: slowLoader, timeout: 30 }); }
  catch (e) { timedOut = /超时/.test(e.message); }
  ok(timedOut, '超时按「请求超时」提示');
}

section('快照 → runImport 全链路');
{
  const text = JSON.stringify({
    questions: [
      { type: 'single', question: '快照单选', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' }
    ]
  });
  const res = await QB.Importers.runImport({ name: 'remote.json', text: text });
  eq(res.questions.length, 1, '内存文本快照解析 1 题');
  eq(res.questions[0].answer, 'A', '快照题答案正确');
  eq(res.ext, 'json', '结果带扩展名');
}

section('二进制快照分派（xlsx）');
{
  // 仅验证分派与 checksum：真实 xlsx 解析在 smoke 的 DOMParser 分支覆盖
  const buf = new Uint8Array([80, 75, 3, 4, 9, 9, 9]).buffer; // PK 开头假 zip
  const loader = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    arrayBuffer: async () => buf, text: async () => ''
  });
  const snap = await S.fetchSnapshot('https://example.com/a.xlsx', { loader: loader });
  ok(snap.arrayBuffer instanceof ArrayBuffer && snap.arrayBuffer.byteLength === 7, 'xlsx 快照为 ArrayBuffer');
  ok(/^[0-9a-f]{8}$/.test(snap.checksum), 'xlsx 快照字节 checksum');
  let threw = false;
  try { await QB.Importers.runImport({ name: 'a.xlsx', arrayBuffer: buf }); } catch (e) { threw = true; }
  ok(threw, '假 zip 解析失败被正确抛出（真实 zip 在 DOMParser 分支验证）');
}

section('考试倒计时/刷新恢复关键接线（源码级回归）');
{
  const appSrc = fs.readFileSync(path.join(QB_DIR, 'js/app.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(QB_DIR, 'js/modules/ui-renderer.js'), 'utf8');
  ok(appSrc.indexOf('timerText: State.timerText') >= 0, 'app.render 向答题区传入 timerText（真实浏览器曾因此不显示倒计时）');
  ok(appSrc.indexOf("document.getElementById('quiz-timer')") >= 0, 'updateStatus 每秒更新 #quiz-timer');
  ok(uiSrc.indexOf('id="quiz-timer"') >= 0, '答题头渲染 #quiz-timer 容器');
  ok(appSrc.indexOf("addEventListener('pagehide'") >= 0 && appSrc.indexOf('ProgressSaver.flush') >= 0, 'pagehide 冲刷会话（防抖窗口内刷新不丢）');
  ok(appSrc.indexOf('engine.remainingMs') >= 0, '倒计时统一走 QuizEngine.remainingMs（旧会话回退）');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('来源与网络导入单元测试全部通过 ✅');
