// Coordinates are captured when the alert occurs, not when Space is pressed.
export class AlertHistory {
  constructor() { this.clear(); }
  clear() { this.entries = []; this.cursor = 0; }
  add(kind, x, y, now = performance.now()) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Local anti-spam policy: one attack alert per area per ten seconds.
    if (kind === 'attack' && this.entries.some(e => e.kind === kind &&
        now - e.time < 10000 && Math.hypot(e.x - x, e.y - y) < 1200)) return null;
    const entry = { kind, x, y, time: now };
    this.entries.unshift(entry);
    this.entries.length = Math.min(this.entries.length, 8);
    this.cursor = 0;
    return entry;
  }
  next() {
    if (!this.entries.length) return null;
    const entry = this.entries[this.cursor];
    this.cursor = (this.cursor + 1) % this.entries.length;
    return entry;
  }
}
