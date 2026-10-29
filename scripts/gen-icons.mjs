/**
 * PWA 图标生成器（零依赖，纯 zlib 手写 PNG）
 * 输出 icons/icon-192.png、icons/icon-512.png：
 * 绿色圆角方块（#0fae6a，与 theme_color 一致）+ 白色 Q 环与尾笔。
 * 说明：Chrome 安装条件对 192/512 位图更稳妥；SVG 仍保留给支持矢量图标的平台。
 * 运行：node scripts/gen-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'icons');
const SS = 3; // 超采样倍数（抗锯齿）

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1; const dy = y2 - y1;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx; const qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/** 单点覆盖判定（归一化坐标 0..1） */
function inside(x, y) {
  // 圆角方块（圆角半径 18%）
  const r = 0.18;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  const corner = Math.hypot(x - cx, y - cy) <= r;
  const inRect = x >= 0 && x <= 1 && y >= 0 && y <= 1;
  const inBg = inRect && (x < r || x > 1 - r || y < r || y > 1 - r ? corner : true);
  if (!inBg) return false;
  // Q 环（中心略偏上）
  const qx = 0.5; const qy = 0.46;
  const d = Math.hypot(x - qx, y - qy);
  if (Math.abs(d - 0.285) <= 0.055) return 'fg';
  // 尾笔
  if (distSeg(x, y, 0.60, 0.56, 0.74, 0.70) <= 0.042) return 'fg';
  return true;
}

function render(size) {
  const W = size * SS;
  const out = Buffer.alloc(size * size * 4);
  const BG = [15, 174, 106];
  const FG = [255, 255, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCount = 0; let fgCount = 0; let samples = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x * SS + sx + 0.5) / W;
          const ny = (y * SS + sy + 0.5) / W;
          const v = inside(nx, ny);
          samples++;
          if (v === 'fg') fgCount++;
          else if (v === true) bgCount++;
        }
      }
      const i = (y * size + x) * 4;
      const a = (bgCount + fgCount) / samples;
      if (!a) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; continue; }
      const fgRatio = fgCount / (bgCount + fgCount || 1);
      out[i] = Math.round(BG[0] * (1 - fgRatio) + FG[0] * fgRatio);
      out[i + 1] = Math.round(BG[1] * (1 - fgRatio) + FG[1] * fgRatio);
      out[i + 2] = Math.round(BG[2] * (1 - fgRatio) + FG[2] * fgRatio);
      out[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, out);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
[192, 512].forEach((size) => {
  const file = path.join(OUT_DIR, 'icon-' + size + '.png');
  fs.writeFileSync(file, render(size));
  console.log('已生成 ' + file + '（' + Math.round(fs.statSync(file).size / 1024) + ' KB）');
});
