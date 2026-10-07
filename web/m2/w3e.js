// w3e.js — 解析 war3map.w3e 地形（移植自 foc-web tools/terrain.py）
// 输入: ArrayBuffer 或 Uint8Array
export function parseW3E(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const magic = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (magic !== 'W3E!') throw new Error('bad magic: ' + magic);

  let o = 4;
  const version = dv.getInt32(o, true); o += 4;
  const tileset = String.fromCharCode(b[o]); o += 1;
  const custom = dv.getInt32(o, true); o += 4;

  const ng = dv.getInt32(o, true); o += 4;
  const groundTiles = [];
  for (let i = 0; i < ng; i++) { groundTiles.push(String.fromCharCode(b[o], b[o+1], b[o+2], b[o+3])); o += 4; }
  const nc = dv.getInt32(o, true); o += 4;
  const cliffTiles = [];
  for (let i = 0; i < nc; i++) { cliffTiles.push(String.fromCharCode(b[o], b[o+1], b[o+2], b[o+3])); o += 4; }

  const width  = dv.getInt32(o, true); o += 4;
  const height = dv.getInt32(o, true); o += 4;
  const offX = dv.getFloat32(o, true); o += 4;
  const offY = dv.getFloat32(o, true); o += 4;

  const n = width * height;
  const heights = new Int16Array(n);
  const water   = new Uint16Array(n);
  const tex     = new Uint8Array(n);
  const flags   = new Uint8Array(n);
  const detail  = new Uint8Array(n);
  const cliffTex= new Uint8Array(n);
  const layer   = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const gh = dv.getInt16(o, true); o += 2;
    const wl = dv.getUint16(o, true); o += 2;
    const f_t = b[o++];
    const d = b[o++];
    const c_l = b[o++];
    heights[i] = gh;
    water[i] = wl & 0x3FFF;
    flags[i] = (f_t >> 4) & 0xF;
    tex[i] = f_t & 0xF;
    detail[i] = d;
    cliffTex[i] = (c_l >> 4) & 0xF;
    layer[i] = c_l & 0xF;
  }
  return { version, tileset, custom, groundTiles, cliffTiles,
           width, height, offX, offY, tileSize: 128,
           heights, water, tex, flags, detail, cliffTex, layer,
           consumed: o, total: b.length };
}
