/* @idcu/core-assets —— ESM 入口（读取 UMD 挂到 globalThis 的实现） */
import './core.js';

const A = globalThis.__idcuAssets;
if (!A) throw new Error('@idcu/core-assets: core.js 未正确加载');

export const { toBytes, idFor, memoryDriver, idbDriver, createAssets } = A;
export default A;
