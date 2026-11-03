"""生成 samples/anki 下的 .apkg 回归夹具（仅用 Python 标准库 sqlite3/zipfile）。

用法：python samples/anki/gen_fixtures.py
产物覆盖：Legacy1/Legacy2、UTF-16、深分页/freelist/被删记录/overflow、
缺 anki21 回退、Latest（meta=3）、坏 SQLite、损坏 ZIP。
注意：这些是**构造夹具**，不是 Anki 客户端原生导出；真实样本见 CHANGELOG.internal.md。
"""
import json, os, sqlite3, zipfile, struct, shutil

OUT = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)

COL_SQL = """CREATE TABLE col (
  id INTEGER PRIMARY KEY, crt INTEGER, mod INTEGER, scm INTEGER, ver INTEGER,
  dty INTEGER, usn INTEGER, ls INTEGER, conf TEXT, models TEXT, decks TEXT,
  dconf TEXT, tags TEXT)"""
NOTES_SQL = """CREATE TABLE notes (
  id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, mod INTEGER, usn INTEGER,
  tags TEXT, flds TEXT, sfld INTEGER, csum INTEGER, flags INTEGER, data TEXT)"""
CARDS_SQL = """CREATE TABLE cards (
  id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER, mod INTEGER,
  usn INTEGER, type INTEGER, queue INTEGER, due INTEGER, ivl INTEGER, factor INTEGER,
  reps INTEGER, lapses INTEGER, left INTEGER, odue INTEGER, odid INTEGER, flags INTEGER, data TEXT)"""
REVLOG_SQL = """CREATE TABLE revlog (
  id INTEGER PRIMARY KEY, cid INTEGER, usn INTEGER, ease INTEGER, ivl INTEGER,
  lastIvl INTEGER, factor INTEGER, time INTEGER, type INTEGER)"""
GRAVES_SQL = "CREATE TABLE graves (usn INTEGER, oid INTEGER, type INTEGER)"

MODELS = {
  "1": {"id": 1, "name": "Basic", "type": 0,
        "flds": [{"name": "Front", "ord": 0}, {"name": "Back", "ord": 1}],
        "tmpls": [{"name": "Card 1", "ord": 0}]},
  "2": {"id": 2, "name": "Cloze", "type": 1,
        "flds": [{"name": "Text", "ord": 0}, {"name": "Extra", "ord": 1}],
        "tmpls": [{"name": "Cloze", "ord": 0}]},
  "3": {"id": 3, "name": "Basic (and reversed)", "type": 0,
        "flds": [{"name": "Front", "ord": 0}, {"name": "Back", "ord": 1}],
        "tmpls": [{"name": "Card 1", "ord": 0}, {"name": "Card 2", "ord": 1}]},
  "4": {"id": 4, "name": "Three fields", "type": 0,
        "flds": [{"name": "Front", "ord": 0}, {"name": "Back", "ord": 1}, {"name": "Extra", "ord": 2}],
        "tmpls": [{"name": "Card 1", "ord": 0}]},
  "5": {"id": 5, "name": "Judge", "type": 0,
        "flds": [{"name": "Question", "ord": 0}, {"name": "Reponse", "ord": 1}],
        "tmpls": [{"name": "Card 1", "ord": 0}]},
  "6": {"id": 6, "name": "Choice", "type": 0,
        "flds": [{"name": "Question", "ord": 0}, {"name": "Reponse", "ord": 1}],
        "tmpls": [{"name": "Card 1", "ord": 0}]},
}
DECKS = {"1": {"id": 1, "name": "默认::数学"}}


def new_db(path, utf16=False):
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path)
    if utf16:
        con.execute("PRAGMA encoding='UTF-16le'")
    for sql in (COL_SQL, NOTES_SQL, CARDS_SQL, REVLOG_SQL, GRAVES_SQL):
        con.execute(sql)
    con.execute("INSERT INTO col (id,ver,models,decks,dconf,tags) VALUES (1,11,?,?,?,'')",
                (json.dumps(MODELS, ensure_ascii=False), json.dumps(DECKS, ensure_ascii=False), '{}'))
    return con


def add_note(con, nid, guid, mid, flds, tags='', cards=1, did=1):
    con.execute("INSERT INTO notes (id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (nid, guid, mid, 0, 0, tags, '\x1f'.join(flds), 0, 0, 0, ''))
    for i in range(cards):
        cid = nid * 10 + i
        con.execute("INSERT INTO cards (id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (cid, nid, did, i, 0, 0, 0, 0, i, 0, 0, 0, 0, 0, 0, 0, 0, ''))


def add_revlog(con, rid, cid, ease=3):
    con.execute("INSERT INTO revlog (id,cid,usn,ease,ivl,lastIvl,factor,time,type) VALUES (?,?,?,?,?,?,?,?,?)",
                (rid, cid, 0, ease, 1, 0, 2500, 1000, 0))


def pack(path, collection_name, db_path, meta_version, media=None, extra_entries=None, placeholder=None):
    media = media or {}
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(collection_name, open(db_path, 'rb').read())
        if placeholder:
            z.writestr(placeholder[0], placeholder[1])
        z.writestr('media', json.dumps(media, ensure_ascii=False))
        z.writestr('meta', bytes([0x08, meta_version]))
        for name, data in (extra_entries or {}).items():
            z.writestr(name, data)


def build_legacy2():
    db = os.path.join(OUT, '_legacy2.db')
    con = new_db(db)
    add_note(con, 1, 'g1', 1, ['2 × 3', '6'])                       # essay
    add_note(con, 2, 'g2', 5, ['地球是圆的', '正确'])                # judge
    add_note(con, 3, 'g3', 6, ['法国的首都是？\nA. 巴黎\nB. 伦敦\nC. 柏林', 'A'])  # single
    add_note(con, 4, 'g4', 2, ['{{c1::巴黎}}是法国的首都，{{c2::塞纳河}}流经。', '地理'], cards=2)  # cloze
    add_note(con, 5, 'g5', 4, ['a', 'b', 'c'])                      # extra field
    add_note(con, 6, 'g6', 1, ['', '空题干'])                        # empty
    add_note(con, 7, 'g7', 1, ['只有一个字段'])                       # missing fields
    add_note(con, 8, 'g8', 3, ['反向题', '反向答案'], cards=2)         # multi card
    add_note(con, 9, 'g9', 1, ['2 × 3', '6'])                       # duplicate
    add_note(con, 10, 'g10', 1, ['<img src="img1.png"> 看图', '图片答案'])
    add_note(con, 11, 'g11', 1, ['<img src="missing.png"> 缺图', '缺图答案'])
    add_note(con, 12, 'g12', 1, ['<b>粗体</b><br>换行 &amp; 实体', '参考'])
    add_note(con, 13, 'g13', 1, ['声音题', '[sound:audio.mp3]'])
    add_note(con, 14, 'g14', 1, ['超大字段', 'x' * 50000])            # overflow
    add_note(con, 15, 'g15', 1, ['无卡 note', '仍导入'], cards=0)      # orphan note
    con.execute("INSERT INTO notes (id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data) VALUES (16,'g16',1,0,0,'tag1 tag2','语法::术语','',0,0,'')")
    con.execute("INSERT INTO cards (id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data) VALUES (160,16,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,'')")
    for i in range(5):
        add_revlog(con, 100 + i, (i + 1) * 10)
    con.commit()
    con.close()
    png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082')
    pack(os.path.join(OUT, '示例-Anki-Legacy2.apkg'), 'collection.anki21', db, 2,
         media={'img1.png': '0', 'audio.mp3': '1'},
         extra_entries={'0': png, '1': b'ID3fakeaudio'},
         placeholder=('collection.anki2', b'placeholder-not-a-real-db'))
    os.remove(db)


def build_legacy1():
    db = os.path.join(OUT, '_legacy1.db')
    con = new_db(db)
    add_note(con, 1, 'l1', 1, ['apple', '苹果'])
    add_note(con, 2, 'l2', 1, ['banana', '香蕉'])
    con.commit()
    con.close()
    pack(os.path.join(OUT, '示例-Anki-Legacy1.apkg'), 'collection.anki2', db, 1)
    os.remove(db)


def build_utf16():
    db = os.path.join(OUT, '_utf16.db')
    con = new_db(db, utf16=True)
    add_note(con, 1, 'u1', 1, ['中文题干', '中文答案'])
    add_note(con, 2, 'u2', 1, ['emoji 😀', '答案 ✓'])
    con.commit()
    con.close()
    pack(os.path.join(OUT, '示例-Anki-UTF16.apkg'), 'collection.anki2', db, 1)
    os.remove(db)


def build_stress():
    db = os.path.join(OUT, '_stress.db')
    con = new_db(db)
    for i in range(1, 401):
        add_note(con, i, 's%d' % i, 1, ['题目 %d' % i, '答案 %d' % i])
        if i == 1:
            con.execute("UPDATE notes SET flds=? WHERE id=1", ('长题干' + 'y' * 80000 + '\x1f答案',))
    con.commit()
    con.execute("DELETE FROM notes WHERE id BETWEEN 201 AND 400")
    con.execute("DELETE FROM cards WHERE nid BETWEEN 201 AND 400")
    con.commit()
    freelist = con.execute("PRAGMA freelist_count").fetchone()[0]
    con.close()
    pack(os.path.join(OUT, '示例-Anki-深分页.apkg'), 'collection.anki2', db, 1)
    os.remove(db)
    return freelist


def build_latest():
    with zipfile.ZipFile(os.path.join(OUT, '示例-Anki-Latest.apkg'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('collection.anki21b', b'\x28\xb5\x2f\xfd fake-zstd-payload')
        z.writestr('media', '')
        z.writestr('meta', bytes([0x08, 0x03]))


def build_corrupt():
    with open(os.path.join(OUT, '示例-Anki-损坏.apkg'), 'wb') as f:
        f.write(b'not a zip file, just plain text')


def build_bad_sqlite():
    with zipfile.ZipFile(os.path.join(OUT, '示例-Anki-坏库.apkg'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('collection.anki2', b'not a sqlite database')
        z.writestr('media', '{}')
        z.writestr('meta', bytes([0x08, 0x01]))


def build_fallback():
    db = os.path.join(OUT, '_fallback.db')
    con = new_db(db)
    add_note(con, 1, 'f1', 1, ['回退题', '回退答案'])
    con.commit()
    con.close()
    pack(os.path.join(OUT, '示例-Anki-Legacy2-缺anki21.apkg'), 'collection.anki2', db, 2)
    os.remove(db)


freelist = build_stress()
build_legacy2(); build_legacy1(); build_utf16(); build_latest(); build_corrupt(); build_bad_sqlite(); build_fallback()
print('fixtures written to', os.path.abspath(OUT), 'stress freelist=', freelist)
