/**
 * Node 侧最小 DOM 垫片（仅测试使用，不随应用发布）
 *
 * 目的：app.js 是「状态 + 流程 + 事件委托」层，此前没有任何 Node 运行时覆盖。
 * 本垫片只实现 app.js 实际用到的 DOM 子集（元素注册表、事件注册/派发、classList、
 * 属性、style.setProperty、closest/querySelector 的最小匹配），让 boot 与事件委托
 * 能在 Node 中跑起来；**不追求**浏览器 DOM 完整语义。
 *
 * 显式不实现：真实布局（offsetHeight/scrollHeight 固定 0）、选择器引擎
 * （querySelector 仅支持 `#id`，其余返回 null）、HTML 解析（innerHTML 只是字符串）。
 * 因此任何依赖真实渲染/布局的断言都不能在这里做——这类结论必须实机验证。
 */
function matchSimple(el, selector) {
  if (!selector) return false;
  return selector.split(',').some((raw) => {
    const s = raw.trim();
    if (!s) return false;
    const attrRe = /\[([a-z-]+)(?:="([^"]*)")?\]/g;
    let m;
    while ((m = attrRe.exec(s))) {
      if (!el.hasAttribute(m[1])) return false;
      if (m[2] !== undefined && el.getAttribute(m[1]) !== m[2]) return false;
    }
    const cls = s.match(/\.([a-z-]+)/i);
    if (cls && !el.classList.contains(cls[1])) return false;
    return s.startsWith('[') || s.startsWith('.') || /^[a-z-]+$/i.test(s);
  });
}

/**
 * @param {{nullIds?: string[]}} [opts]
 *   nullIds：这些 id 的 getElementById 恒返回 null（用于让 UI.toast 等路径静默，
 *   避免测试里创建无意义的节点与定时器）。
 * @returns {{window:Object, document:Object, location:Object, navigator:Object,
 *   history:Object, elements:Map, fire:(target,type,event)=>any[], idleTasks:Function[]}}
 */
export function createDom(opts) {
  const o = opts || {};
  const nullIds = new Set(o.nullIds || []);
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const idleTasks = [];

  function createElement(tagName) {
    const attrs = Object.create(null);
    const listeners = new Map();
    const classes = new Set();
    let html = '';
    const styleObj = {};
    const el = {
      tagName: String(tagName || 'div').toUpperCase(),
      id: '',
      value: '',
      disabled: false,
      hidden: false,
      checked: false,
      offsetHeight: 0,
      scrollHeight: 0,
      children: [],
      parentNode: null,
      dataset: {},
      style: {
        setProperty(k, v) { styleObj[k] = v; },
        getPropertyValue(k) { return styleObj[k] || ''; }
      },
      classList: {
        add(c) { classes.add(c); el.className = Array.from(classes).join(' '); },
        remove(c) { classes.delete(c); el.className = Array.from(classes).join(' '); },
        contains(c) { return classes.has(c); },
        toggle(c, force) {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) classes.add(c); else classes.delete(c);
          el.className = Array.from(classes).join(' ');
          return on;
        }
      },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
      setAttribute(k, v) {
        attrs[k] = String(v);
        if (k === 'id') el.id = String(v);
      },
      removeAttribute(k) { delete attrs[k]; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
        if (type === 'click') el.onclick = fn;
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type);
        if (list) {
          const i = list.indexOf(fn);
          if (i >= 0) list.splice(i, 1);
        }
      },
      appendChild(child) {
        child.parentNode = el;
        el.children.push(child);
        return child;
      },
      removeChild(child) {
        const i = el.children.indexOf(child);
        if (i >= 0) el.children.splice(i, 1);
        child.parentNode = null;
        return child;
      },
      replaceChild(next, old) {
        const i = el.children.indexOf(old);
        if (i >= 0) el.children[i] = next;
        next.parentNode = el;
        old.parentNode = null;
        return old;
      },
      contains(target) { return !!target; },
      closest(selector) { return matchSimple(el, selector) ? el : null; },
      matches(selector) { return matchSimple(el, selector); },
      querySelector(selector) {
        if (selector && selector.startsWith('#')) {
          return el.children.find((c) => c.id === selector.slice(1)) || null;
        }
        return null;
      },
      querySelectorAll() { return []; },
      focus() { document.activeElement = el; },
      setSelectionRange() { /* Node 垫片无选区 */ },
      click() { return el.fire('click', { target: el }); },
      fire(type, event) {
        const ev = Object.assign({ type: type, target: el, preventDefault() {}, stopPropagation() {} }, event || {});
        const out = [];
        (listeners.get(type) || []).forEach((fn) => { out.push(fn(ev)); });
        return out;
      }
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return html; },
      set(v) { html = String(v); el.children.length = 0; }
    });
    Object.defineProperty(el, 'textContent', {
      get() { return el.__text || ''; },
      set(v) { el.__text = String(v); }
    });
    return el;
  }

  const byId = (id) => {
    if (!elements.has(id)) {
      const el = createElement('div');
      el.id = id;
      elements.set(id, el);
    }
    return elements.get(id);
  };

  const documentElement = createElement('html');
  const body = createElement('body');
  const document = {
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    documentElement: documentElement,
    body: body,
    activeElement: body,
    getElementById(id) {
      if (nullIds.has(id)) return null;
      return byId(id);
    },
    querySelector(selector) {
      if (selector && selector.startsWith('#')) return byId(selector.slice(1));
      return null;
    },
    querySelectorAll() { return []; },
    createElement(tagName) { return createElement(tagName); },
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = documentListeners.get(type);
      if (list) {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      }
    },
    fire(type, event) {
      const ev = Object.assign({
        type: type, target: body, preventDefault() {}, stopPropagation() {}
      }, event || {});
      const out = [];
      (documentListeners.get(type) || []).forEach((fn) => { out.push(fn(ev)); });
      return out;
    }
  };
  document.documentElement = documentElement;
  document.body = body;

  const location = { protocol: 'http:', pathname: '/', search: '', hash: '' };
  const history = {
    replaced: [],
    replaceState(state, title, url) { history.replaced.push([state, title, url]); }
  };
  const navigator = {
    serviceWorker: {
      controller: null,
      registrations: [],
      register(script, options) {
        navigator.serviceWorker.registrations.push({ script: script, options: options });
        return Promise.resolve({
          installing: null,
          waiting: null,
          addEventListener() {},
          scope: (options && options.scope) || ''
        });
      }
    }
  };

  const window = {
    location: location,
    navigator: navigator,
    history: history,
    scrollY: 0,
    innerHeight: 800,
    innerWidth: 1200,
    scrollTo() {},
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = windowListeners.get(type);
      if (list) {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      }
    },
    fire(type, event) {
      const ev = Object.assign({ type: type, preventDefault() {}, stopPropagation() {} }, event || {});
      const out = [];
      (windowListeners.get(type) || []).forEach((fn) => { out.push(fn(ev)); });
      return out;
    }
  };

  const requestIdleCallback = (fn) => {
    idleTasks.push(fn);
    return idleTasks.length;
  };

  return { window, document, location, navigator, history, elements, idleTasks, requestIdleCallback };
}
