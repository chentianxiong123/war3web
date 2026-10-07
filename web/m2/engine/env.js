// 浏览器适配层: 模拟 Node 的 fs/path，同步读页面预加载的数据缓存 (window.__DATA)
// 数据 key = 相对 foc-web 根的路径, 如 'data/unittypes.json' / 'public/data/walk.bin'
// .bin 返回 Uint8Array (带 .buffer 供 Float32Array 用), 其余返回 string (latin1/utf8)
const DATA = (typeof window !== 'undefined' && window.__DATA) || {};
const isBin = (k) => k.endsWith('.bin');

export default {
  readFileSync(p) {
    const k = String(p).replace(/^\/+/, '');
    if (!(k in DATA)) throw new Error('env: no cached data for ' + k);
    const v = DATA[k];
    if (isBin(k) && !(v instanceof Uint8Array)) return new Uint8Array(v);
    return v;
  },
  resolve(...a) {
    const parts = a.filter((x) => x != null).join('/').split('/');
    const out = [];
    for (const q of parts) {
      if (q === '..') out.pop();
      else if (q === '.' || q === '') continue;
      else out.push(q);
    }
    return out.join('/');
  },
  join(...a) { return a.filter((x) => x != null).join('/'); },
  dirname() { return '/'; },
};
