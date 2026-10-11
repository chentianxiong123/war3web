// tools/build_test.mjs — M4 阶段 5：建筑建造进度系统 C 测试
// 三个场景：
//   1. 工人下建造命令，跑 N tick，验证 buildProgress 从 0 增到 100
//   2. 建造完成后，建筑单位存在且 hp 正确
//   3. 多个工人同时建造不同建筑
//
// 不跑 golden-first（建筑建造是 C 新功能，JS 侧行为不同）。
// 跑法：npm run engine && node tools/build_test.mjs
import createEngine from "../engine/out/engine.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- 初始化 wasm ----
const eng = await createEngine();
const W = 384, H = 384, OX = -6144, OY = -6144;
const walkArr = new Uint8Array(fs.readFileSync(path.join(HERE, "..", "public", "data", "walk.bin")));
const wp = eng._malloc(walkArr.length);
eng.HEAPU8.set(walkArr, wp);
eng._sim_grid_init(wp, W, H, OX, OY);

// damage table（简化：全 1）
const ATK_TYPES = ["spells", "normal", "pierce", "siege", "magic", "chaos", "hero"];
const ARMOR_KINDS = ["small", "medium", "large", "fort", "normal", "hero", "divine", "none"];
const dt = JSON.parse(fs.readFileSync(path.join(HERE, "..", "data", "gameplay.json"), "utf8")).damageBonus || {};
const tbl = eng._malloc(7 * 8 * 4);
for (let a = 0; a < 7; a++) for (let k = 0; k < 8; k++) eng.HEAPF32[(tbl >> 2) + a * 8 + k] = dt[ATK_TYPES[a]]?.[ARMOR_KINDS[k]] ?? 1;
eng._sim_set_dmg_table(tbl);
eng._free(tbl);

// ---- 类型表（与 wasm_bridge.js DEFAULT_TYPES 一致）----
const TYPES = {
  hpea: { kind: 1, isFight: false, moveSpeed: 190, radius: 16, hp: 160 },
  baam: { kind: 4, isFight: false, moveSpeed: 0, radius: 60, hp: 4500, armor: 3, isBuilding: true, buildTime: 60 },
  bhut: { kind: 4, isFight: false, moveSpeed: 0, radius: 60, hp: 1200, armor: 0, isBuilding: true, buildTime: 30 },
  twog: { kind: 4, isFight: false, moveSpeed: 0, radius: 50, hp: 700, armor: 2, isBuilding: true, buildTime: 55 },
  hbar: { kind: 4, isFight: false, moveSpeed: 0, radius: 80, hp: 1500, armor: 5, isBuilding: true, buildTime: 60 },
  hars: { kind: 4, isFight: false, moveSpeed: 0, radius: 80, hp: 1050, armor: 5, isBuilding: true, buildTime: 70 },
  harm: { kind: 4, isFight: false, moveSpeed: 0, radius: 80, hp: 1200, armor: 5, isBuilding: true, buildTime: 60 },
};

// 建筑类型索引表（与 C 侧 SIM_BUILDING_TYPES 顺序一致）
const BUILD_TYPES = ["baam", "bhut", "twog", "hbar", "hars", "harm"];

// 读 sim_get_build 输出
const buildBuf = eng._malloc(6 * 4);
function getBuild(id) {
  eng._sim_get_build(id, buildBuf);
  const b = buildBuf >> 2;
  return {
    progress: eng.HEAPF32[b],
    time: eng.HEAPF32[b + 1],
    active: eng.HEAPF32[b + 2],
    targetType: Math.round(eng.HEAPF32[b + 3]),
    targetId: Math.round(eng.HEAPF32[b + 4]),
    completedId: Math.round(eng.HEAPF32[b + 5]),
  };
}

// 读 sim_snapshot 快照（找建筑单位）
const snapBuf = eng._malloc(65536 * 4);
function snapshot() {
  const need = eng._sim_snapshot(snapBuf, 65536);
  const F = (i) => eng.HEAPF32[(snapBuf >> 2) + i];
  const nU = Math.round(F(2));
  const COLS = 15;
  const C = (col, i) => F(5 + col * nU + i);
  const units = [];
  for (let i = 0; i < nU; i++) {
    units.push({
      id: Math.round(C(11, i)),
      x: C(0, i), y: C(1, i),
      hp: Math.round(C(3, i)), maxHp: Math.round(C(4, i)),
      alive: C(5, i), team: Math.round(C(6, i)),
      kind: Math.round(C(8, i)),
    });
  }
  return units;
}

// spawn 农民
function spawnPeasant(id, x, y, team = 0) {
  eng._sim_spawn_econ(id, x, y, 1, team, team, 190, 16, 0, 160);
}

let allOk = true;
const results = [];

// ============== 场景 1：建造进度推进 ==============
// 工人下建造命令，跑 N tick，验证 buildProgress 从 0 增到 100
function testScenario1() {
  eng._sim_clear_all();
  spawnPeasant(0, 0, 0);
  
  // 下建造命令：baam（typeIdx=0, buildTime=60s）
  const ret = eng._sim_order_build(0, 0, 100, 100);
  if (ret !== 1) {
    results.push("场景 1: FAIL sim_order_build 返回 " + ret);
    return false;
  }
  
  // 验证初始状态
  const b0 = getBuild(0);
  if (b0.progress !== 0 || b0.active !== 1 || b0.targetType !== 0 || Math.abs(b0.time - 60) > 0.01) {
    results.push(`场景 1: FAIL 初始状态 progress=${b0.progress} active=${b0.active} type=${b0.targetType} time=${b0.time}`);
    return false;
  }
  
  // 跑 30 FPS，每 tick dt = 1/30 秒
  // 60 秒 = 1800 tick，跑 2000 tick 确保完成
  const dt = 1 / 30;
  const ticks = 2000;
  for (let t = 0; t < ticks; t++) {
    eng._sim_step(dt);
  }
  
  // 验证完成
  const b1 = getBuild(0);
  if (b1.active !== 0) {
    results.push(`场景 1: FAIL 完成但 active=${b1.active}`);
    return false;
  }
  if (b1.completedId < 0) {
    results.push(`场景 1: FAIL completedId=${b1.completedId}`);
    return false;
  }
  
  // 验证建筑单位存在且 hp 正确
  const units = snapshot();
  const building = units.find(u => u.id === b1.completedId);
  if (!building) {
    results.push(`场景 1: FAIL 建筑单位 ${b1.completedId} 不在快照中`);
    return false;
  }
  if (building.hp !== 4500) {
    results.push(`场景 1: FAIL 建筑 hp=${building.hp} 期望 4500`);
    return false;
  }
  if (building.kind !== 4) {
    results.push(`场景 1: FAIL 建筑 kind=${building.kind} 期望 4`);
    return false;
  }
  if (!building.alive) {
    results.push(`场景 1: FAIL 建筑不存活`);
    return false;
  }
  
  results.push("场景 1: OK 建造进度推进 + 完成产出");
  return true;
}

// ============== 场景 2：不同建筑类型建造 ==============
// 验证多种建筑类型的 buildTime 和 hp
function testScenario2() {
  eng._sim_clear_all();
  
  const cases = [
    { typeIdx: 0, key: "baam", buildTime: 60, hp: 4500 },
    { typeIdx: 1, key: "bhut", buildTime: 30, hp: 1200 },
    { typeIdx: 2, key: "twog", buildTime: 55, hp: 700 },
    { typeIdx: 3, key: "hbar", buildTime: 60, hp: 1500 },
    { typeIdx: 4, key: "hars", buildTime: 70, hp: 1050 },
    { typeIdx: 5, key: "harm", buildTime: 60, hp: 1200 },
  ];
  
  for (const c of cases) {
    eng._sim_clear_all();
    spawnPeasant(0, 0, 0);
    eng._sim_order_build(0, c.typeIdx, 200, 200);
    
    const dt = 1 / 30;
    const ticks = Math.ceil(c.buildTime * 30) + 60;
    for (let t = 0; t < ticks; t++) eng._sim_step(dt);
    
    const b = getBuild(0);
    if (b.active !== 0 || b.completedId < 0) {
      results.push(`场景 2: FAIL ${c.key} 未完成 active=${b.active} completedId=${b.completedId}`);
      return false;
    }
    
    const units = snapshot();
    const building = units.find(u => u.id === b.completedId);
    if (!building) {
      results.push(`场景 2: FAIL ${c.key} 建筑不在快照中`);
      return false;
    }
    if (building.hp !== c.hp) {
      results.push(`场景 2: FAIL ${c.key} hp=${building.hp} 期望 ${c.hp}`);
      return false;
    }
  }
  
  results.push("场景 2: OK 6 种建筑类型建造完成 + hp 正确");
  return true;
}

// ============== 场景 3：多工人同时建造 ==============
// 3 个工人同时建造不同建筑，验证各自独立完成
function testScenario3() {
  eng._sim_clear_all();
  spawnPeasant(0, 0, 0);
  spawnPeasant(1, 50, 0);
  spawnPeasant(2, 100, 0);
  
  // 3 个工人建造不同建筑
  eng._sim_order_build(0, 0, 200, 200);  // baam
  eng._sim_order_build(1, 1, 300, 200);  // bhut
  eng._sim_order_build(2, 2, 400, 200);  // twog
  
  // 验证所有 worker 都有建造命令
  for (let i = 0; i < 3; i++) {
    const b = getBuild(i);
    if (b.active !== 1) {
      results.push(`场景 3: FAIL worker ${i} active=${b.active}`);
      return false;
    }
  }
  
  // 跑足够长的时间让所有建筑完成（最长 60s = 1800 tick，多跑一些）
  const dt = 1 / 30;
  const ticks = 2000;
  for (let t = 0; t < ticks; t++) eng._sim_step(dt);
  
  // 验证所有 worker 完成
  const completedIds = [];
  for (let i = 0; i < 3; i++) {
    const b = getBuild(i);
    if (b.active !== 0 || b.completedId < 0) {
      results.push(`场景 3: FAIL worker ${i} 未完成 active=${b.active} completedId=${b.completedId}`);
      return false;
    }
    completedIds.push(b.completedId);
  }
  
  // 验证 3 个建筑单位都存在且不同
  const units = snapshot();
  for (let i = 0; i < 3; i++) {
    const building = units.find(u => u.id === completedIds[i]);
    if (!building) {
      results.push(`场景 3: FAIL 建筑 ${completedIds[i]} 不在快照中`);
      return false;
    }
    if (!building.alive) {
      results.push(`场景 3: FAIL 建筑 ${completedIds[i]} 不存活`);
      return false;
    }
  }
  
  // 验证建筑位置正确
  const expectedPositions = [[200, 200], [300, 200], [400, 200]];
  for (let i = 0; i < 3; i++) {
    const building = units.find(u => u.id === completedIds[i]);
    const [ex, ey] = expectedPositions[i];
    if (Math.abs(building.x - ex) > 1 || Math.abs(building.y - ey) > 1) {
      results.push(`场景 3: FAIL 建筑 ${i} 位置 (${building.x},${building.y}) 期望 (${ex},${ey})`);
      return false;
    }
  }
  
  results.push("场景 3: OK 多工人同时建造 + 各自独立完成");
  return true;
}

// ============== 运行测试 ==============
try {
  allOk = testScenario1();
  allOk = testScenario2() && allOk;
  allOk = testScenario3() && allOk;
} catch (e) {
  results.push("异常: " + e.message);
  allOk = false;
}

console.log(results.join("\n"));
console.log(allOk ? "\nbuild 测试: 3/3 场景全过" : "\nbuild 测试: 存在失败");

eng._free(wp);
eng._free(buildBuf);
eng._free(snapBuf);
process.exitCode = allOk ? 0 : 1;
