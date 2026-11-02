/* @idcu/format-xml-lite —— CommonJS 入口 */
require('./vendor/xml-lite.js');

const XmlLite = globalThis.XmlLite;
if (!XmlLite) throw new Error('@idcu/format-xml-lite: vendor/xml-lite.js 未正确加载');

module.exports = XmlLite;
module.exports.default = XmlLite;
