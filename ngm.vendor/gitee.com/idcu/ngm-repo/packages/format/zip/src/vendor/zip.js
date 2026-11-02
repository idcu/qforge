/* zip.js —— 原生 ZIP 读写（零依赖）
 * 借鉴 qforge/js/utils/zip-writer.js + zip-reader.js：stored + CRC32 打包；
 * 读取支持 stored 直读与 method=8（浏览器原生 DecompressionStream）。可独立复用。 */
(function (global) {
  'use strict';
/* ---- CRC32（zlib 标准多项式）与 UTF-8 ---- */
const CRC_TABLE=(function(){
  const t=new Uint32Array(256);
  for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); t[n]=c>>>0; }
  return t;
})();
function crc32(bytes){
  let c=0xFFFFFFFF;
  for(let i=0;i<bytes.length;i++) c=CRC_TABLE[(c^bytes[i])&0xFF]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}
function encodeUtf8(text){
  if(typeof TextEncoder!=='undefined') return new TextEncoder().encode(String(text));
  const s=unescape(encodeURIComponent(String(text))), out=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++) out[i]=s.charCodeAt(i);
  return out;
}
function decodeUtf8(bytes){
  if(typeof TextDecoder!=='undefined') return new TextDecoder('utf-8').decode(bytes);
  let s=''; for(let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]);
  return decodeURIComponent(escape(s));
}

/* ---- ZIP 写入：默认 stored + CRC32；可选注入 compress 走 method=8；本地头 + 中央目录 + EOCD ---- */
const ZIP_SIG_LOC=0x04034b50, ZIP_SIG_CEN=0x02014b50, ZIP_SIG_EOCD=0x06054b50;
/* 可选压缩器：compress(bytes,name) 返回 Uint8Array（method=8）或 null（退化为 stored）。
 * 压缩器由调用方注入（Node 可传 zlib.deflateRawSync），模块本身保持零依赖。 */
function zipBuild(entries,opt){
  const compress=(opt&&typeof opt.compress==='function')?opt.compress:null;
  const locals=[], centrals=[]; let offset=0;
  entries.forEach(entry=>{
    const nameBytes=encodeUtf8(entry.name);
    const raw=entry.bytes||encodeUtf8(entry.text||'');
    const packed=compress?compress(raw,entry.name):null;
    const data=packed||raw;
    const method=packed?8:0;
    const crc=crc32(raw);
    const loc=new DataView(new ArrayBuffer(30));
    loc.setUint32(0,ZIP_SIG_LOC,true);
    loc.setUint16(4,20,true); loc.setUint16(6,0x0800,true); loc.setUint16(8,method,true);
    loc.setUint16(10,0,true); loc.setUint16(12,0x0021,true);
    loc.setUint32(14,crc,true); loc.setUint32(18,data.length,true); loc.setUint32(22,raw.length,true);
    loc.setUint16(26,nameBytes.length,true); loc.setUint16(28,0,true);
    locals.push([new Uint8Array(loc.buffer),nameBytes,data]);
    const cen=new DataView(new ArrayBuffer(46));
    cen.setUint32(0,ZIP_SIG_CEN,true);
    cen.setUint16(4,20,true); cen.setUint16(6,20,true); cen.setUint16(8,0x0800,true); cen.setUint16(10,method,true);
    cen.setUint16(12,0,true); cen.setUint16(14,0x0021,true);
    cen.setUint32(16,crc,true); cen.setUint32(20,data.length,true); cen.setUint32(24,raw.length,true);
    cen.setUint16(28,nameBytes.length,true); cen.setUint16(30,0,true); cen.setUint16(32,0,true);
    cen.setUint16(34,0,true); cen.setUint16(36,0,true); cen.setUint32(38,0,true);
    cen.setUint32(42,offset,true);
    centrals.push([new Uint8Array(cen.buffer),nameBytes]);
    offset+=30+nameBytes.length+data.length;
  });
  let centralSize=0; centrals.forEach(([h,n])=>{ centralSize+=46+n.length; });
  const eocd=new DataView(new ArrayBuffer(22));
  eocd.setUint32(0,ZIP_SIG_EOCD,true);
  eocd.setUint16(8,entries.length,true); eocd.setUint16(10,entries.length,true);
  eocd.setUint32(12,centralSize,true); eocd.setUint32(16,offset,true); eocd.setUint16(20,0,true);
  const out=new Uint8Array(offset+centralSize+22); let p=0;
  const put=ch=>{ out.set(ch,p); p+=ch.length; };
  locals.forEach(([h,n,d])=>{ put(h); put(n); put(d); });
  centrals.forEach(([h,n])=>{ put(h); put(n); });
  put(new Uint8Array(eocd.buffer));
  return out.buffer;
}

/* ---- ZIP 读取：stored 直读；method=8 走浏览器原生 DecompressionStream ---- */
/* 输入上限：防止畸形/超大压缩包与解压炸弹耗尽内存（可在测试中传入更小的 opt） */
const ZIP_LIMITS={maxBytes:50*1024*1024,maxEntries:2000,maxEntryBytes:64*1024*1024,maxTotalBytes:128*1024*1024};
/* verifyCrc=true 时逐条校验中央目录里的 CRC32（默认关闭，保持既有读取行为） */
async function zipInflateRaw(bytes){
  if(typeof DecompressionStream==='undefined') throw new Error('当前浏览器不支持 DecompressionStream，无法读取压缩的 xlsx');
  const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function zipReadEntries(arrayBuffer,opt){
  const L=Object.assign({},ZIP_LIMITS,opt||{});
  /* 允许传入 Uint8Array 或 ArrayBuffer（调用方习惯不一），统一按字节视图处理 */
  const bytes=arrayBuffer instanceof Uint8Array?arrayBuffer:new Uint8Array(arrayBuffer);
  const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), len=bytes.length;
  if(len>L.maxBytes) throw new Error('压缩包过大（超过 '+(L.maxBytes/1048576)+'MB 上限），请拆分后导入');
  let eocd=-1;
  for(let i=len-22;i>=Math.max(0,len-0xffff-22);i--){ if(dv.getUint32(i,true)===ZIP_SIG_EOCD){ eocd=i; break; } }
  if(eocd<0) throw new Error('不是有效的 XLSX 文件（ZIP 结构缺失或已截断）');
  const total=dv.getUint16(eocd+10,true); let offset=dv.getUint32(eocd+16,true);
  if(total===0xFFFF) throw new Error('暂不支持 ZIP64 格式，请用 Excel/WPS 另存为普通 xlsx');
  if(total>L.maxEntries) throw new Error('压缩包条目数超过上限 '+L.maxEntries+'（疑似异常文件）');
  const entries={};
  let totalUncomp=0;
  try{
    for(let i=0;i<total;i++){
      if(dv.getUint32(offset,true)!==ZIP_SIG_CEN) break;
      const method=dv.getUint16(offset+10,true);
      const crcExpected=dv.getUint32(offset+16,true);
      const compSize=dv.getUint32(offset+20,true);
      const uncompSize=dv.getUint32(offset+24,true);
      const nameLen=dv.getUint16(offset+28,true), extraLen=dv.getUint16(offset+30,true), commentLen=dv.getUint16(offset+32,true);
      const localOffset=dv.getUint32(offset+42,true);
      const name=decodeUtf8(bytes.subarray(offset+46,offset+46+nameLen));
      if(uncompSize>L.maxEntryBytes)
        throw new Error('压缩包内单文件解压后超过 '+(L.maxEntryBytes/1048576)+'MB 上限：'+name);
      const lNameLen=dv.getUint16(localOffset+26,true), lExtraLen=dv.getUint16(localOffset+28,true);
      const dataStart=localOffset+30+lNameLen+lExtraLen;
      const raw=bytes.subarray(dataStart,dataStart+compSize);
      if(!/\/$/.test(name)){
        let data;
        if(method===0) data=raw.slice();
        else if(method===8) data=await zipInflateRaw(raw);
        else throw new Error('不支持的 ZIP 压缩方式 method='+method);
        /* 以实际解压字节复核上限，避免中央目录声明值偏小绕过防护 */
        if(data.length>L.maxEntryBytes)
          throw new Error('压缩包内单文件解压后超过 '+(L.maxEntryBytes/1048576)+'MB 上限：'+name);
        totalUncomp+=data.length;
        if(totalUncomp>L.maxTotalBytes)
          throw new Error('压缩包解压总量超过 '+(L.maxTotalBytes/1048576)+'MB 上限，疑似解压炸弹');
        if(L.verifyCrc && crc32(data)!==crcExpected)
          throw new Error('ZIP 条目 CRC 校验失败：'+name);
        entries[name]=data;
      }
      offset+=46+nameLen+extraLen+commentLen;
    }
  }catch(e){
    /* 越界读取的错误可能来自宿主/沙箱不同 realm 的 RangeError，按名称与消息判定 */
    if(e&&(e.name==='RangeError'||/outside the bounds|out of bounds|out of range/i.test(e.message||'')))
      throw new Error('ZIP 结构损坏或截断，无法读取');
    throw e;
  }
  return entries;
}
/* 按条目名读取并解码为文本；不存在时返回 null */
function zipReadText(entries,name){
  const e=entries&&entries[name];
  return e?decodeUtf8(e):null;
}
  global.Zip = { crc32, encodeUtf8, decodeUtf8, build: zipBuild, readEntries: zipReadEntries, readText: zipReadText, inflateRaw: zipInflateRaw, LIMITS: ZIP_LIMITS };
})(typeof window !== 'undefined' ? window : globalThis);
