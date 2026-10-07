// w3units.js — 解析 war3mapUnits.doo（单位摆放）按 WC3MapSpecification Units/8_11
export function parseW3UNITS(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  if (String.fromCharCode(b[0],b[1],b[2],b[3]) !== 'W3do') throw new Error('bad magic');
  let o = 4;
  const version = dv.getInt32(o, true); o += 4;
  const sub = dv.getInt32(o, true); o += 4;
  const n = dv.getInt32(o, true); o += 4;
  const units = [];
  for (let i = 0; i < n; i++) {
    const id = String.fromCharCode(b[o],b[o+1],b[o+2],b[o+3]); o += 4;
    const variation = dv.getInt32(o, true); o += 4;
    const x = dv.getFloat32(o, true); o += 4;
    const y = dv.getFloat32(o, true); o += 4;
    const z = dv.getFloat32(o, true); o += 4;
    const rot = dv.getFloat32(o, true); o += 4;
    const sx = dv.getFloat32(o, true); o += 4;
    const sy = dv.getFloat32(o, true); o += 4;
    const sz = dv.getFloat32(o, true); o += 4;
    const flags = b[o++];
    o += 3;                          // unknown(3)
    const player = b[o++];           // owning player = 1 字节
    o += 2;                          // unknown(1) + unknown(1)
    const hp = dv.getInt32(o, true); o += 4;
    const mana = dv.getInt32(o, true); o += 4;
    o += 4;                          // dropped item set pointer
    let dropSets = 0;
    const nsets = dv.getInt32(o, true); o += 4;
    for (let s = 0; s < nsets; s++) {
      const cnt = dv.getInt32(o, true); o += 4;
      o += cnt * 8;                  // (id 4 + chance 4) * cnt
      dropSets += cnt;
    }
    const gold = dv.getInt32(o, true); o += 4;
    o += 4;                          // target acquisition float
    const heroLevel = dv.getInt32(o, true); o += 4;
    const str = dv.getInt32(o, true); o += 4;
    const agi = dv.getInt32(o, true); o += 4;
    const intel = dv.getInt32(o, true); o += 4;
    const invCount = dv.getInt32(o, true); o += 4;
    for (let k = 0; k < invCount; k++) { o += 8; }      // slot 4 + id 4
    const abilCount = dv.getInt32(o, true); o += 4;
    for (let k = 0; k < abilCount; k++) { o += 12; }    // id 4 + autocast 4 + level 4
    const randFlag = dv.getInt32(o, true); o += 4;
    if (randFlag === 0)      o += 4;                    // CASE 0: 4 bytes
    else if (randFlag === 1) o += 8;                    // CASE 1: 8 bytes
    else if (randFlag === 2) { const c = dv.getInt32(o, true); o += 4; o += c * 8; }
    const unitColor = dv.getInt32(o, true); o += 4;
    o += 4;                          // waygate
    const finalId = dv.getInt32(o, true); o += 4;
    units.push({ id, variation, x, y, z, rot, sx, sy, sz, flags, player,
                 hp, mana, gold, heroLevel, str, agi, intel, unitColor, finalId });
  }
  return { version, sub, units, consumed: o, total: b.length };
}
