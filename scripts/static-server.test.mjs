/**
 * 静态文件服务路径守卫测试（Node）
 * 重点：URL → root 下绝对路径的越界拒绝（含 ..、%2e%2e、..\、畸形编码、NUL），
 * 正常路径/根路径/目录补 index.html 保持可用。
 * 运行：node scripts/static-server.test.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveSafePath } from './lib/static-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function section(t) { console.log('\n== ' + t + ' =='); }

section('正常路径');
{
  const idx = resolveSafePath(ROOT, '/index.html');
  ok(idx === path.join(ROOT, 'index.html'), '根路径 index.html 解析正确');
  ok(resolveSafePath(ROOT, '/') === path.join(ROOT, 'index.html'), '/ 补 index.html');
  const js = resolveSafePath(ROOT, '/js/app.js?x=1');
  ok(js === path.join(ROOT, 'js', 'app.js'), '忽略查询串并保留子路径');
  const dir = resolveSafePath(ROOT, '/js');
  ok(dir === path.join(ROOT, 'js', 'index.html'), '目录补 index.html（无该文件也不越界）');
  ok(resolveSafePath(ROOT, '/%6a%73/app.js') === path.join(ROOT, 'js', 'app.js'), '百分号编码正常解码');
}

section('越界与非法路径必须拒绝（返回 null）');
{
  ok(resolveSafePath(ROOT, '/../qforgeX/a.html') === null, '../ 兄弟目录拒绝（旧实现误判为合法）');
  ok(resolveSafePath(ROOT, '/%2e%2e/qforgeX/a.html') === null, '%2e%2e 编码绕过拒绝');
  ok(resolveSafePath(ROOT, '/..%5cqforgeX/a.html') === null, '..\\ 反斜杠绕过拒绝');
  ok(resolveSafePath(ROOT, '/js/../../etc/passwd') === null, '深层 ../ 拒绝');
  ok(resolveSafePath(ROOT, '/%E0%A4%A') === null, '畸形 percent-encoding 拒绝（不抛错）');
  ok(resolveSafePath(ROOT, '/a%00b') === null, 'NUL 字节拒绝');
  ok(resolveSafePath(ROOT, '') === path.join(ROOT, 'index.html'), '空路径按根处理（安全）');
}

section('含 .. 的路径一律拒绝（与目标是否存在无关）');
{
  // 归一后 E:\qforge\..\..\qforge\index.html 回到 root 内，但含 .. 段仍必须拒绝
  const tricky = '/../../' + path.basename(ROOT) + '/index.html';
  ok(fs.existsSync(path.join(ROOT, 'index.html')), '前提：index.html 真实存在');
  ok(resolveSafePath(ROOT, tricky) === null, '含 .. 的路径即使归一后落在 root 内也拒绝（' + tricky + '）');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('静态服务路径守卫测试全部通过 ✅');
