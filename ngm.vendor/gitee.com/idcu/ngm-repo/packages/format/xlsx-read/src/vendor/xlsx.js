/* xlsx.js —— 零依赖真 .xlsx 读写（OOXML 最小子集 + Zip 打包）。
 * build(table, sheetName) 生成 ArrayBuffer；readRows(arrayBuffer) 合并全部工作表为二维表。
 * 依赖同目录 zip.js、xml-lite.js。借鉴 qforge/js/modules/office-writer.js + importers/xlsx-importer.js。 */
(function (global) {
  'use strict';
  const Zip = global.Zip;
  const XmlLite = global.XmlLite;
  const decodeUtf8 = Zip.decodeUtf8, zipBuild = Zip.build, zipReadEntries = Zip.readEntries;
  function xmlEscape(s){ return String(s==null?"":s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m])); }

/* ---- XLSX 构建（inlineStr，单工作簿；结构对齐最小 OOXML，Excel/WPS 可开） ---- */
const XML_HEAD='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
function xlsxColLetter(i){ let s=''; i+=1; while(i){ const r=(i-1)%26; s=String.fromCharCode(65+r)+s; i=Math.floor((i-1)/26); } return s; }
function xlsxSheetXml(table){
  const rowsXml=table.map((row,ri)=>{
    const rn=ri+1;
    const cells=row.map((v,ci)=>'<c r="'+xlsxColLetter(ci)+rn+'" t="inlineStr"><is><t xml:space="preserve">'+xmlEscape(String(v==null?'':v))+'</t></is></c>').join('');
    return '<row r="'+rn+'">'+cells+'</row>';
  }).join('');
  return XML_HEAD+'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rowsXml+'</sheetData></worksheet>';
}
function buildXlsx(table, sheetName){
  sheetName = sheetName || 'Sheet1';
  const entries=[
    {name:'[Content_Types].xml',text:XML_HEAD+
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
      '<Default Extension="xml" ContentType="application/xml"/>'+
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'+
      '</Types>'},
    {name:'_rels/.rels',text:XML_HEAD+
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'+
      '</Relationships>'},
    {name:'xl/workbook.xml',text:XML_HEAD+
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'+
      '<sheets><sheet name="'+xmlEscape(sheetName)+'" sheetId="1" r:id="rId1"/></sheets></workbook>'},
    {name:'xl/_rels/workbook.xml.rels',text:XML_HEAD+
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'+
      '</Relationships>'},
    {name:'xl/worksheets/sheet1.xml',text:xlsxSheetXml(table)}
  ];
  return zipBuild(entries);
}

/* ---- XLSX 读取：全部工作表 → 二维字符串表（含共享字符串/inlineStr/数字） ---- */
function xlsxColToIndex(ref){
  const m=String(ref||'').match(/^([A-Z]+)/i); if(!m) return 0;
  let n=0; const s=m[1].toUpperCase();
  for(let i=0;i<s.length;i++) n=n*26+(s.charCodeAt(i)-64);
  return n-1;
}
/* ---- 读取上限：防止超大表格占用内存（测试可传入更小的 opt） ---- */
const XLSX_LIMITS={maxRows:50000,maxCols:1000,maxSheets:50};
function xlsxSheetToRows(xmlText,shared,opt){
  const L=Object.assign({},XLSX_LIMITS,opt||{});
  const doc=XmlLite.parse(xmlText);
  const rowsEls=doc.getElementsByTagName('row'); const rows=[];
  if(rowsEls.length>L.maxRows) throw new Error('表格行数超过上限 '+L.maxRows+' 行，请拆分后导入');
  for(let i=0;i<rowsEls.length;i++){
    const cells=rowsEls[i].getElementsByTagName('c'); const row=[];
    if(cells.length>L.maxCols) throw new Error('表格列数超过上限 '+L.maxCols+' 列，请精简后导入');
    for(let j=0;j<cells.length;j++){
      const c=cells[j];
      const idx=c.getAttribute('r')?xlsxColToIndex(c.getAttribute('r')):row.length;
      const t=c.getAttribute('t'); let value='';
      if(t==='inlineStr'){
        const ts=c.getElementsByTagName('t'); for(let k=0;k<ts.length;k++) value+=ts[k].textContent;
      }else{
        const vs=c.getElementsByTagName('v'); const raw=vs.length?vs[0].textContent:'';
        value=(t==='s')?(shared[parseInt(raw,10)]||''):raw;
      }
      row[idx]=value;
    }
    for(let k=0;k<row.length;k++) if(row[k]===undefined) row[k]='';
    rows.push(row);
  }
  return rows;
}
async function xlsxReadRows(arrayBuffer,opt){
  const L=Object.assign({},XLSX_LIMITS,opt||{});
  const entries=await zipReadEntries(arrayBuffer,opt);
  let shared=[];
  if(entries['xl/sharedStrings.xml']){
    const doc=XmlLite.parse(decodeUtf8(entries['xl/sharedStrings.xml']));
    const sis=doc.getElementsByTagName('si');
    shared=sis.map(si=>{ const ts=si.getElementsByTagName('t'); let s=''; for(let i=0;i<ts.length;i++) s+=ts[i].textContent; return s; });
  }
  // 按 workbook.xml + rels 顺序枚举工作表；缺清单时退回约定 sheet1
  const sheets=[];
  if(entries['xl/workbook.xml']&&entries['xl/_rels/workbook.xml.rels']){
    const relDoc=XmlLite.parse(decodeUtf8(entries['xl/_rels/workbook.xml.rels']));
    const relMap={};
    relDoc.getElementsByTagName('Relationship').forEach(r=>{
      let t=(r.getAttribute('Target')||'').replace(/^\//,''); t=t.indexOf('xl/')===0?t:'xl/'+t;
      relMap[r.getAttribute('Id')]=t;
    });
    const wbDoc=XmlLite.parse(decodeUtf8(entries['xl/workbook.xml']));
    wbDoc.getElementsByTagName('sheet').forEach((s,i)=>{
      const rid=s.getAttribute('r:id')||s.getAttribute('id');
      const path=(rid&&relMap[rid])?relMap[rid]:('xl/worksheets/sheet'+(i+1)+'.xml');
      if(entries[path]) sheets.push(path);
    });
  }else if(entries['xl/worksheets/sheet1.xml']) sheets.push('xl/worksheets/sheet1.xml');
  if(!sheets.length) throw new Error('XLSX 中未找到工作表');
  if(sheets.length>L.maxSheets) throw new Error('工作表数量超过上限 '+L.maxSheets+' 个，请拆分后导入');
  const known=h=>['编号','对象类型','X','Y','图层','业务类型'].some(k=>h.includes(k));
  const merged=[]; let used=0;
  sheets.forEach(path=>{
    const rows=xlsxSheetToRows(decodeUtf8(entries[path]),shared,opt);
    if(!rows.length) return;
    if(known(rows[0].map(x=>String(x||'').trim()))){ rows.forEach(r=>merged.push(r)); used++; }
  });
  if(merged.length>L.maxRows) throw new Error('合并后表格行数超过上限 '+L.maxRows+' 行，请拆分后导入');
  if(!used) xlsxSheetToRows(decodeUtf8(entries[sheets[0]]),shared,opt).forEach(r=>merged.push(r));
  return merged;
}
  global.Xlsx = { build: buildXlsx, readRows: xlsxReadRows, colLetter: xlsxColLetter, LIMITS: XLSX_LIMITS };
})(typeof window !== 'undefined' ? window : globalThis);
