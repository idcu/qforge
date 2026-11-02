/* @idcu/format-dsv —— ESM 入口 */
import './vendor/dsv.js';

const DSV = globalThis.DSV;
if (!DSV) throw new Error('@idcu/format-dsv: vendor/dsv.js 未正确加载');

export const { parseRows, detectDelimiter, quoteCell, formatRows } = DSV;
export default DSV;
