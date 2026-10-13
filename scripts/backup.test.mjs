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
QB.SRSStore.grade(bank.id, (await QB.DB.questions.list(bank.id, {})).items[0], QB.SRS.RATINGS.good, Date.now());
const beforeBankCount = (await QB.DB.banks.list()).length;

const backup = QB.Backup.buildBackup();
eq(backup.app, 'qforge-backup', '备份标识正确');
ok(!!backup.exportedAt && backup.version, '含时间戳与版本');
const dataKeys = Object.keys(backup.data);
ok(dataKeys.indexOf('banks') >= 0, '备份含 banks');
ok(QB.Storage.keys().every((k) => dataKeys.indexOf(k) >= 0), '备份覆盖全部逻辑键');
const bankKey = Object.keys(backup.data).find((k) => k.indexOf('questions:') === 0 || k.indexOf('review:') >= 0);
ok(!!bankKey, '备份含题库/SRS 数据键');

section('覆盖恢复');
clearAll();
eq((await QB.DB.banks.list()).length, 0, '清空后题库为 0');
const r = QB.Backup.applyBackup(backup);
ok(r.keys >= dataKeys.length, 'applyBackup 写回键数');
eq((await QB.DB.banks.list()).length, beforeBankCount, '恢复后题库数量一致');
const qs = await QB.DB.questions.list(bank.id, {});
eq(qs.items.length, 1, '恢复后题目 1 道');
eq(qs.items[0].question, '备份题', '题目内容一致');
const srs = QB.SRSStore.getState(bank.id, qs.items[0]);
ok(srs && srs.interval === 1, 'SRS 复习状态一并恢复');

section('合并恢复');
clearAll();
await QB.DB.banks.create({ name: '现有库' });
QB.Storage.set('test:extra-key', { keep: true }); // 备份之外的独立数据
QB.Storage.forceSync();
QB.Backup.applyBackup(backup, { mode: 'merge' });
ok(QB.Storage.get('test:extra-key').keep === true, '合并模式保留备份外的现有数据');
eq((await QB.DB.banks.list()).length, beforeBankCount, '同名键（banks）被备份覆盖');

section('异常输入');
let threw = false;
try { QB.Backup.applyBackup({ app: 'other', data: {} }); } catch (e) { threw = true; }
ok(threw, '非备份文件抛错');
ok(!QB.Backup.isBackup(null) && !QB.Backup.isBackup({ foo: 1 }), 'isBackup 识别非法对象');

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('备份恢复单元测试全部通过 ✅');