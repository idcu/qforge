/* @idcu/format-dsv —— CommonJS 入口 */
require('./vendor/dsv.js');

const DSV = globalThis.DSV;
if (!DSV) throw new Error('@idcu/format-dsv: vendor/dsv.js 未正确加载');

module.exports = DSV;
module.exports.default = DSV;
