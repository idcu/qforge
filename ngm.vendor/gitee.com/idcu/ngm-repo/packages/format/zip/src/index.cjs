/* @idcu/format-zip —— CommonJS 入口（与 index.mjs 同一份 vendor 实现） */
require('./vendor/zip.js');

const Zip = globalThis.Zip;
if (!Zip) throw new Error('@idcu/format-zip: vendor/zip.js 未正确加载');

module.exports = Zip;
module.exports.default = Zip;
