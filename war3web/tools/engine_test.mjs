// 引擎模块 Node 端验证（engine/out/engine.mjs，先跑 npm run engine）。
// 覆盖：vec3 数学（len/dot/cross）+ W3X/W3M 地图头解析 + 边界情况。
import createEngine from '../engine/out/engine.mjs';

const m = await createEngine();
let passed = 0, failed = 0;
const ck = (name, got, want) => {
  const ok = Math.abs(got - want) < 1e-6;
  if (ok) passed++; else failed++;
  console.log(`${ok ? '  ok   ' : '  FAIL '}${name} = ${got}${ok ? '' : ' (want ' + want + ')'}`);
};

// --- vec3 ---
ck('len(3,4,0)=5', m._vec3_lenf(3, 4, 0), 5);
ck('dot(1,0,0,0,1,0)=0', m._vec3_dotf(1, 0, 0, 0, 1, 0), 0);
ck('dot(1,0,0,1,0,0)=1', m._vec3_dotf(1, 0, 0, 1, 0, 0), 1);
const crossOut = m._malloc(3 * 4);
m._vec3_crossf(1, 0, 0, 0, 1, 0, crossOut);
const [cx, cy, cz] = new Float32Array(m.HEAPU8.buffer, crossOut, 3);
ck('cross.x=0', cx, 0);
ck('cross.y=0', cy, 0);
ck('cross.z=1', cz, 1);
m._free(crossOut);

// --- W3X 地图头 ---
const buf = m._malloc(12);
m.HEAPU8.set(new Uint8Array([0x57, 0x33, 0x58, 0x21, 30, 0, 0, 0, 0, 0, 0, 0]), buf); // "W3X!" ver=30
ck('w3x_check_header(W3X!)=1', m._w3x_check_header(buf, 12), 1);
ck('w3x_get_version=30', m._w3x_get_version(buf, 12), 30);
ck('w3x_check_header(短buf)=0', m._w3x_check_header(buf, 3), 0);
const bad = m._malloc(8);
m.HEAPU8.set([0x41, 0x42, 0x43, 0x44, 1, 0, 0, 0], bad); // "ABCD"
ck('w3x_check_header(ABCD)=0', m._w3x_check_header(bad, 8), 0);
m._free(buf);
m._free(bad);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
