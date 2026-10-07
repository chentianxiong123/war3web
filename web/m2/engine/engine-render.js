// 引擎单位 -> WebGPU 渲染壳对接
// 每帧从 world.units (引擎状态) 同步到 three 场景 (我们的渲染壳)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export function bindEngineUnits({ scene, world, heightAt, log, cloneSkeleton }) {
  const vis = new Map();          // unit.id -> 渲染对象
  const cache = new Map();        // model name -> glb
  const loader = new GLTFLoader();
  loader.setResourcePath('./foc/assets/');
  let um = null;                  // unitmodels.json 延迟加载

  const loadModel = async (name) => {
    if (cache.has(name)) return cache.get(name);
    try {
      const glb = await loader.loadAsync('./foc/assets/models/' + name + '.glb');
      cache.set(name, glb); return glb;
    } catch (e) { cache.set(name, null); return null; }
  };

  const ensureUnit = async (u) => {
    if (!um) { try { um = await (await fetch('./foc/data/unitmodels.json')).json(); } catch { um = {}; } }
    const info = um[u.typeKey];
    if (!info || !info.m) return null;
    const glb = await loadModel(info.m);
    if (!glb) return null;
    const obj = cloneSkeleton(glb.scene);
    obj.scale.setScalar(info.s || 1);
    scene.add(obj);
    let mixer = null, stand = null, walk = null;
    if (glb.animations && glb.animations.length) {
      mixer = new THREE.AnimationMixer(obj);
      const find = (re) => { const i = glb.animations.findIndex(a => re.test(a.name.toLowerCase())); return i >= 0 ? i : null; };
      const si = find(/^stand/), wi = find(/^walk/);
      stand = si != null ? mixer.clipAction(glb.animations[si]) : null;
      walk = wi != null ? mixer.clipAction(glb.animations[wi]) : null;
      if (stand) stand.play();
    }
    return { obj, mixer, stand, walk, current: null, typeKey: u.typeKey };
  };

  let pending = new Set();
  const sync = () => {
    for (const u of world.units.values()) {
      if (u.hidden || u.removed) continue;
      if (!u.alive) { const v = vis.get(u.id); if (v) { scene.remove(v.obj); vis.delete(u.id); } continue; }
      let v = vis.get(u.id);
      if (!v) {
        if (pending.has(u.id)) continue;                 // 加载中
        pending.add(u.id);
        ensureUnit(u).then((r) => {
          pending.delete(u.id);
          if (r) vis.set(u.id, r);
        });
        continue;
      }
      const y = heightAt(u.x, u.y);
      v.obj.position.set(u.x, y, -u.y);
      // 管线模型 yaw0 朝 +X, WC3 facing 0=东 -> 直接 rotation.y
      v.obj.rotation.y = u.facing;
      // 动画: 移动中 walk, 否则 stand
      if (v.mixer) {
        const wantWalk = !!(u.path && u.path.length);
        const act = wantWalk ? v.walk : v.stand;
        if (act && v.current !== act) { if (v.stand) v.stand.stop(); if (v.walk) v.walk.stop(); act.play(); v.current = act; }
        v.mixer.update(0.016);
      }
    }
    // 清理消失的单位
    for (const [id, v] of vis) if (!world.units.has(id)) { scene.remove(v.obj); vis.delete(id); }
  };
  return sync;
}
