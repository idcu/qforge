/**
 * .apkg 只读探针（阶段 0，不注册进 test-all）
 *
 * 用法：node scripts/probe-apkg.mjs <file.apkg> [--json]
 * 输出：包版本、ZIP 条目、collection 页大小/编码/freelist、col.ver、notes/cards/revlog 行数、media 数量。
 * 只读：不写 QB.Assets、不写题库、不产生临时文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let readersPromise = null;

function loadReaders() {
  if (!readersPromise) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const at = (p) => pathToFileURL(path.join(root, p)).href;
    readersPromise = (async () => {
      await import(at('ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/zip/src/vendor/zip.js'));
      await import(at('js/utils/zip-reader.js'));
      await import(at('js/utils/sqlite-reader.js'));
      await import(at('js/importers/anki-package.js'));
      return globalThis.QB;
    })();
  }
  return readersPromise;
}

function bufferOf(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * @param {string} filePath
 * @returns {Promise<Object>} 探针报告（不抛异常：错误以 ok=false 返回）
 */
export async function probeApkg(filePath) {
  const bytes = fs.readFileSync(filePath);
  const report = {
    ok: false,
    file: path.resolve(filePath),
    size: bytes.length,
    sha256: null,
    zip: { entries: [] },
    version: null,
    versionLabel: '未知',
    supported: false,
    collection: null,
    sqlite: null,
    counts: null,
    media: null,
    error: null
  };
  // 哈希只用于报告可追溯性；不引入 crypto 之外的写入
  const crypto = await import('node:crypto');
  report.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  const QB = await loadReaders();
  let entries;
  try {
    entries = await QB.ZipReader.readEntries(bufferOf(bytes));
  } catch (e) {
    report.error = 'ZIP 读取失败：' + e.message;
    return report;
  }
  report.zip.entries = Object.keys(entries).map((name) => ({ name: name, bytes: entries[name].length }));

  const cls = QB.AnkiPackage.classify(entries);
  report.version = cls.version;
  report.versionLabel = cls.label;
  report.supported = cls.supported;
  report.collection = cls.collectionName;
  report.reason = cls.reason;
  if (!cls.supported) {
    report.ok = true; // 识别成功，只是格式不可用
    return report;
  }

  let db;
  try {
    db = QB.SqliteReader.open(entries[cls.collectionName]);
  } catch (e) {
    report.error = e.message;
    return report;
  }
  report.sqlite = {
    pageSize: db.pageSize,
    usableSize: db.usableSize,
    pageCount: db.pageCount,
    encoding: db.encodingName,
    freelistTrunk: db.freelist.trunk,
    freelistCount: db.freelist.count,
    tables: Object.keys(db.tables)
  };

  const col = (db.readTable('col') || []).find((r) => r.id === 1) || {};
  let models = null;
  try { models = col.models ? JSON.parse(col.models) : null; } catch (e) { models = null; }
  const counts = {
    colVer: col.ver == null ? null : col.ver,
    noteTypes: models ? Object.keys(models).length : null,
    notes: db.hasTable('notes') ? db.readTable('notes').length : 0,
    cards: db.hasTable('cards') ? db.readTable('cards').length : 0,
    revlog: db.hasTable('revlog') ? db.readTable('revlog').length : 0,
    graves: db.hasTable('graves') ? db.readTable('graves').length : 0
  };
  const media = QB.AnkiPackage.readMediaMap(entries);
  counts.media = Object.keys(media.map).length;
  counts.mediaMissing = Object.keys(media.map).filter((name) => !entries[media.map[name]]).length;
  report.counts = counts;
  report.media = { present: media.present, count: counts.media, missing: counts.mediaMissing, warnings: media.warnings };
  report.ok = true;
  return report;
}

function printReport(r) {
  const lines = [];
  lines.push('文件: ' + r.file);
  lines.push('大小: ' + r.size + ' bytes');
  lines.push('SHA-256: ' + r.sha256);
  if (!r.zip.entries.length) {
    lines.push('ZIP: 无法读取');
  } else {
    lines.push('ZIP 条目:');
    r.zip.entries.forEach((e) => lines.push('  - ' + e.name + '  (' + e.bytes + ' bytes)'));
  }
  lines.push('版本: ' + (r.version == null ? '未知' : r.version) + ' / ' + r.versionLabel +
    '  支持: ' + (r.supported ? '是' : '否'));
  if (r.reason) lines.push('说明: ' + r.reason);
  if (r.error) lines.push('错误: ' + r.error);
  if (r.sqlite) {
    lines.push('SQLite: pageSize=' + r.sqlite.pageSize + ' usable=' + r.sqlite.usableSize +
      ' pages=' + r.sqlite.pageCount + ' encoding=' + r.sqlite.encoding +
      ' freelist=' + r.sqlite.freelistCount);
    lines.push('表: ' + r.sqlite.tables.join(', '));
  }
  if (r.counts) {
    lines.push('行数: col.ver=' + r.counts.colVer + ' noteTypes=' + r.counts.noteTypes +
      ' notes=' + r.counts.notes + ' cards=' + r.counts.cards +
      ' revlog=' + r.counts.revlog + ' graves=' + r.counts.graves +
      ' media=' + r.counts.media + ' mediaMissing=' + r.counts.mediaMissing);
  }
  if (r.media && r.media.warnings.length) {
    r.media.warnings.forEach((w) => lines.push('媒体警告: ' + w));
  }
  return lines.join('\n');
}

const invokedDirectly = (() => {
  try { return pathToFileURL(process.argv[1] || '').href === import.meta.url; }
  catch (e) { return false; }
})();

if (invokedDirectly) {
  const file = process.argv[2];
  const asJson = process.argv.indexOf('--json') >= 0;
  if (!file) {
    console.error('用法: node scripts/probe-apkg.mjs <file.apkg> [--json]');
    process.exit(2);
  }
  probeApkg(file).then((r) => {
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else console.log(printReport(r));
    process.exit(r.error && !r.ok ? 1 : 0);
  }).catch((e) => {
    console.error('探针失败: ' + (e && e.message ? e.message : e));
    process.exit(1);
  });
}
