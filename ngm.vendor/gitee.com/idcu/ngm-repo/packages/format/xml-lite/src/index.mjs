/* @idcu/format-xml-lite —— ESM 入口 */
import './vendor/xml-lite.js';

const XmlLite = globalThis.XmlLite;
if (!XmlLite) throw new Error('@idcu/format-xml-lite: vendor/xml-lite.js 未正确加载');

export const { parse, decodeEntities } = XmlLite;
export default XmlLite;
