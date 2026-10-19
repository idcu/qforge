/**
 * WebDAV 云备份单元测试（Node，fetch 注入 + 真实 HTTP 集成）
 * 覆盖：配置存取/校验、URL 拼接、Basic 认证、PUT 上传（JSON/ZIP）、
 * 401/404 错误、GET 下载解析；**并起本地 CORS WebDAV 验证端点（`serve-webdav.mjs`）跑真实 HTTP**，
 * 覆盖浏览器真机才有差异的 CORS 预检与真实字节落盘。真机 CORS 行为另经浏览器验收（见 CHANGELOG）。
 * 运行：node scripts/sync-dav.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createWebdavServer } from './serve-webdav.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init(); // 备份载荷经 QB.DB.backup，需初始化数据层（local 适配器）
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-dav-'));

let pass = 0;
const failures = [];
function ok(c, l, extra) { if (c) { pass++; console.log('  ✓ ' + l + (extra ? '  ' + extra : '')); } else { failures.push(l); console.log('  ✗ ' + l + (extra ? '  ' + extra : '')); } }
function eq(a, b, l) { ok(a === b, l, '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
async function throwsAsync(fn, re, l) {
  try {
    await fn();
    ok(false, l, '（应抛错但未抛）');
  } catch (e) {
    ok(re.test(e.message), l, '实际：' + e.message);
  }
}
function section(t) { console.log('\n== ' + t + ' =='); }

QB.Assets.useDriver(QB.Assets.memoryDriver());
QB.Storage.remove(QB.KEYS.metaDav);
const D = QB.SyncDAV;
const CONF = { baseUrl: 'https://dav.example.com/dav/backups/', user: 'u', pass: 'p' };

section('配置存取');
D.saveConfig(CONF);
eq(D.getConfig().baseUrl, CONF.baseUrl, 'saveConfig/getConfig');
eq(D.getConfig().pass, 'p', '密码本机保存');
D.clearConfig();
eq(D.getConfig().baseUrl, '', 'clearConfig');

section('校验与 URL 拼接');
eq(D.targetUrl('https://a.com/dav/'), 'https://a.com/dav/' + D.FILE_NAME, '带尾斜杠');
eq(D.targetUrl('https://a.com/dav'), 'https://a.com/dav/' + D.FILE_NAME, '无尾斜杠自动补');
await throwsAsync(() => D.validateConfig({ baseUrl: '', user: 'u', pass: 'p' }), /地址/, '空地址拒绝');
await throwsAsync(() => D.validateConfig({ baseUrl: 'ftp://a.com/', user: 'u', pass: 'p' }), /http/, 'ftp 拒绝');
await throwsAsync(() => D.validateConfig({ baseUrl: 'https://a.com/', user: '', pass: 'p' }), /账号/, '缺账号拒绝');
await throwsAsync(() => D.validateConfig({ baseUrl: 'https://a.com/', user: 'u', pass: '' }), /密码/, '缺密码拒绝');
await throwsAsync(() => D.validateConfig({ baseUrl: 'not a url', user: 'u', pass: 'p' }), /合法 URL/, '非法 URL 拒绝');

section('Basic 认证头');
{
  const expect = 'Basic ' + Buffer.from('u:p').toString('base64');
  eq(D.authHeader('u', 'p'), expect, 'Authorization: Basic base64(user:pass)');
}

function fakeFetch(recorder, response) {
  return (url, opts) => {
    recorder.url = url;
    recorder.opts = opts;
    return Promise.resolve(response || { status: 201, arrayBuffer: async () => new ArrayBuffer(0) });
  };
}

section('上传：无图 → JSON PUT');
{
  QB.Storage.set('banks', []);
  QB.Storage.set('user:history', []);
  const rec = {};
  const r = await D.upload({ config: CONF, fetch: fakeFetch(rec, { status: 201 }) });
  ok(r.ok && r.status === 201, '201 成功');
  eq(rec.opts.method, 'PUT', 'PUT 方法');
  ok(new RegExp(D.FILE_NAME + '$').test(rec.url), 'URL 以固定对象名结尾（' + rec.url + '）');
  ok(/^Basic /.test(rec.opts.headers.Authorization), '带 Basic 认证');
  eq(rec.opts.headers['Content-Type'], 'application/json;charset=utf-8', 'JSON content-type');
  const parsed = JSON.parse(rec.opts.body);
  ok(parsed.app === 'qforge-backup', 'body 是备份 JSON');
  eq(r.assetCount, 0, '无图 assetCount=0');
  ok(!!D.getConfig().lastAt, '上传时间已记录');
}

section('上传：错误状态');
await throwsAsync(() => D.upload({ config: CONF, fetch: fakeFetch({}, { status: 401 }) }), /认证失败/, '401 → 认证错误');
await throwsAsync(() => D.upload({ config: CONF, fetch: fakeFetch({}, { status: 500 }) }), /500/, '500 → 上传失败');

section('上传：有图 → ZIP（.qfbk 结构）');
{
  await QB.Assets.put(new TextEncoder().encode('png-bytes'), 'image/png');
  const rec = {};
  const r = await D.upload({ config: CONF, fetch: fakeFetch(rec, { status: 204 }) });
  eq(r.status, 204, '204 成功');
  eq(rec.opts.headers['Content-Type'], 'application/zip', 'zip content-type');
  ok(rec.opts.body instanceof ArrayBuffer, 'body 为 ArrayBuffer');
  const head = new Uint8Array(rec.opts.body, 0, 2);
  ok(head[0] === 0x50 && head[1] === 0x4b, 'ZIP PK 头');
  ok(r.assetCount >= 1, 'assetCount≥1（实际 ' + r.assetCount + '）');
  await QB.Assets.clear();
}

section('下载并解析');
{
  QB.Storage.set('banks', []);
  const backup = await QB.Backup.buildBackup();
  const jsonBuf = new TextEncoder().encode(JSON.stringify(backup)).buffer;
  const rec = {};
  const parsed = await D.fetchBackup({
    config: CONF,
    fetch: fakeFetch(rec, { status: 200, arrayBuffer: async () => jsonBuf })
  });
  eq(rec.opts.method, 'GET', 'GET 方法');
  ok(!!parsed.backup.data, '解析出备份对象');
  eq(parsed.assets.length, 0, 'JSON 备份无资产');
  ok(/dav\.example\.com/.test(parsed.source), 'source 标注来源 URL');

  await throwsAsync(() => D.fetchBackup({ config: CONF, fetch: fakeFetch({}, { status: 404 }) }), /没有备份/, '404 提示先上传');
  await throwsAsync(() => D.fetchBackup({ config: CONF, fetch: fakeFetch({}, { status: 403 }) }), /认证失败/, '403 认证错误');
}

section('真实 HTTP 集成：本地 CORS WebDAV 验证端点（预检 / PUT / GET / Basic）');
{
  const srv = await createWebdavServer({ port: 0, dataDir: tmpDir() });
  const baseUrl = 'http://127.0.0.1:' + srv.port + '/dav/';
  const conf = { baseUrl: baseUrl, user: 'u', pass: 'p' };

  // CORS 预检：PUT 携带 Authorization 属「非简单请求」，浏览器必先 OPTIONS（Node 单测不会触发）
  const pre = await fetch(baseUrl + D.FILE_NAME, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:9999' } });
  eq(pre.status, 204, '预检 OPTIONS → 204');
  ok(/Authorization/.test(pre.headers.get('access-control-allow-headers') || ''), '预检放行 Authorization 头');
  eq(pre.headers.get('access-control-allow-origin'), 'http://127.0.0.1:9999', '预检回显 Origin（跨域放行）');

  // 无图 → JSON PUT（走真实 fetch，不用注入桩）
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  await QB.Assets.clear();
  QB.Storage.set('banks', []);
  const r1 = await D.upload({ config: conf, fetch: globalThis.fetch });
  eq(r1.status, 201, '真实 PUT → 201');
  ok(fs.existsSync(srv.file) && fs.statSync(srv.file).size > 0, '端点已落盘备份文件（' + fs.statSync(srv.file).size + ' B）');
  eq(JSON.parse(fs.readFileSync(srv.file, 'utf8')).app, 'qforge-backup', '落盘内容是可解析的备份 JSON');

  // 认证失败（错误密码）
  await throwsAsync(() => D.upload({ config: { baseUrl: baseUrl, user: 'u', pass: 'bad' }, fetch: globalThis.fetch }), /认证失败/, '错误密码 → 401 认证失败');

  // 有图 → ZIP（.qfbk）PUT
  await QB.Assets.put(new TextEncoder().encode('png-bytes'), 'image/png');
  const r2 = await D.upload({ config: conf, fetch: globalThis.fetch });
  eq(r2.status, 201, '有图 PUT（.qfbk ZIP）→ 201');
  const bytes = fs.readFileSync(srv.file);
  ok(bytes[0] === 0x50 && bytes[1] === 0x4b, '端点收到 ZIP（PK 头）');

  // GET 下载并解析
  const parsed = await D.fetchBackup({ config: conf, fetch: globalThis.fetch });
  eq(parsed.backup.app, 'qforge-backup', '真实 GET 下载并解析为备份对象');
  eq(parsed.assets.length, 1, '下载包内资产 1 个');

  // 端点无对象 → 404 提示先上传
  const srv2 = await createWebdavServer({ port: 0, dataDir: tmpDir() });
  await throwsAsync(
    () => D.fetchBackup({ config: { baseUrl: 'http://127.0.0.1:' + srv2.port + '/dav/', user: 'u', pass: 'p' }, fetch: globalThis.fetch }),
    /没有备份/, '端点无对象 → 404 提示先上传');
  await Promise.all([srv.close(), srv2.close()]);
  await QB.Assets.clear();
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('FAILED: ' + f)); process.exit(1); }
console.log('WebDAV 云备份单元测试全部通过 ✅');
