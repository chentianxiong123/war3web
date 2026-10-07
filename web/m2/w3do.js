// w3do.js — 解析 war3map.doo (装饰物) / war3mapUnits.doo (单位摆放) / W3do 格式
export function parseW3DO(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const magic = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (magic !== 'W3do') throw new Error('bad magic: ' + magic);
  let o = 4;
  const version = dv.getInt32(o, true); o += 4;
  const sub = dv.getInt32(o, true); o += 4;
  const n = dv.getInt32(o, true); o += 4;
  const items = [];
  for (let i = 0; i < n; i++) {
    const tid = String.fromCharCode(b[o], b[o+1], b[o+2], b[o+3]); o += 4;
    const variation = dv.getFloat32(o, true); o += 4;
    const x = dv.getFloat32(o, true); o += 4;
    const y = dv.getFloat32(o, true); o += 4;
    const z = dv.getFloat32(o, true); o += 4;
    const rot = dv.getFloat32(o, true); o += 4;
    const sx = dv.getFloat32(o, true); o += 4;
    const sy = dv.getFloat32(o, true); o += 4;
    const sz = dv.getFloat32(o, true); o += 4;
    const flags = b[o++]; const life = b[o++];
    if (sub >= 11) {
      o += 4;                       // item table pointer
      const nsets = dv.getInt32(o, true); o += 4;
      for (let s = 0; s < nsets; s++) {
        const ni = dv.getInt32(o, true); o += 4;
        o += ni * 8;
      }
    }
    const eid = dv.getInt32(o, true); o += 4;
    items.push({ id: tid, variation, x, y, z, rot, sx, sy, sz, flags, life, eid });
  }
  // special doodads (可选, 部分文件有)
  let special = [];
  if (o + 8 <= b.length) {
    const sver = dv.getInt32(o, true); const ns = dv.getInt32(o + 4, true);
    if (sver === 1 || sver === 0) {
      o += 8;
      for (let i = 0; i < ns; i++) {
        const sid = String.fromCharCode(b[o], b[o+1], b[o+2], b[o+3]); o += 4;
        const zz = dv.getInt32(o, true); o += 4;
        const xx = dv.getInt32(o, true); o += 4;
        const yy = dv.getInt32(o, true); o += 4;
        special.push({ id: sid, z: zz, x: xx, y: yy });
      }
    }
  }
  return { version, sub, items, special, consumed: o, total: b.length };
}
