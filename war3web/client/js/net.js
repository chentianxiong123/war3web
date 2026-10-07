import { Msg } from '/shared/const.js';

export class Net {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.rtt = 0;
    this.you = null;
    // the seat token the server hands out in WELCOME; sent back with HELLO so
    // a reconnect inside the grace period reclaims the same seat
    this.token = null;
  }
  on(t, fn) { this.handlers.set(t, fn); return this; }
  connect(name, room = new URLSearchParams(location.search).get('room') || 'arena') {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
    this.ws.onopen = () => {
      this.send({ t: Msg.HELLO, name, token: this.token || undefined });
      this._ping = setInterval(() => this.send({ t: Msg.PING, c: performance.now() }), 2000);
    };
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === Msg.PONG) { this.rtt = Math.round(performance.now() - m.c); return; }
      const h = this.handlers.get(m.t);
      if (h) h(m);
    };
    this.ws.onclose = () => {
      clearInterval(this._ping);
      this.ws = null;
      const h = this.handlers.get('closed'); if (h) h();
    };
    return this;
  }
  send(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }
}
