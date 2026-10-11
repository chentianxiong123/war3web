// tools/item_test.mjs — M4 阶段 4：C 物品系统行为测试
//
// 场景 1：spawn 物品 → sim_get_items 能读到
// 场景 2：单位拾取物品 → owner 变更
// 场景 3：单位丢弃物品 → owner 恢复为 -1
// 场景 4：销毁物品 → sim_item_count 减少
// 场景 5：魔法盾吸伤（Amph 吸收伤害，目标不受伤）
// 场景 6：魔法盾耗尽（Amph hp≤0 后目标开始受伤）
// 场景 7：一次性消耗品自动使用（Samo 低血自动回复）
//
// 用法：node tools/item_test.mjs
//
// 物品类型索引（对应 sim.c SIM_ITEM_TYPES 表）：
//   0 = Samo 圣光卷轴（maxHp 1，一次性）
//   1 = Ssam 治疗药水（maxHp 1，一次性）
//   2 = Amph 魔法盾（maxHp 200，吸收伤害）

import createEngine from "../engine/out/engine.mjs";

const eng = await createEngine();

let allOk = true;
let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) pass++;
  else { fail++; allOk = false; }
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
};

// 物品类型常量（与 sim.c SIM_ITEM_TYPES 索引一致）
const ITEM_SAMO = 0;   // 圣光卷轴
const ITEM_SSAM = 1;   // 治疗药水
const ITEM_AMPH = 2;   // 魔法盾

// ---- 清场：确保 sim_clear_all 后 item_count = 0 ----
eng._sim_clear_all();
check("初始 sim_item_count()=0", eng._sim_item_count() === 0);
check("初始 sim_get_items 返回 0", eng._sim_get_items(eng._malloc(6), 1) === 0);

// ---- 场景 1：spawn + get_items ----
// Amph 魔法盾：位置 (100, 200)，owner=-1（地面），hp 用类型默认 200
const id0 = eng._sim_item_spawn(-1, ITEM_AMPH, 100, 200, -1, 0);
check(`场景1 spawn Amph 分配槽位 id=${id0}`, id0 >= 0);
check("场景1 sim_item_count()=1", eng._sim_item_count() === 1);

const buf = eng._malloc(6 * 8);   // 8 条记录缓冲（out[i*6] = id/typeIdx/x/y/owner/hp）
const n = eng._sim_get_items(buf, 8);
check(`场景1 get_items 返回 1 条`, n === 1);
const H = eng.HEAPF32;
const b = buf >> 2;
check(`场景1 item.id=${H[b]}==${id0}`, H[b] === id0);
check(`场景1 item.typeIdx=2 (Amph)`, H[b+1] === ITEM_AMPH);
check(`场景1 item.x=100`, Math.abs(H[b+2] - 100) < 0.001);
check(`场景1 item.y=200`, Math.abs(H[b+3] - 200) < 0.001);
check(`场景1 item.owner=-1 (地面)`, H[b+4] === -1);
check(`场景1 item.hp=200 (Amph maxHp)`, Math.abs(H[b+5] - 200) < 0.001);

// 顺手验证另两种类型也正常 spawn
const id1 = eng._sim_item_spawn(-1, ITEM_SAMO, 0, 0, -1, 0);
const id2 = eng._sim_item_spawn(-1, ITEM_SSAM, 0, 0, -1, 0);
check(`场景1 spawn Samo id=${id1}`, id1 >= 0);
check(`场景1 spawn Ssam id=${id2}`, id2 >= 0);
check("场景1 sim_item_count()=3", eng._sim_item_count() === 3);
const n2 = eng._sim_get_items(buf, 8);
check("场景1 三条物品都能读到", n2 === 3);

// ---- 场景 2：pickup（单位 7 拾取）----
eng._sim_item_pickup(id0, 7);
const n3 = eng._sim_get_items(buf, 8);
let ownerIdx = -1;
for (let i = 0; i < n3; i++) if (H[b + 6*i] === id0) { ownerIdx = i; break; }
check("场景2 pickup 找到 id0", ownerIdx >= 0);
if (ownerIdx >= 0) {
  check(`场景2 pickup 后 owner=7`, H[b + 6*ownerIdx + 4] === 7);
  check("场景2 pickup 后 hp 不变 (200)", Math.abs(H[b + 6*ownerIdx + 5] - 200) < 0.001);
}

// ---- 场景 3：drop（丢弃到 (300, 400)）----
eng._sim_item_drop(id0, 300, 400);
const n4 = eng._sim_get_items(buf, 8);
ownerIdx = -1;
for (let i = 0; i < n4; i++) if (H[b + 6*i] === id0) { ownerIdx = i; break; }
check("场景3 drop 找到 id0", ownerIdx >= 0);
if (ownerIdx >= 0) {
  check("场景3 drop 后 owner=-1", H[b + 6*ownerIdx + 4] === -1);
  check("场景3 drop 后 x=300", Math.abs(H[b + 6*ownerIdx + 2] - 300) < 0.001);
  check("场景3 drop 后 y=400", Math.abs(H[b + 6*ownerIdx + 3] - 400) < 0.001);
}

// ---- 场景 4：destroy（销毁 id0）----
const cntBefore = eng._sim_item_count();
const destroyed = eng._sim_item_destroy(id0);
check("场景4 destroy 返回 1", destroyed === 1);
check(`场景4 销毁前 count=${cntBefore} 销毁后 count=${eng._sim_item_count()}`, eng._sim_item_count() === cntBefore - 1);
check("场景4 再 destroy 同 id 返回 0", eng._sim_item_destroy(id0) === 0);

// 验证 id0 不在列表中
const n5 = eng._sim_get_items(buf, 8);
let found = false;
for (let i = 0; i < n5; i++) if (H[b + 6*i] === id0) { found = true; break; }
check("场景4 销毁后 id0 不在列表中", !found);

// 清理剩余物品，确认清零
eng._sim_item_destroy(id1);
eng._sim_item_destroy(id2);
check("场景4 清场后 sim_item_count()=0", eng._sim_item_count() === 0);

// 边界：越界 typeIdx / 越界 itemId / 无效操作
check("边界 spawn typeIdx=99 返回 -1", eng._sim_item_spawn(-1, 99, 0, 0, -1, 0) === -1);
check("边界 pickup 无效 itemId 返回 0", eng._sim_item_pickup(999, 0) === 0);
check("边界 drop 无效 itemId 返回 0", eng._sim_item_drop(999, 0, 0) === 0);
check("边界 destroy 无效 itemId 返回 0", eng._sim_item_destroy(999) === 0);
check("边界 表满时 count 不变", eng._sim_item_count() === 0);

// ---- 场景 5：魔法盾吸伤（Amph 吸收伤害）----
{
  const sg = eng._malloc(6 * 4);
  eng._sim_clear_all();
  // 目标（u0）：高 HP，无攻击（atkRange=0），moveSpeed=0
  eng._sim_spawn_fight(0, 0, 0, 0, 0, 31, 1000, 1000, 0, 2, 1, 0, 0, 1, 1.0, 0, 0.1, 0.1, 1, 0, 0);
  // 攻击者（u1）：dmg=50，atkRange=200，朝向 π（面向目标，无需转身）
  eng._sim_spawn_fight(1, 100, 0, Math.PI, 0, 31, 1000, 1000, 0, 2, 0, 50, 0, 1, 1.0, 200, 0.1, 0.1, 1, 0, 0);
  const amphId = eng._sim_item_spawn(-1, ITEM_AMPH, 0, 0, -1, 0);
  eng._sim_item_pickup(amphId, 0);
  for (let t = 0; t < 10; t++) eng._sim_step(1/30);
  const n5 = eng._sim_get_items(buf, 8);
  let amphHp5 = 200;
  for (let i = 0; i < n5; i++) if (H[b + 6*i] === amphId) { amphHp5 = H[b + 6*i + 5]; break; }
  check(`场景5 Amph hp 减少 (200→${Math.round(amphHp5)})`, amphHp5 < 200);
  eng._sim_get_fight(0, sg);
  const targetHp5 = eng.HEAPF32[sg >> 2];
  check(`场景5 u0 hp 不变 (1000→${Math.round(targetHp5)})`, Math.abs(targetHp5 - 1000) < 1);
  eng._free(sg);
}

// ---- 场景 6：魔法盾耗尽（Amph hp≤0 后目标开始受伤）----
{
  const sg = eng._malloc(6 * 4);
  eng._sim_clear_all();
  eng._sim_spawn_fight(0, 0, 0, 0, 0, 31, 1000, 1000, 0, 2, 1, 0, 0, 1, 1.0, 0, 0.1, 0.1, 1, 0, 0);
  eng._sim_spawn_fight(1, 100, 0, Math.PI, 0, 31, 1000, 1000, 0, 2, 0, 50, 0, 1, 1.0, 200, 0.1, 0.1, 1, 0, 0);
  const amphId = eng._sim_item_spawn(-1, ITEM_AMPH, 0, 0, -1, 0);
  eng._sim_item_pickup(amphId, 0);
  for (let t = 0; t < 200; t++) eng._sim_step(1/30);
  const n6 = eng._sim_get_items(buf, 8);
  let amphFound = false;
  for (let i = 0; i < n6; i++) if (H[b + 6*i] === amphId) { amphFound = true; break; }
  check("场景6 Amph 已耗尽销毁", !amphFound);
  eng._sim_get_fight(0, sg);
  const targetHp6 = eng.HEAPF32[sg >> 2];
  check(`场景6 u0 hp 减少 (1000→${Math.round(targetHp6)})`, targetHp6 < 1000);
  eng._free(sg);
}

// ---- 场景 7：一次性消耗品自动使用（Samo 低血自动回复）----
{
  const sg = eng._malloc(6 * 4);
  eng._sim_clear_all();
  eng._sim_spawn_fight(0, 0, 0, 0, 0, 31, 1000, 1000, 0, 2, 1, 0, 0, 1, 1.0, 0, 0.1, 0.1, 1, 0, 0);
  // 攻击者：dmg=300（一击将 u0 打到 700，低于 75% 阈值触发自动使用）
  eng._sim_spawn_fight(1, 100, 0, Math.PI, 0, 31, 1000, 1000, 0, 2, 0, 300, 0, 1, 1.0, 200, 0.1, 0.1, 1, 0, 0);
  const samoId = eng._sim_item_spawn(-1, ITEM_SAMO, 0, 0, -1, 0);
  eng._sim_item_pickup(samoId, 0);
  for (let t = 0; t < 10; t++) eng._sim_step(1/30);
  const n7 = eng._sim_get_items(buf, 8);
  let samoFound = false;
  for (let i = 0; i < n7; i++) if (H[b + 6*i] === samoId) { samoFound = true; break; }
  check("场景7 Samo 已自动使用并销毁", !samoFound);
  eng._sim_get_fight(0, sg);
  const targetHp7 = eng.HEAPF32[sg >> 2];
  check(`场景7 u0 hp 被治疗 (700→${Math.round(targetHp7)})`, targetHp7 > 700);
  eng._free(sg);
}

eng._free(buf);

console.log(`\nitem_test: ${pass}/${pass + fail} 项通过`);
console.log(allOk ? "item_test: 全部通过（7 场景 + 边界）" : "item_test: 存在失败");
process.exitCode = allOk ? 0 : 1;
