/**
 * 共享断言助手（测试专用）
 *
 * 34 个套件此前各自复制 `ok / eq / section`：同一段判定逻辑散落 34 份，改一处（例如
 * 让 `eq` 支持深比较）就要改 34 次，且容易出现「某个套件悄悄把失败也计入通过」这类分叉。
 * 本模块只收敛这三个原语；各套件特有的 `throwsAsync`、`near`、`eq2` 等仍留在本地。
 *
 * 兼容性设计（刻意保持调用方零改动）：
 *  - 套件仍保留自己的 `let pass = 0; const failures = [];`，通过 `onPass` 回写通过数，
 *    因此末尾 `通过: pass，失败: failures.length` 的汇总语义不变；
 *  - `ok(cond, label, extra)` 同时兼容原来的两参数与三参数调用；`extra` 只是日志附注，
 *    不参与判定；
 *  - `eq` 默认严格相等；`deep: true` 时按 JSON 序列化比较（idb/import-commit 的历史语义）。
 *
 * 注意：本模块不做任何「失败也通过」的兼容。`ok(false)` 一定计入 failures。
 *
 * @param {{failures?: string[], onPass?: () => void, deep?: boolean,
 *   log?: (line: string) => void}} [opts]
 */
export function createAssert(opts) {
  const o = opts || {};
  const failures = Array.isArray(o.failures) ? o.failures : [];
  const onPass = typeof o.onPass === 'function' ? o.onPass : () => {};
  const log = typeof o.log === 'function' ? o.log : (line) => console.log(line);
  const deep = !!o.deep;

  function ok(cond, label, extra) {
    const suffix = extra ? '  ' + extra : '';
    if (cond) {
      onPass();
      log('  ✓ ' + label + suffix);
      return true;
    }
    failures.push(label);
    log('  ✗ ' + label + suffix);
    return false;
  }

  function eq(actual, expected, label) {
    const same = deep
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : actual === expected;
    return ok(same, label,
      '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
  }

  function deepEq(actual, expected, label) {
    return ok(JSON.stringify(actual) === JSON.stringify(expected), label,
      '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
  }

  function section(title) {
    log('\n== ' + title + ' ==');
  }

  function throws(fn, label) {
    let threw = false;
    try { fn(); } catch (_) { threw = true; }
    return ok(threw, label);
  }

  return { ok, eq, deepEq, section, throws, failures };
}
