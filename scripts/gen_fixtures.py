#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成导入测试样例文件（零依赖优先，仅用标准库 zipfile 写 docx；
xlsx 优先用 openpyxl（可生成 sharedStrings 以覆盖该解析分支），
无 openpyxl 时回退到标准库手写 inlineStr 版本）。
输出目录：qb/samples/
"""
import os
import re
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


def write_docx(path, lines):
    """公共：文本行 → 最小 docx（一段一行；空行写空段落，导入端会跳过）"""
    paras = ''.join(
        '<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % esc(line)
        for line in lines
    )
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           '<w:body>%s</w:body></w:document>' % paras)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CT)
        z.writestr('_rels/.rels', RELS)
        z.writestr('word/document.xml', doc)


def gen_docx(path):
    write_docx(path, DOC_LINES)


# ---------------- 材料题（M2）行式夹具 ----------------
# 与 samples/示例-材料题.json 同内容（纯文本行源，docx 段落与 md 行均由此派生）；
# 末尾追加一道普通题，覆盖「顶层题号收尾材料块」的真实文件边界。
MATERIAL_PLAIN_LINES = [
    '1. [材料题] 根据上述资料，回答下列问题。',
    '材料：甲公司为增值税一般纳税人，2026 年 3 月购入一台不需安装的生产设备，'
    '取得增值税专用发票注明价款 10000 元（不含税），另支付运输费 2000 元。设备当月投入使用。',
    '难度：3',
    '标签：综合题、固定资产',
    '分类：会计基础',
    '(1). [单选] （1）该设备的入账价值为（ ）元。',
    'A. 10000',
    'B. 12000',
    'C. 11300',
    'D. 13560',
    '答案：B',
    '解析：不需安装设备入账价值=买价 10000+运输费 2000=12000 元。',
    '(2). [不定项] （2）下列关于该业务的说法，正确的有（ ）。',
    'A. 运输费计入固定资产成本',
    'B. 当月增加的固定资产当月不计提折旧',
    'C. 增值税进项税额一律计入资产成本',
    'D. 设备投入使用后按确定的方法计提折旧',
    '答案：ABD',
    '解析：一般纳税人可抵扣进项税不计入成本，C 错误。',
    '(3). [判断] （3）不需安装的设备购入并达到可使用状态后直接计入“固定资产”科目。',
    '答案：正确',
    '解析：不需安装，购入即达到预定可使用状态。',
    '(4). [填空] （4）该设备买价为 ____ 元（不含税）。',
    '答案：10000',
    '解析：专用发票注明不含税价款 10000 元。',
    '(5). [简答] （5）简述运输费计入资产成本的理由。',
    '答案：运输费是使固定资产达到预定可使用状态前所发生的必要支出，按准则应计入固定资产成本。',
    '解析：考查外购固定资产初始计量口径。',
    '',
    '2. [单选] 材料块结束后的普通题，验证顶层题号自动收尾材料块。',
    'A. 顶层题号收尾',
    'B. 仍在材料块内',
    '答案：A',
    '解析：遇下一个顶层题号即关闭材料块。',
]

_RE_MD_HEAD = re.compile(r'^\d+\.\s\[')
_RE_MD_OPTION = re.compile(r'^([A-H])\.\s(.+)$')
_RE_MD_META = re.compile(r'^(?:难度|标签|分类|解析)：')


def to_md_lines(lines):
    """纯文本行 → Markdown 排版（与 js/modules/exporter.js buildMarkdown 风格一致）"""
    out = []
    for line in lines:
        if not line:
            out.append('')
        elif _RE_MD_HEAD.match(line):
            out.append('## ' + line)
        elif _RE_MD_OPTION.match(line):
            out.append(_RE_MD_OPTION.sub(r'- **\1.** \2', line))
        elif line.startswith('答案：'):
            out.append('**' + line + '**')
        elif _RE_MD_META.match(line):
            out.append('> ' + line)
        else:
            out.append(line)
    return out


def gen_material_md(path):
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(to_md_lines(MATERIAL_PLAIN_LINES)) + '\n')


def gen_material_docx(path):
    write_docx(path, MATERIAL_PLAIN_LINES)


DOCX_IMAGE_LINES = [
    ('1. （单选题）下图所示电路符号表示的元件是？', None),
    (None, 'IMAGE'),
    ('A. 电阻', None),
    ('B. 电容', None),
    ('C. 电感', None),
    ('D. 开关', None),
    ('答案：A', None),
    ('解析：该符号为电阻。', None),
    ('', None),
    ('2. （判断题）标准大气压下水的沸点是 100℃。', None),
    ('答案：正确', None),
]


def tiny_png():
    """构造最小合法 PNG（2×2 RGB，标准库 zlib；仅作导入夹具）"""
    import struct
    import zlib

    def chunk(typ, data):
        c = typ + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    raw = b''
    for _ in range(2):
        raw += b'\x00' + bytes([255, 0, 0, 0, 255, 0])  # 每行 filter(0) + 2 像素 RGB
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))


def gen_docx_with_image(path):
    """含 1 张内嵌 PNG 的 docx：图片在第 1 题题干的独立段落（DrawingML a:blip）"""
    png = tiny_png()

    def para(item):
        line, kind = item
        if kind == 'IMAGE':
            blip = (
                '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
                '<wp:extent cx="952500" cy="952500"/>'
                '<wp:docPr id="1" name="图片1"/>'
                '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
                '<pic:pic>'
                '<pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>'
                '<pic:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
                '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm>'
                '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
                '</pic:pic>'
                '</a:graphicData></a:graphic>'
                '</wp:inline></w:drawing></w:r>'
            )
            return '<w:p>%s</w:p>' % blip
        return '<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % esc(line)

    paras = ''.join(para(item) for item in DOCX_IMAGE_LINES)
    doc = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document '
        'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<w:body>%s</w:body></w:document>' % paras
    )
    ct = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''
    doc_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>'''
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct)
        z.writestr('_rels/.rels', RELS)
        z.writestr('word/_rels/document.xml.rels', doc_rels)
        z.writestr('word/document.xml', doc)
        z.writestr('word/media/image1.png', png)


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
    # 独立参数：仅生成指定夹具，不触碰既有样例
    if len(sys.argv) > 1 and sys.argv[1] == '--docx-image':
        p = os.path.join(OUT, '示例-文档导入-含图.docx')
        gen_docx_with_image(p)
        print('%s  %d bytes' % (os.path.relpath(p), os.path.getsize(p)))
        return
    if len(sys.argv) > 1 and sys.argv[1] == '--material-md':
        for p in (
            os.path.join(OUT, '示例-材料题.md'),
            os.path.join(OUT, '示例-材料题.docx'),
        ):
            if p.endswith('.md'):
                gen_material_md(p)
            else:
                gen_material_docx(p)
            print('%s  %d bytes' % (os.path.relpath(p), os.path.getsize(p)))
        return
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