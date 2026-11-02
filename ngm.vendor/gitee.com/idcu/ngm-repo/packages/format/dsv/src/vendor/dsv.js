/* dsv.js —— CSV/TSV 等分隔文本解析（零依赖，支持引号转义/引号内换行/BOM/自动探测）
 * 借鉴 qforge/js/importers/csv-importer.js，可独立复用。 */
(function (global) {
  'use strict';
/* ---- CSV / TSV：原生状态机（引号转义、引号内换行、BOM） ---- */
function parseRows(text,delimiter){
  if(text.charCodeAt(0)===0xfeff) text=text.slice(1);
  const rows=[]; let row=[], field='', inQuotes=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inQuotes){
      if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i++; } else inQuotes=false; }
      else field+=c;
    }else if(c==='"') inQuotes=true;
    else if(c===delimiter){ row.push(field); field=''; }
    else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
    else if(c!=='\r') field+=c;
  }
  if(field!==''||row.length){ row.push(field); rows.push(row); }
  return rows;
}
function detectDelimiter(text){
  const firstLine=text.split(/\r?\n/)[0]||'';
  const commas=(firstLine.match(/,/g)||[]).length, tabs=(firstLine.match(/\t/g)||[]).length, semis=(firstLine.match(/;/g)||[]).length;
  if(tabs>commas&&tabs>=semis) return '\t';
  if(semis>commas) return ';';
  return ',';
}
/* ---- 写出：单格转义 + 整表拼接（BOM/分隔符/换行/公式注入/加引号触发集均为显式选项） ---- */
/* guardFormula: false | true（= + - @ Tab CR 开头）| RegExp | Function(s,原始值)
 * quoteChars: RegExp 自定义“需要加引号”的字符集（默认按 delimiter + 引号 + 换行判断）
 * 默认 false / 内置集合，保证各消费方按自己原有策略显式传入。 */
function quoteCell(value,opt){
  const o=opt||{};
  const delimiter=o.delimiter||',';
  let s=String(value==null?'':value);
  const guard=o.guardFormula;
  if(guard){
    let hit;
    if(typeof guard==='function') hit=!!guard(s,value);
    else { const re=guard instanceof RegExp?guard:/^[=+\-@\t\r]/; hit=re.test(s); }
    if(hit) s="'"+s;
  }
  let needs;
  if(o.quoteChars instanceof RegExp){
    o.quoteChars.lastIndex=0;
    needs=o.quoteChars.test(s);
  }else{
    needs=s.indexOf('"')>=0||s.indexOf('\n')>=0||s.indexOf('\r')>=0||s.indexOf(delimiter)>=0;
  }
  return needs?'"'+s.replace(/"/g,'""')+'"':s;
}
function formatRows(rows,opt){
  const o=opt||{};
  const delimiter=o.delimiter||',';
  const eol=o.eol!=null?String(o.eol):'\r\n';
  const body=(rows||[]).map(row=>(row||[]).map(v=>quoteCell(v,{
    delimiter:delimiter,
    guardFormula:o.guardFormula,
    quoteChars:o.quoteChars
  })).join(delimiter)).join(eol);
  return (o.bom===false?'':'\ufeff')+body;
}
  global.DSV = {
    parseRows: parseRows,
    detectDelimiter: detectDelimiter,
    quoteCell: quoteCell,
    formatRows: formatRows
  };
})(typeof window !== 'undefined' ? window : globalThis);
