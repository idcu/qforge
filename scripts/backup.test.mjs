/**
 * 全量备份 / 恢复单元测试（Node）
 * 运行：node scripts/backup.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init();

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }
function clearAll() { QB.Storage.keys().forEach((k) => QB.Storage.remove(k)); }

section('构建备份');
clearAll();
const bank = await QB.DB.banks.create({ name: '备份库' });
await QB.DB.questions.insertMany(bank.id, [
  { type: 'single', question: '备份题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' }
], { dedupe: false });
await QB.SRSStore.grade(bank.id, (await QB.DB.questions.list(bank.id, {})).items[0], QB.SRS.RATINGS.good, Date.now());
const beforeBankCount = (await QB.DB.banks.list()).length;

const backup = await QB.Backup.buildBackup();
eq(backup.app, 'qforge-backup', '备份标识正确');
ok(!!backup.exportedAt && backup.version, '含时间戳与版本');
const dataKeys = Object.keys(backup.data);
ok(dataKeys.indexOf('banks') >= 0, '备份含 banks');
ok(QB.Storage.keys().every((k) => dataKeys.indexOf(k) >= 0), '备份覆盖全部逻辑键');
const bankKey = Object.keys(backup.data).find((k) => k.indexOf('questions:') === 0 || k.indexOf('review:') >= 0);
ok(!!bankKey, '备份含题库/SRS 数据键');

section('WebDAV 密码脱敏（备份可安全分享，评估报告中优先级#6）');
{
  QB.SyncDAV.saveConfig({ baseUrl: 'https://dav.example.com/', user: 'u1', pass: 's3cret', lastAt: 1 });
  const bp = await QB.Backup.buildBackup();
  const dav = bp.data[QB.KEYS.metaDav];
  ok(!!dav && dav.pass === undefined, '备份不含 WebDAV 明文密码');
  eq(dav.baseUrl, 'https://dav.example.com/', '非密字段（地址）保留');
  eq(dav.user, 'u1', '非密字段（账号）保留');
  // 本地配置不受备份脱敏影响
  eq(QB.SyncDAV.getConfig().pass, 's3cret', '脱敏不改本地原配置（纯函数）');
  // redactSecrets 直接契约
  const redacted = QB.Backup.redactSecrets({ a: 1, 'meta:dav': { baseUrl: 'x', pass: 'y' } });
  eq(redacted.a, 1, 'redactSecrets：无关键原样保留');
  eq(redacted['meta:dav'].pass, undefined, 'redactSecrets：密码字段删除');
}

section('覆盖恢复');
clearAll();
eq((await QB.DB.banks.list()).length, 0, '清空后题库为 0');
const r = await QB.Backup.applyBackup(backup);
ok(r.keys >= dataKeys.length, 'applyBackup 写回键数');
eq((await QB.DB.banks.list()).length, beforeBankCount, '恢复后题库数量一致');
const qs = await QB.DB.questions.list(bank.id, {});
eq(qs.items.length, 1, '恢复后题目 1 道');
eq(qs.items[0].question, '备份题', '题目内容一致');
const srs = await QB.SRSStore.getState(bank.id, qs.items[0]);
ok(srs && srs.algo === 'fsrs' && srs.stability > 0, 'SRS（FSRS）复习状态一并恢复');

section('合并恢复');
clearAll();
await QB.DB.banks.create({ name: '现有库' });
QB.Storage.set('test:extra-key', { keep: true }); // 备份之外的独立数据
QB.Storage.forceSync();
await QB.Backup.applyBackup(backup, { mode: 'merge' });
ok(QB.Storage.get('test:extra-key').keep === true, '合并模式保留备份外的现有数据');
eq((await QB.DB.banks.list()).length, beforeBankCount, '同名键（banks）被备份覆盖');

section('覆盖恢复失败回滚（不再先删后写、失败即全丢）');
clearAll();
QB.Storage.setSync('roll:shared', { v: 'old' });
QB.Storage.setSync('roll:onlyOld', { keep: true });
const failingBackup = {
  app: 'qforge-backup',
  version: QB.CONFIG.VERSION,
  exportedAt: new Date().toISOString(),
  data: {
    'roll:shared': { v: 'new' },
    'roll:onlyNew': { fresh: true }
  }
};
const origRemove = QB.Storage.remove.bind(QB.Storage);
QB.Storage.remove = (k) => {
  if (k === 'roll:onlyOld') throw new Error('模拟删除多余旧键失败');
  return origRemove(k);
};
let rollThrew = false;
try { await QB.Backup.applyBackup(failingBackup); } catch (e) { rollThrew = true; }
QB.Storage.remove = origRemove;
ok(rollThrew, '恢复过程失败时错误上抛');
eq(QB.Storage.get('roll:shared') && QB.Storage.get('roll:shared').v, 'old', '已覆盖键回滚到旧值');
ok(QB.Storage.get('roll:onlyOld') && QB.Storage.get('roll:onlyOld').keep === true, '删除失败的旧键数据仍在');
eq(QB.Storage.get('roll:onlyNew', null), null, '新写入键被撤销');
clearAll();

section('异常输入');
let threw = false;
try { await QB.Backup.applyBackup({ app: 'other', data: {} }); } catch (e) { threw = true; }
ok(threw, '非备份文件抛错');
ok(!QB.Backup.isBackup(null) && !QB.Backup.isBackup({ foo: 1 }), 'isBackup 识别非法对象');

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('备份恢复单元测试全部通过 ✅');