import { parseW3DO } from './w3do.js';
import { readFileSync } from 'fs';

for (const [name, path] of [['war3mapUnits.doo', '/tmp/m2/war3mapUnits.doo'], ['war3map.doo', '/tmp/m2/war3map.doo']]) {
  const d = parseW3DO(new Uint8Array(readFileSync(path)));
  console.log(`=== ${name}: version=${d.version} sub=${d.sub} items=${d.items.length} consumed=${d.consumed}/${d.total} ===`);
  // 统计 ID 频次
  const cnt = {};
  for (const it of d.items) cnt[it.id] = (cnt[it.id] || 0) + 1;
  const top = Object.entries(cnt).sort((a,b) => b[1]-a[1]).slice(0, 12);
  console.log('  常见对象:', top.map(([k,v]) => `${k}x${v}`).join(' '));
  // 样例坐标
  if (d.items.length) {
    const s = d.items[0];
    console.log('  样例:', JSON.stringify({id:s.id, x:s.x, y:s.y, z:s.z, rot:s.rot}));
  }
}
