import { parseW3E } from './w3e.js';
import { readFileSync } from 'fs';
const data = new Uint8Array(readFileSync('/tmp/m2/war3map.w3e'));
const t = parseW3E(data);
console.log('magic OK | version:', t.version, '| tileset:', t.tileset);
console.log('size:', t.width + 'x' + t.height, '| 格子:', t.width * t.height);
console.log('groundTiles:', t.groundTiles.length, '种:', t.groundTiles.join(','));
console.log('cliffTiles:', t.cliffTiles.length, '种:', t.cliffTiles.join(','));
console.log('offset:', t.offX, t.offY, '| tileSize:', t.tileSize);
// 高度统计
let min = Infinity, max = -Infinity, sum = 0;
for (let i = 0; i < t.heights.length; i++) { const h = t.heights[i]; if (h < min) min = h; if (h > max) max = h; sum += h; }
console.log('height: min=' + min + ' max=' + max + ' avg=' + (sum / t.heights.length).toFixed(1));
// 消耗字节检查
console.log('consumed:', t.consumed, '/', t.total, 'bytes', t.consumed === t.total ? '✅ 完整解析' : '⚠️ 有剩余');
// ASCII 地形缩略图（高度低→高: .-~#）
const w = t.width, h = t.height;
console.log('--- ASCII 地形图 (' + w + 'x' + h + ') ---');
for (let y = 0; y < h; y += Math.ceil(h / 30)) {
  let row = '';
  for (let x = 0; x < w; x += Math.ceil(w / 60)) {
    const v = t.heights[y * w + x];
    const n = (v - min) / (max - min);
    row += n < 0.2 ? '.' : n < 0.4 ? '-' : n < 0.6 ? '~' : n < 0.8 ? '#' : '@';
  }
  console.log(row);
}
