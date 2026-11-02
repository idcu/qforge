/* @idcu/format-xlsx-read —— ESM 入口（读取 UMD 挂到 globalThis 的实现） */
import './core.js';

const X = globalThis.__idcuXlsx;
if (!X) throw new Error('@idcu/format-xlsx-read: core.js 未正确加载');

export const { createXlsxReader } = X;
export default createXlsxReader;
