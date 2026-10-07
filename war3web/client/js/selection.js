// Selection state is independent of the console and of network commands.
export class Selection {
  ids = [];
  groups = new Map();
  activeId = null;
  set(ids) {
    this.ids = [...new Set(ids)].slice(0, 12);
    if (!this.ids.includes(this.activeId)) this.activeId = this.ids[0] ?? null;
  }
  subgroups(entities) {
    const groups = new Map();
    for (const id of this.ids) {
      const ent = entities.get(id); if (!ent) continue;
      if (!groups.has(ent.u)) groups.set(ent.u, []);
      groups.get(ent.u).push(id);
    }
    // Hero types lead the cycle; otherwise keep the user's selection order.
    return [...groups.values()].sort((a,b) => (entities.get(b[0]).k === 1) - (entities.get(a[0]).k === 1));
  }
  cycle(entities, direction = 1) {
    const groups = this.subgroups(entities); if (!groups.length) return;
    const index = Math.max(0, groups.findIndex(ids => ids.includes(this.activeId)));
    this.activeId = groups[(index + direction + groups.length) % groups.length][0];
  }
  toggle(id) { this.set(this.ids.includes(id) ? this.ids.filter(i => i !== id) : [...this.ids, id]); }
  prune(valid) { this.set(this.ids.filter(valid)); }
  assign(key, valid) { this.groups.set(key, this.ids.filter(valid)); }
  recall(key, valid) { this.set((this.groups.get(key) || []).filter(valid)); }
}
