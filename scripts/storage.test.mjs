/**
 * Storage 可靠性单元测试（Node）
 * 覆盖：setSync 同步落盘与失败上抛（不假成功）、onError、失败后重试、
 * forceSync、跨标签 storage 事件缓存同步、remove 同步生效。
 * 备份回滚见 backup.test.mjs；删库级联清理见 srs.test.mjs。
 * 运行：node scripts/storage.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB, window } = await createHarness(path.resolve(__dirname, '..'));
const S = QB.Storage;

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

const ls = window.localStorage;

section('setSync：同步落盘、失败上抛、可重试');
{
  S.clearAll();
  S.setSync('k-sync', { v: 1 });
  eq(JSON.parse(ls.getItem('qb:k-sync')).v, 1, 'setSync 返回后磁盘立即可读（无 200ms 延迟窗口）');

  // 模拟配额错误
  const rawSet = ls.setItem.bind(ls);
  let fired = 0;
  const off = S.onError(() => { fired++; });
  ls.setItem = (k, v) => {
    if (k === 'qb:k-fail') {
      const e = new Error('QuotaExceededError');
      e.name = 'QuotaExceededError';
      throw e;
    }
    return rawSet(k, v);
  };
  let threw = null;
  try { S.setSync('k-fail', { v: 2 }); } catch (e) { threw = e; }
  ok(threw !== null, 'setSync 配额失败时抛错（不再假成功）');
  eq(fired, 1, 'onError 订阅方被通知一次');
  ok(S.lastError && S.lastError.name === 'QuotaExceededError', 'lastError 记录');
  // 失败后待写保留：恢复底层写入，forceSync 重试成功
  ls.setItem = rawSet;
  S.forceSync();
  eq(JSON.parse(ls.getItem('qb:k-fail')).v, 2, '恢复后 forceSync 把待写数据落盘');
  off();
  S.clearAll();
}

section('set 防抖 + forceSync 事务点');
{
  S.clearAll();
  S.set('k-a', 1);
  S.set('k-a', 2);
  eq(S.get('k-a'), 2, '防抖期间读缓存为最新值');
  S.forceSync();
  eq(JSON.parse(ls.getItem('qb:k-a')), 2, 'forceSync 后磁盘为最终值');
  S.clearAll();
}

section('remove 同步生效');
{
  S.setSync('k-rm', 1);
  S.remove('k-rm');
  eq(ls.getItem('qb:k-rm'), null, 'remove 后磁盘立即删除');
  eq(S.get('k-rm', 'def'), 'def', 'remove 后缓存失效，回退默认值');
}

section('跨标签 storage 事件');
{
  S.setSync('k-ext', { v: 1 });
  // 另一标签更新
  ls.setItem('qb:k-ext', JSON.stringify({ v: 9 }));
  S._handleExternalChange({ key: 'qb:k-ext', newValue: JSON.stringify({ v: 9 }) });
  eq(S.get('k-ext').v, 9, '外部更新同步到缓存（多标签无陈旧读取）');
  // 另一标签删除
  ls.removeItem('qb:k-ext');
  S._handleExternalChange({ key: 'qb:k-ext', newValue: null });
  eq(S.get('k-ext', 'gone'), 'gone', '外部删除使缓存失效');
  // 不相关键忽略
  S._handleExternalChange({ key: 'other:x', newValue: '1' });
  ok(true, '非本前缀事件不报错');
  S.clearAll();
}

section('keys 合并磁盘与待写键');
{
  S.clearAll();
  S.setSync('k1', 1);
  S.set('pending-key', 2); // 防抖未落盘
  const ks = S.keys();
  ok(ks.indexOf('k1') >= 0, 'keys 含已落盘键');
  ok(ks.indexOf('pending-key') >= 0, 'keys 含待写键（备份不丢未落盘数据）');
  S.clearAll();
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('Storage 可靠性单元测试全部通过 ✅');
