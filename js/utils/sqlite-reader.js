/**
 * 最小 SQLite 只读解析器（零依赖，唯一实现）
 *
 * 只覆盖「读取 .apkg Legacy 包内 collection.anki2/.anki21 单文件快照」所需能力：
 *   - 100 字节文件头、页大小（offset 16，值 1 表示 65536）、保留区、文本编码
 *   - sqlite_master（根页 1）→ 表名/根页号/列名
 *   - 表 B-tree：叶子 0x0D 与内部页 0x05 递归；索引页不参与表扫描
 *   - record header + serial type（NULL/整数/浮点/UTF-8/UTF-16/blob）
 *   - overflow 页链（长 flds 会触发）
 *   - freelist 不遍历；被删除记录只存在于 freeblock，不进入 cell pointer 数组
 *
 * 明确不支持：写入、WAL、索引/虚拟表、加密库、跨页 journal。遇到损坏结构抛
 * `SqliteReadError`，由导入器转为可读警告，不静默返回错误行数。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const MAGIC = 'SQLite format 3\u0000';
  const MAX_DEPTH = 64;
  const MAX_ROWS = 2000000;
  const MAX_PAYLOAD = 64 * 1024 * 1024;

  class SqliteReadError extends Error {
    constructor(message) {
      super('SQLite 读取失败：' + message);
      this.name = 'SqliteReadError';
    }
  }

  function readU16(bytes, off) {
    if (off + 2 > bytes.length) throw new SqliteReadError('越界读取 u16 @' + off);
    return (bytes[off] << 8) | bytes[off + 1];
  }

  function readU32(bytes, off) {
    if (off + 4 > bytes.length) throw new SqliteReadError('越界读取 u32 @' + off);
    return (bytes[off] * 0x1000000) + (bytes[off + 1] << 16) + (bytes[off + 2] << 8) + bytes[off + 3];
  }

  /** SQLite varint（1..9 字节；第 9 字节占满 8 位） */
  function readVarint(bytes, off) {
    let value = 0;
    let pos = off;
    for (let i = 0; i < 9; i++) {
      if (pos >= bytes.length) throw new SqliteReadError('varint 越界 @' + off);
      const b = bytes[pos++];
      if (i === 8) return { value: value * 256 + b, next: pos };
      value = value * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return { value: value, next: pos };
    }
    throw new SqliteReadError('varint 超过 9 字节 @' + off);
  }

  function stripSqlComments(sql) {
    return String(sql || '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '');
  }

  /** 把 CREATE TABLE 定义拆成列名（只取顶层逗号；跳过表约束；先剥离 SQL 注释） */
  function columnsFromSql(sql) {
    const text = stripSqlComments(sql);
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close <= open) return [];
    const body = text.slice(open + 1, close);
    const parts = [];
    let start = 0;
    let depth = 0;
    let quote = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (quote) {
        if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '[') { quote = ']'; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(body.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(body.slice(start));
    const out = [];
    parts.forEach((raw) => {
      const piece = raw.trim();
      if (!piece) return;
      if (/^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(piece)) return;
      const m = piece.match(/^["'`[]?([^"'`\]\s]+)["'`\]]?/);
      if (m) out.push(m[1]);
    });
    return out;
  }

  /**
   * INTEGER PRIMARY KEY 是 rowid 别名：record 里该列常写成 NULL，查询时才由 SQLite
   * 替换为 rowid。读取层必须补回，否则 notes/cards 的 id 全部为 null。
   */
  function primaryKeyIndex(sql, columns) {
    const text = stripSqlComments(sql);
    let name = '';
    const inline = text.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s+INTEGER\s+PRIMARY\s+KEY\b/i);
    if (inline) name = inline[1];
    if (!name) {
      const tableLevel = text.match(/\bPRIMARY\s+KEY\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/i);
      if (tableLevel) name = tableLevel[1];
    }
    return name ? columns.indexOf(name) : -1;
  }

  function makeDecoder(encoding) {
    if (encoding === 2 || encoding === 3) {
      return function (bytes) {
        const units = new Uint8Array(bytes.length - (bytes.length % 2));
        if (encoding === 2) units.set(bytes.subarray(0, units.length));
        else {
          for (let i = 0; i + 1 < units.length; i += 2) {
            units[i] = bytes[i + 1];
            units[i + 1] = bytes[i];
          }
        }
        if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-16le').decode(units);
        let s = '';
        for (let i = 0; i < units.length; i += 2) s += String.fromCharCode(units[i] | (units[i + 1] << 8));
        return s;
      };
    }
    return function (bytes) {
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    };
  }

  function decodeInt(bytes, off, size) {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + bytes[off + i];
    if (size === 8) {
      // 8 字节有符号：先按无符号读，超过 2^63 时补负值
      if (v >= 0x8000000000000000) v -= 0x10000000000000000;
    } else {
      const limit = Math.pow(2, size * 8 - 1);
      if (v >= limit) v -= limit * 2;
    }
    return v;
  }

  function readDouble(bytes, off) {
    if (typeof DataView === 'undefined') return 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset + off, 8);
    return view.getFloat64(0, false);
  }

  function open(source) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    if (bytes.length < 100) throw new SqliteReadError('文件过短（' + bytes.length + ' 字节），不是 SQLite 数据库');
    let magic = '';
    for (let i = 0; i < 16; i++) magic += String.fromCharCode(bytes[i]);
    if (magic !== MAGIC) throw new SqliteReadError('文件头不是 SQLite format 3');

    const rawPageSize = readU16(bytes, 16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
      throw new SqliteReadError('非法页大小 ' + rawPageSize);
    }
    const reserved = bytes[20];
    const usableSize = pageSize - reserved;
    if (usableSize < 480) throw new SqliteReadError('可用页空间过小 ' + usableSize);

    const filePages = Math.floor(bytes.length / pageSize);
    const headerPages = readU32(bytes, 28);
    const pageCount = Math.min(headerPages || filePages, filePages);
    if (!pageCount) throw new SqliteReadError('数据库页数为 0');

    const encodingRaw = readU32(bytes, 56);
    const encoding = encodingRaw === 2 ? 2 : encodingRaw === 3 ? 3 : 1;
    const decoder = makeDecoder(encoding);

    const freelist = { trunk: readU32(bytes, 32), count: readU32(bytes, 36) };

    function pageInfo(pageNo) {
      if (pageNo < 1 || pageNo > pageCount) throw new SqliteReadError('页号越界 ' + pageNo);
      const start = (pageNo - 1) * pageSize;
      const hdr = pageNo === 1 ? 100 : 0;
      if (start + hdr + 8 > bytes.length) throw new SqliteReadError('页 ' + pageNo + ' 截断');
      const type = bytes[start + hdr];
      if (type !== 0x0d && type !== 0x05) {
        throw new SqliteReadError('表页 ' + pageNo + ' 类型非法 0x' + type.toString(16));
      }
      const cellCount = readU16(bytes, start + hdr + 3);
      const contentStart = readU16(bytes, start + hdr + 5);
      const ptrBase = hdr + (type === 0x05 ? 12 : 8);
      if (cellCount > Math.floor(usableSize / 2)) {
        throw new SqliteReadError('页 ' + pageNo + ' cell 数异常 ' + cellCount);
      }
      if (contentStart > pageSize) throw new SqliteReadError('页 ' + pageNo + ' cell 内容区非法');
      return {
        pageNo: pageNo, start: start, type: type, cellCount: cellCount,
        ptrBase: ptrBase,
        rightChild: type === 0x05 ? readU32(bytes, start + hdr + 8) : 0
      };
    }

    function cellOffset(info, i) {
      const off = readU16(bytes, info.start + info.ptrBase + i * 2);
      if (off < 1 || off >= pageSize) throw new SqliteReadError('页 ' + info.pageNo + ' cell 偏移非法 ' + off);
      return info.start + off;
    }

    /** 读取表叶子 cell 的完整 payload（含 overflow 链） */
    function readPayload(cellAbs, payloadSize) {
      if (payloadSize > MAX_PAYLOAD) throw new SqliteReadError('单条记录超过上限 ' + payloadSize);
      const maxLocal = usableSize - 35;
      const minLocal = Math.floor(((usableSize - 12) * 32) / 255) - 23;
      let local = payloadSize;
      if (payloadSize > maxLocal) {
        const surplus = minLocal + ((payloadSize - minLocal) % (usableSize - 4));
        local = surplus <= maxLocal ? surplus : minLocal;
      }
      if (cellAbs + local > bytes.length) throw new SqliteReadError('payload 越界');
      const out = new Uint8Array(payloadSize);
      out.set(bytes.subarray(cellAbs, cellAbs + local), 0);
      if (local >= payloadSize) return out;

      let next = readU32(bytes, cellAbs + local);
      let written = local;
      let guard = 0;
      while (next && written < payloadSize) {
        if (++guard > pageCount + 1) throw new SqliteReadError('overflow 链成环');
        if (next < 1 || next > pageCount) throw new SqliteReadError('overflow 页号越界 ' + next);
        const pageStart = (next - 1) * pageSize;
        if (pageStart + usableSize > bytes.length) throw new SqliteReadError('overflow 页截断');
        const take = Math.min(usableSize - 4, payloadSize - written);
        out.set(bytes.subarray(pageStart + 4, pageStart + 4 + take), written);
        written += take;
        next = readU32(bytes, pageStart);
      }
      if (written < payloadSize) throw new SqliteReadError('overflow 链提前结束');
      return out;
    }

    function parseRecord(payload) {
      const first = readVarint(payload, 0);
      const headerSize = first.value;
      if (headerSize < 1 || headerSize > payload.length) throw new SqliteReadError('record header 非法');
      let pos = first.next;
      const types = [];
      while (pos < headerSize) {
        const v = readVarint(payload, pos);
        types.push(v.value);
        pos = v.next;
      }
      let body = headerSize;
      return types.map(function (t) {
        if (t === 0) return null;
        if (t >= 1 && t <= 6) {
          const size = [0, 1, 2, 3, 4, 6, 8][t];
          if (body + size > payload.length) throw new SqliteReadError('record 整数越界');
          const value = decodeInt(payload, body, size);
          body += size;
          return value;
        }
        if (t === 7) {
          if (body + 8 > payload.length) throw new SqliteReadError('record 浮点越界');
          const value = readDouble(payload, body);
          body += 8;
          return value;
        }
        if (t === 8 || t === 9) return t === 9 ? 1 : 0;
        if (t === 10 || t === 11) return null;
        const len = t >= 12 ? (t - (t % 2 === 0 ? 12 : 13)) / 2 : 0;
        if (body + len > payload.length) throw new SqliteReadError('record 文本/blob 越界');
        const slice = payload.subarray(body, body + len);
        const value = (t % 2 === 0) ? new Uint8Array(slice) : decoder(slice);
        body += len;
        return value;
      });
    }

    function makeRow(values, columns, rowid, pkIndex) {
      const row = {};
      const names = columns && columns.length ? columns : values.map(function (_, i) { return 'col' + i; });
      names.forEach(function (name, i) {
        if (i < values.length) {
          row[name] = (i === pkIndex && values[i] == null) ? rowid : values[i];
        }
      });
      return row;
    }

    function walkTable(rootPage, columns, onRow, depth, pkIndex) {
      if (depth > MAX_DEPTH) throw new SqliteReadError('B-tree 递归过深');
      const info = pageInfo(rootPage);
      if (info.type === 0x0d) {
        for (let i = 0; i < info.cellCount; i++) {
          const cell = cellOffset(info, i);
          const sz = readVarint(bytes, cell);
          const rowid = readVarint(bytes, sz.next);
          const payload = readPayload(rowid.next, sz.value);
          onRow(makeRow(parseRecord(payload), columns, rowid.value, pkIndex), rowid.value);
        }
        return;
      }
      for (let i = 0; i < info.cellCount; i++) {
        const cell = cellOffset(info, i);
        const child = readU32(bytes, cell);
        walkTable(child, columns, onRow, depth + 1, pkIndex);
      }
      if (info.rightChild) walkTable(info.rightChild, columns, onRow, depth + 1, pkIndex);
    }

    const master = [];
    walkTable(1, ['type', 'name', 'tbl_name', 'rootpage', 'sql'], function (row) {
      master.push(row);
    }, 0, -1);

    const tables = {};
    master.forEach(function (row) {
      if (!row || row.type !== 'table' || !row.name) return;
      const columns = columnsFromSql(row.sql);
      tables[row.name] = {
        name: row.name,
        rootPage: row.rootpage,
        sql: row.sql || '',
        columns: columns,
        pkIndex: primaryKeyIndex(row.sql, columns)
      };
    });

    function hasTable(name) { return !!tables[name]; }

    function readTable(name, opts) {
      opts = opts || {};
      const table = tables[name];
      if (!table) {
        if (opts.required) throw new SqliteReadError('缺少表 ' + name);
        return [];
      }
      const rows = [];
      let truncated = false;
      walkTable(table.rootPage, table.columns, function (row, rowid) {
        if (rows.length >= (opts.limit || MAX_ROWS)) { truncated = true; return; }
        row.__rowid = rowid;
        rows.push(row);
      }, 0, table.pkIndex);
      if (truncated && opts.required) throw new SqliteReadError('表 ' + name + ' 行数超过上限');
      return rows;
    }

    return {
      pageSize: pageSize,
      usableSize: usableSize,
      reservedBytes: reserved,
      pageCount: pageCount,
      encoding: encoding,
      encodingName: encoding === 2 ? 'UTF-16LE' : encoding === 3 ? 'UTF-16BE' : 'UTF-8',
      freelist: freelist,
      tables: tables,
      master: master,
      hasTable: hasTable,
      readTable: readTable
    };
  }

  QB.SqliteReader = {
    open: open,
    SqliteReadError: SqliteReadError,
    columnsFromSql: columnsFromSql,
    readVarint: readVarint,
    MAGIC: MAGIC
  };
})(typeof window !== 'undefined' ? window : globalThis);
