#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成导入测试样例文件（零依赖优先，仅用标准库 zipfile 写 docx；
xlsx 优先用 openpyxl（可生成 sharedStrings 以覆盖该解析分支），
无 openpyxl 时回退到标准库手写 inlineStr 版本）。
输出目录：qb/samples/
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'samples')
os.makedirs(OUT, exist_ok=True)

# ---------------- 通用示例题目内容 ----------------
TABLE_HEADER = ['题型', '题目', '选项A', '选项B', '选项C', '选项D', '答案', '解析']
TABLE_ROWS = [
    ['单选', '数据清洗的第一步通常是？', '数据采集', '数据清洗', '模型训练', '结果评估', 'B', '先清洗再做建模。'],
    ['多选', '以下哪些属于数据质量维度？', '完整性', '准确性', '一致性', '及时性', 'ABCD', '四项均为常见维度。'],
    ['判断', 'SQL 中用于查询数据的关键字是 SELECT。', '对', '错', '', '', 'A', 'SELECT 用于查询。'],
    ['填空', 'Python 中定义函数使用的关键字是 ____ 。', '', '', '', '', 'def', 'def 是定义函数的关键字。'],
    ['简答', '请简述数据库事务的 ACID 四个特性。', '', '', '', '', '原子性、一致性、隔离性、持久性', 'ACID 是事务的基本保证。'],
]

DOC_LINES = [
    '1. （单选题）数据清洗的第一步通常是？',
    'A. 数据采集',
    'B. 数据清洗',
    'C. 模型训练',
    'D. 结果评估',
    '答案：B',
    '解析：先清洗再做建模。',
    '',
    '2. （多选题）以下哪些属于数据质量维度？',
    'A. 完整性',
    'B. 准确性',
    'C. 一致性',
    'D. 及时性',
    '答案：ABCD',
    '解析：四项均为常见数据质量维度。',
    '',
    '3. （判断题）SQL 中用于查询数据的关键字是 SELECT。',
    '答案：正确',
    '解析：SELECT 用于查询数据。',
    '',
    '4. （填空题）Python 中定义函数使用的关键字是 ____ 。',
    '答案：def',
    '解析：def 是定义函数的标准关键字。',
    '',
    '5. （简答题）请简述数据库事务的 ACID 四个特性。',
    '答案：原子性、一致性、隔离性、持久性',
    '解析：ACID 是事务的基本保证。',
]

CT = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''


def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def gen_docx(path):
    paras = ''.join(
        '<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % esc(line)
        for line in DOC_LINES
    )
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           '<w:body>%s</w:body></w:document>' % paras)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CT)
        z.writestr('_rels/.rels', RELS)
        z.writestr('word/document.xml', doc)


def gen_xlsx_openpyxl(path):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = '题库'
    ws.append(TABLE_HEADER)
    for row in TABLE_ROWS:
        ws.append(row)
    wb.save(path)


def gen_xlsx_manual(path):
    """回退方案：stdlib 手写最小 xlsx（inlineStr 单元格）"""
    rows_xml = []
    def cell(ref, text, inline=True):
        return ('<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>'
                % (ref, esc(text)))
    def col(i):
        s = ''
        i += 1
        while i:
            i, r = divmod(i - 1, 26)
            s = chr(65 + r) + s
        return s
    all_rows = [TABLE_HEADER] + TABLE_ROWS
    for ri, row in enumerate(all_rows, start=1):
        cells = ''.join(cell('%s%d' % (col(ci), ri), v) for ci, v in enumerate(row))
        rows_xml.append('<row r="%d">%s</row>' % (ri, cells))
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             '<sheetData>%s</sheetData></worksheet>' % ''.join(rows_xml))
    ct = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>'''
    root_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''
    wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          '<sheets><sheet name="题库" sheetId="1" r:id="rId1"/></sheets></workbook>')
    wb_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>'''
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct)
        z.writestr('_rels/.rels', root_rels)
        z.writestr('xl/workbook.xml', wb)
        z.writestr('xl/_rels/workbook.xml.rels', wb_rels)
        z.writestr('xl/worksheets/sheet1.xml', sheet)


def main():
    xlsx = os.path.join(OUT, '示例-表格导入.xlsx')
    docx = os.path.join(OUT, '示例-文档导入.docx')
    try:
        gen_xlsx_openpyxl(xlsx)
        via = 'openpyxl (sharedStrings)'
    except Exception as e:
        print('openpyxl 不可用（%s），回退到标准库 inlineStr' % e)
        gen_xlsx_manual(xlsx)
        via = 'stdlib (inlineStr)'
    gen_docx(docx)
    for p in (xlsx, docx):
        print('%s  %d bytes' % (os.path.relpath(p), os.path.getsize(p)))
    print('xlsx 生成方式:', via)


if __name__ == '__main__':
    sys.exit(main())