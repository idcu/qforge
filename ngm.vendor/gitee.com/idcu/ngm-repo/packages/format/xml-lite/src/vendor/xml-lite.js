/* xml-lite.js —— 极简 XML 解析器（OOXML 子集，零依赖；借鉴 qforge/js/utils/xml-lite.js） */
(function (global) {
  const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
  function decodeEntities(s){
    if(s.indexOf('&')<0) return s;
    return s.replace(/&#(x?[0-9a-fA-F]+);?|&([a-zA-Z]+);?/g,(m,code,name)=>{
      try{
        if(name) return Object.prototype.hasOwnProperty.call(ENTITIES,name)?ENTITIES[name]:m;
        const n=code&&code[0]==='x'?parseInt(code.slice(1),16):parseInt(code,10);
        if(!isFinite(n)||n<0) return m;
        return String.fromCodePoint(n);
      }catch(e){ return m; }
    });
  }
  function parseAttrs(str,parentNs){
    const attrs=[], ns=Object.assign({},parentNs||{});
    const re=/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g; let m;
    while((m=re.exec(str))){
      const rawName=m[1];
      const value=decodeEntities(m[2]!=null?m[2]:(m[3]!=null?m[3]:''));
      if(rawName==='xmlns'){ ns['']=value; continue; }
      if(rawName.indexOf('xmlns:')===0){ ns[rawName.slice(6)]=value; continue; }
      const colon=rawName.indexOf(':'), prefix=colon>0?rawName.slice(0,colon):'', local=colon>0?rawName.slice(colon+1):rawName;
      attrs.push({name:rawName,prefix,local,ns:prefix?(ns[prefix]||''):'',value});
    }
    return {attrs,ns};
  }
  function makeElement(tagName,parsed){
    const el={tagName,nodeName:tagName,nodeType:1,children:[],_attrs:parsed.attrs,_ns:parsed.ns};
    el.getAttribute=function(name){ const a=this._attrs.find(x=>x.name===name); return a?a.value:null; };
    /* 按命名空间 URI + 本地名取属性（docx 的 r:embed 等前缀属性需要） */
    el.getAttributeNS=function(uri,local){ const a=this._attrs.find(x=>x.ns===String(uri||'')&&x.local===local); return a?a.value:null; };
    el.getElementsByTagName=function(q){
      const out=[]; const walk=node=>{ for(const ch of node.children){ if(typeof ch!=='string'){ if(ch.tagName===q) out.push(ch); walk(ch); } } };
      walk(this); return out;
    };
    Object.defineProperty(el,'textContent',{get(){ let s=''; const walk=n=>{ for(const ch of n.children){ if(typeof ch==='string') s+=ch; else walk(ch); } }; walk(this); return s; }});
    return el;
  }
  function skipDeclaration(xml,i){
    let depth=0;
    for(let j=i+1;j<xml.length;j++){
      const ch=xml[j]; if(ch==='[') depth++; else if(ch===']') depth--; else if(ch==='>'&&depth<=0) return j;
    }
    throw new Error('XML 解析失败：声明标签缺少结束符');
  }
  function findTagEnd(xml,i){
    let quote='';
    for(let j=i;j<xml.length;j++){
      const ch=xml[j];
      if(quote){ if(ch===quote) quote=''; } else if(ch==='"'||ch==="'") quote=ch; else if(ch==='>') return j;
    }
    throw new Error('XML 解析失败：标签缺少结束符 >');
  }
  function parse(xmlText){
    const xml=String(xmlText||'');
    const doc={nodeType:9,children:[],_ns:{}};
    doc.getElementsByTagName=function(q){ const out=[]; const walk=n=>{ for(const ch of n.children){ if(typeof ch!=='string'){ if(ch.tagName===q) out.push(ch); walk(ch); } } }; walk(this); return out; };
    const stack=[{node:doc,tagName:null}]; const top=()=>stack[stack.length-1].node;
    let i=0, rootSeen=false;
    const appendText=s=>{ if(s) top().children.push(decodeEntities(s)); };
    while(i<xml.length){
      const lt=xml.indexOf('<',i);
      if(lt<0){ appendText(xml.slice(i)); break; }
      if(lt>i) appendText(xml.slice(i,lt));
      if(xml.substr(lt,4)==='<!--'){ const end=xml.indexOf('-->',lt+4); if(end<0) throw new Error('XML 注释缺少 -->'); i=end+3; continue; }
      if(xml.substr(lt,9)==='<![CDATA['){ const end=xml.indexOf(']]>',lt+9); if(end<0) throw new Error('XML CDATA 缺少 ]]>'); top().children.push(xml.slice(lt+9,end)); i=end+3; continue; }
      const c=xml[lt+1];
      if(c==='?'){ const end=xml.indexOf('?>',lt+2); if(end<0) throw new Error('XML 处理指令缺少 ?>'); i=end+2; continue; }
      if(c==='!'){ i=skipDeclaration(xml,lt)+1; continue; }
      if(c==='/'){
        const end=findTagEnd(xml,lt+2), name=xml.slice(lt+2,end).trim(), opened=stack[stack.length-1];
        if(stack.length<=1||opened.tagName!==name) throw new Error('XML 结束标签 </'+name+'> 不匹配');
        stack.pop(); i=end+1; continue;
      }
      const end=findTagEnd(xml,lt+1);
      let body=xml.slice(lt+1,end);
      const selfClosing=body.charCodeAt(body.length-1)===0x2f;
      if(selfClosing) body=body.slice(0,-1);
      const sp=body.search(/\s/);
      const tagName=sp<0?body.trim():body.slice(0,sp);
      if(!/^[A-Za-z_][\w.\-]*(:[A-Za-z_][\w.\-]*)?$/.test(tagName)) throw new Error('XML 非法标签名「'+tagName.slice(0,20)+'」');
      const parent=top();
      const el=makeElement(tagName,parseAttrs(sp<0?'':body.slice(sp+1),parent._ns||{}));
      parent.children.push(el);
      if(parent===doc) rootSeen=true;
      if(!selfClosing) stack.push({node:el,tagName});
      i=end+1;
    }
    if(stack.length>1) throw new Error('XML 存在未闭合标签 <'+stack[stack.length-1].tagName+'>');
    if(!rootSeen) throw new Error('XML 未找到根元素');
    return doc;
  }
  global.XmlLite = { parse: parse, decodeEntities: decodeEntities };
})(typeof window !== "undefined" ? window : globalThis);
