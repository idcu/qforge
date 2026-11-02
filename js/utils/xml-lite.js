/**
 * XML 解析适配层（实现已抽到公共模块 @idcu/format-xml-lite）
 * 保留 QB.XmlLite 导出面（parse / decodeEntities，元素含 getAttributeNS）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  QB.XmlLite = global.XmlLite;
})(typeof window !== 'undefined' ? window : globalThis);
