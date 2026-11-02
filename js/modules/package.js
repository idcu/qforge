/**
 * 题包清单（manifest.json）公共抽象
 *
 * 分发的 .qbk 在既有 stored ZIP 结构（bank.json + assets/*）里追加一个 manifest.json：
 *   { format, manifestVersion, packageId, version, title, description, author,
 *     questionCount, createdAt, checksum, app:{name,version} }
 * 旧包没有 manifest.json —— 解析结果为 null，**不产生警告、导入行为完全不变**。
 *
 * 职责边界（唯一实现，禁止在导入器/导出器复制）：
 *   - makeManifest：生成清单（packageId 默认由题库 id 散列，同库多次导出稳定）
 *   - parseManifest：文本 → 对象，坏格式给出可读错误（不抛）
 *   - verify：清单与 bank.json 自洽性（题数/checksum/格式/版本），**只产警告不阻断**
 *   - compareVersions：点分版本比较（供「同题包新版本」提示）
 *   - 导入历史（meta:pkgHistory）：findDuplicate / latestForPackage / recordImport
 *     用于 G4「同一 id+版本再次导入」的显式交互，不静默产生重复题目。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const FORMAT = 'qforge-package';
  const MANIFEST_VERSION = 1;
  const MANIFEST_NAME = 'manifest.json';
  const HISTORY_MAX_PER_BANK = 20;

  /** 题包 id：同一题库多次导出保持稳定（默认由题库 id 散列，可用 opts.packageId 覆盖） */
  function packageIdFor(input) {
    return 'pkg-' + QB.FNV.hashString64(String(input == null ? '' : input));
  }

  function makeManifest(opts) {
    opts = opts || {};
    const bank = opts.bank || {};
    return {
      format: FORMAT,
      manifestVersion: MANIFEST_VERSION,
      packageId: opts.packageId || packageIdFor(bank.id || bank.name || opts.title || ''),
      version: String(opts.version || '1.0.0'),
      title: String(opts.title || bank.name || ''),
      description: String(opts.description != null ? opts.description : (bank.description || '')),
      author: String(opts.author || ''),
      questionCount: Number(opts.questionCount) || 0,
      createdAt: opts.createdAt || new Date().toISOString(),
      checksum: String(opts.checksum || ''),
      app: { name: QB.CONFIG.APP_NAME, version: QB.CONFIG.VERSION }
    };
  }

  /** @returns {{manifest:Object|null, error:string}} 坏格式不抛错，由调用方转为警告 */
  function parseManifest(text) {
    if (text == null || (typeof text === 'string' && !text.trim())) return { manifest: null, error: '' };
    if (typeof text === 'object') return { manifest: text, error: '' };
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { manifest: null, error: 'manifest.json 结构非法（应为 JSON 对象）' };
      }
      return { manifest: parsed, error: '' };
    } catch (e) {
      return { manifest: null, error: 'manifest.json 不是合法 JSON（' + e.message + '）' };
    }
  }

  /** 点分版本比较：a>b → 1，a<b → -1，相等 → 0（纯数字段按数值，其余按字符串） */
  function compareVersions(a, b) {
    const pa = String(a == null ? '' : a).split('.');
    const pb = String(b == null ? '' : b).split('.');
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] == null ? '0' : pa[i];
      const y = pb[i] == null ? '0' : pb[i];
      if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
        const d = Number(x) - Number(y);
        if (d) return d > 0 ? 1 : -1;
      } else {
        const d = x.localeCompare(y);
        if (d) return d > 0 ? 1 : -1;
      }
    }
    return 0;
  }

  /**
   * 清单与 bank.json 自洽性校验（只产警告，不阻断导入）
   * @param {Object|null} manifest 已解析清单（无 manifest 的旧包传 null）
   * @param {string} manifestError 解析错误（若有）
   * @param {{checksum?:string, questions?:Array}} envelope bank.json 的校验和 / 题集
   * @param {Array} questions 实际解析出的题目（缺省取 envelope.questions）
   * @returns {{ok:boolean, manifest:Object|null, checksumOk:?boolean, countOk:?boolean, warnings:string[]}}
   */
  function verify(manifest, manifestError, envelope, questions) {
    const env = envelope || {};
    const qs = questions || env.questions || [];
    const warnings = [];
    const out = { ok: true, manifest: manifest || null, checksumOk: null, countOk: null, warnings: warnings };
    if (!manifest) {
      // 旧题包：无 manifest，行为保持与改动前一致（不提示、不校验）
      if (manifestError) {
        warnings.push(manifestError + '；已跳过题包版本/完整性校验');
        out.ok = false;
      }
      return out;
    }
    if (manifest.format !== FORMAT) {
      warnings.push('题包清单 format 应为 ' + FORMAT + '（实际 ' + String(manifest.format) + '）');
      out.ok = false;
    }
    const mv = Number(manifest.manifestVersion);
    if (!Number.isFinite(mv) || mv < 1) {
      warnings.push('题包清单 manifestVersion 非法（' + String(manifest.manifestVersion) + '）');
      out.ok = false;
    } else if (mv > MANIFEST_VERSION) {
      warnings.push('题包清单版本 ' + mv + ' 高于当前支持（' + MANIFEST_VERSION + '），仅按已知字段读取');
    }
    if (typeof manifest.questionCount === 'number' && Number.isFinite(manifest.questionCount)) {
      out.countOk = manifest.questionCount === qs.length;
      if (!out.countOk) {
        warnings.push('题包清单题数 ' + manifest.questionCount + ' 与实际解析 ' + qs.length + ' 不一致');
        out.ok = false;
      }
    }
    if (!manifest.packageId || !manifest.version) {
      warnings.push('题包清单缺少 packageId/version，无法识别重复导入');
      out.ok = false;
    }
    if (manifest.checksum) {
      if (!env.checksum) {
        warnings.push('题包清单含校验和，但 bank.json 未携带 checksum，无法核对');
        out.ok = false;
      } else {
        out.checksumOk = manifest.checksum === env.checksum;
        if (!out.checksumOk) {
          warnings.push('题包清单校验和与 bank.json 不一致（manifest ' + manifest.checksum + '，bank.json ' + env.checksum + '）');
          out.ok = false;
        }
      }
    }
    return out;
  }

  /* ---------------- 导入历史（G4 重复题包识别） ---------------- */

  function readHistory() {
    if (!QB.Storage || typeof QB.Storage.get !== 'function') return {};
    const v = QB.Storage.get(QB.KEYS.metaPkgHistory);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  function history(bankId) {
    const all = readHistory();
    const list = all[bankId];
    return Array.isArray(list) ? list : [];
  }

  /** 同 packageId 最近一次导入记录（用于「新版本」提示） */
  function latestForPackage(bankId, packageId) {
    if (!packageId) return null;
    const list = history(bankId).filter((r) => r && r.packageId === packageId);
    return list.sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
  }

  /** 同一 packageId + version 是否已导入过（命中 → 调用方必须给出覆盖/并存/跳过） */
  function findDuplicate(bankId, manifest) {
    if (!manifest || !manifest.packageId) return null;
    return history(bankId).filter((r) => r && r.packageId === manifest.packageId && r.version === manifest.version)[0] || null;
  }

  /** 记录一次成功导入（同 id+版本只记一次，按库保留最近 20 条；写失败不影响导入） */
  function recordImport(bankId, manifest) {
    if (!bankId || !manifest || !manifest.packageId) return false;
    try {
      const all = readHistory();
      const list = Array.isArray(all[bankId]) ? all[bankId].slice() : [];
      const hit = list.find((r) => r && r.packageId === manifest.packageId && r.version === manifest.version);
      if (hit) {
        hit.at = Date.now();
      } else {
        list.push({
          packageId: manifest.packageId,
          version: String(manifest.version || ''),
          title: String(manifest.title || ''),
          at: Date.now()
        });
      }
      while (list.length > HISTORY_MAX_PER_BANK) list.shift();
      all[bankId] = list;
      QB.Storage.setSync(QB.KEYS.metaPkgHistory, all);
      return true;
    } catch (e) {
      return false;
    }
  }

  QB.Package = {
    FORMAT, MANIFEST_VERSION, MANIFEST_NAME, HISTORY_MAX_PER_BANK,
    packageIdFor, makeManifest, parseManifest, verify, compareVersions,
    history, latestForPackage, findDuplicate, recordImport
  };
})(window);
