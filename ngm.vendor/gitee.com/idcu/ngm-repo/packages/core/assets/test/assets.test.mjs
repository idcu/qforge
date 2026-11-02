import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createAssets, memoryDriver, idbDriver, idFor, toBytes } from '../src/index.mjs';

const require = createRequire(import.meta.url);

/** 极简 IndexedDB 桩：只实现 idbDriver 用到的 API */
function fakeIndexedDB() {
  const dbs = new Map();
  function request() {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    queueMicrotask(() => { if (typeof req.onsuccess === 'function') req.onsuccess({ target: req }); });
    return req;
  }
  function makeStore(map) {
    return {
      put(value, key) {
        const r = request();
        map.set(key, value);
        r.result = key;
        return r;
      },
      get(key) {
        const r = request();
        r.result = map.has(key) ? map.get(key) : undefined;
        return r;
      },
      delete(key) {
        const r = request();
        map.delete(key);
        return r;
      },
      clear() {
        const r = request();
        map.clear();
        return r;
      },
      getAllKeys() {
        const r = request();
        r.result = Array.from(map.keys());
        return r;
      },
      openCursor() {
        const keys = Array.from(map.keys());
        let i = 0;
        const r = { result: null, error: null, onsuccess: null, onerror: null };
        const step = () => {
          if (i >= keys.length) { r.result = null; if (r.onsuccess) r.onsuccess({ target: r }); return; }
          const key = keys[i++];
          r.result = { key, value: map.get(key), continue: step };
          if (r.onsuccess) r.onsuccess({ target: r });
        };
        queueMicrotask(step);
        return r;
      }
    };
  }
  return {
    open(name, version) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      const isNew = !dbs.has(name);
      let rec = dbs.get(name);
      if (!rec) {
        rec = { version: version || 1, stores: new Map() };
        dbs.set(name, rec);
      }
      const db = {
        objectStoreNames: { contains: (n) => rec.stores.has(n) },
        createObjectStore: (n) => { rec.stores.set(n, new Map()); },
        transaction: (n) => {
          const t = { objectStore: () => makeStore(rec.stores.get(n)), oncomplete: null, onerror: null, onabort: null, error: null };
          /* 事务完成晚于请求回调，留出挂载 oncomplete 的时间 */
          setTimeout(() => { if (typeof t.oncomplete === 'function') t.oncomplete(); }, 0);
          return t;
        }
      };
      req.result = db;
      queueMicrotask(() => {
        if (isNew && typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ target: req });
        if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
      });
      return req;
    }
  };
}

test('content id is stable and length-suffixed', () => {
  assert.equal(idFor('abc'), idFor('abc'));
  assert.notEqual(idFor('abc'), idFor('abd'));
  assert.match(idFor('abc'), /^[0-9a-f]{8}-3$/);
  assert.equal(new TextDecoder().decode(toBytes('你好')), '你好');
});

test('id prefix preserves legacy ids', () => {
  assert.match(idFor('abc', { prefix: 'bg' }), /^bg[0-9a-f]{8}-3$/);
  assert.match(idFor('abc', { prefix: 'as' }), /^as[0-9a-f]{8}-3$/);
  const a = createAssets({ driver: memoryDriver(), idPrefix: 'as' });
  return a.put('abc').then((id) => assert.match(id, /^as[0-9a-f]{8}-3$/));
});

test('legacy bg/as ids written by older projects remain readable', async () => {
  const a = createAssets({ driver: memoryDriver() });
  const legacy = ['bg4f9f2cab-12', 'asd0aa6218-7'];
  await a.putWithId(legacy[0], 'bg-bytes');
  await a.putWithId(legacy[1], 'as-bytes');
  assert.equal(new TextDecoder().decode((await a.get(legacy[0])).bytes), 'bg-bytes');
  assert.equal(new TextDecoder().decode((await a.get(legacy[1])).bytes), 'as-bytes');
  assert.deepEqual(await a.ids(), legacy);
});

test('put dedupes identical bytes', async () => {
  const a = createAssets({ driver: memoryDriver() });
  const id1 = await a.put('same', { name: 'a' });
  const id2 = await a.put(new TextEncoder().encode('same'), { name: 'b' });
  assert.equal(id1, id2);
  assert.equal(await a.size(), 1);
  const row = await a.get(id1);
  assert.equal(new TextDecoder().decode(row.bytes), 'same');
  assert.equal(row.meta.name, 'a');
});

test('getMap returns object by default and Map on demand', async () => {
  const a = createAssets({ driver: memoryDriver() });
  const keep = await a.put('keep');
  const asObject = await a.getMap([keep, 'missing']);
  assert.ok(asObject[keep]);
  assert.equal(asObject.missing, undefined);
  const asMap = await a.getMap([keep], { asMap: true });
  assert.ok(asMap instanceof Map);
  assert.ok(asMap.get(keep));
});

test('putWithId keeps explicit ids for backup restore', async () => {
  const a = createAssets({ driver: memoryDriver() });
  const id = 'asdeadbeef-3';
  await a.putWithId(id, 'abc');
  assert.deepEqual(await a.ids(), [id]);
  const ids = await a.putEntries([{ id, data: 'abc' }, { data: 'new' }]);
  assert.equal(ids[0], id);
  assert.equal(ids.length, 2);
});

test('removeOrphans', async () => {
  const a = createAssets({ driver: memoryDriver() });
  const keep = await a.put('keep');
  const drop = await a.put('drop');
  const removed = await a.removeOrphans([keep]);
  assert.equal(removed, 1);
  assert.deepEqual(await a.ids(), [keep]);
  assert.equal(await a.get(drop), null);
});

test('idbDriver stores, enumerates and removes through IndexedDB', async () => {
  const driver = idbDriver({ factory: fakeIndexedDB(), dbName: 'test-db', storeName: 'assets' });
  await driver.putWithId('a1', new Uint8Array([1, 2]), { mime: 'image/png' });
  const row = await driver.get('a1');
  assert.equal(row.id, 'a1');
  assert.deepEqual(Array.from(row.bytes), [1, 2]);
  assert.equal(row.meta.mime, 'image/png');
  assert.deepEqual(await driver.ids(), ['a1']);
  const all = await driver.all();
  assert.equal(all[0].size, 2);
  await driver.remove('a1');
  assert.deepEqual(await driver.ids(), []);
  await driver.clear();
});

test('requires a driver with the full interface', () => {
  assert.throws(() => createAssets(), /需要注入 driver/);
  assert.throws(() => createAssets({ driver: {} }), /缺少 get/);
});

test('cjs entry loads the same surface', () => {
  const cjs = require('../src/index.cjs');
  assert.equal(cjs.idFor('abc'), idFor('abc'));
  assert.equal(typeof cjs.createAssets, 'function');
  assert.equal(typeof cjs.idbDriver, 'function');
});
