// RTS 训练按钮 (Terenas 官方对战): 建筑 -> [type, 名称, 费用]
// 谁训谁 = 官方人族建筑表 (数值来自 unittypes.json 自动, 这里仅中文名/展示)
const TRAIN_BY_BUILDING = {
  htow: [['hpea', '农民', 75]],
  hbar: [['hfoo', '步兵', 135], ['harr', '弓箭手', 75]],
  hars: [['hpri', '牧师', 135], ['hsor', '女巫', 155]],
  harm: [['hmtm', '迫击炮小队', 200]],
  hgra: [['hphx', '狮鹫骑士', 260], ['hgyr', '飞行机器', 135]],
};
// 真实图标: 从 unittypes 的 CommandButtons 图生成 (assets/textures/...)
const ICON_PATHS = await fetch('/data/icons.json').then(r => r.json()).catch(() => ({}));
const cmdBtn = (type, label) => {
  const b = document.createElement('button');
  b.className = 'cmd-btn' + (ICON_PATHS[type] ? ' has-ic' : '');
  if (ICON_PATHS[type]) {
    const i = document.createElement('img'); i.className = 'cmd-ic'; i.src = ICON_PATHS[type]; i.alt = '';
    b.appendChild(i);
  }
  const s = document.createElement('span'); s.textContent = label;
  b.appendChild(s);
  return b;
};
// RTS 建造按钮 (农民可建建筑, 费用/时间对齐 UnitBalance.slk)
const BUILD_BUTTONS = [
  ['hhou', '农场', 80, 35], ['hbar', '兵营', 160, 60], ['hgtw', '防御塔', 100, 50],
  ['hlum', '伐木场', 120, 60], ['hbla', '铁匠铺', 140, 70], ['halt', '圣坛', 180, 60],
  ['hars', '神秘圣地', 150, 140], ['harm', '车间', 140, 140], ['hgra', '狮鹫笼', 140, 150],
];


import { initHud, renderCard } from './hud.js';
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const icon = (p) => (p ? `/assets/${p}` : '/assets/textures/_teamcolor.png');
// For anything a *player* typed -- names, and the scoreboard cells the map
// script builds from them -- before it lands in innerHTML. A name of
// `<img onerror=...>` is script in every connected browser otherwise.
export const esc = (s) => String(s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A hero's own model, rendered at build time by tools/hero_portraits.mjs. The
// map ships no icons for its heroes -- every one of them carries whatever art
// the Warcraft III unit it was built from had, so Goku picks as a Paladin and
// Ichigo as a Blood Elf Peasant. The `onerror` falls back to that original icon,
// so a missing portrait costs the card nothing.
const portrait = (id) => `/assets/portraits/${id}.png`;
// Language. The map's text is Korean; data/translations.ko-en.json supplies an
// English overlay and compile_game.py ships both, so this only chooses which of
// the two already-present strings to show. Nothing is translated at runtime.
export const Lang = {
  en: (() => { try { return localStorage.getItem('foc.lang') !== 'ko'; } catch { return true; } })(),
  set(en) {
    this.en = !!en;
    try { localStorage.setItem('foc.lang', this.en ? 'en' : 'ko'); } catch {}
  },
};
/** A field in the chosen language, falling back to the map's own text. */
export const T = (o, field) => {
  if (!o) return '';
  const en = o[field + 'En'];
  return (Lang.en && en) || o[field] || '';
};

const TAVERN_NAMES = { n00M: 'Tavern I', n006: 'Tavern II', ntav: 'Tavern III', n00W: 'Tavern IV' };

export class UI {
  constructor(net) {
    this.net = net;
    this.heroes = [];
    this.selected = null;
    this.tavern = null;
    this.you = null;
    this.players = [];
    this.logLines = [];
    initHud(this);
  }

  setLoading(msg, pct) {
    $('loadmsg').textContent = msg;
    if (pct != null) $('loadbar').style.width = `${Math.round(pct * 100)}%`;
  }
  hideLoading() { $('loading').classList.add('hidden'); }

  showLobby(game, heroes) {
    this.heroes = heroes;
    $('objective').textContent = game.meta.objective || '';
    $('lobby').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('gameover').classList.add('hidden');
    // biggest rosters first, so the default tab is a real hero tavern rather
    // than a one-off vendor that happens to sell a hero-flagged unit
    const counts = new Map();
    for (const h of heroes) counts.set(h.tavern, (counts.get(h.tavern) || 0) + 1);
    const tavs = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    // keep whichever tavern is open; only fall back when nothing valid is selected
    if (!tavs.includes(this.tavern)) this.tavern = tavs[0];
    const tabs = $('tavtabs'); tabs.innerHTML = '';
    for (const t of tavs) {
      const b = el('button', t === this.tavern ? 'on' : '', TAVERN_NAMES[t] || t);
      b.onclick = () => { this.tavern = t; this.showLobby(game, heroes); };
      tabs.appendChild(b);
    }
    const grid = $('heroGrid'); grid.innerHTML = '';
    for (const h of heroes.filter((x) => x.tavern === this.tavern)) {
      const c = el('div', 'hcard' + (h.model ? '' : ' nomodel') + (this.selected === h.id ? ' sel' : ''));
      c.dataset.id = h.id;                 // so a test can pick a named hero
      c.innerHTML = `<img src="${portrait(h.id)}" data-icon="${icon(h.icon)}"
          onerror="if(this.dataset.icon){this.src=this.dataset.icon;this.dataset.icon='';}
                   else this.style.opacity=.25">
        <div class="nm">${h.name}</div><div class="ti">${T(h, 'title')}</div>`;
      c.onclick = () => { this.selected = h.id; this.showHero(h); this.showLobby(game, heroes);
                          this.net.send({ t: 'pickHero', heroId: h.id }); };
      grid.appendChild(c);
    }
    if (this.selected) {
      const h = heroes.find((x) => x.id === this.selected);
      if (h) this.showHero(h);
    }
  }

  showHero(h) {
    // #heroInfo, not #heroDetail: the spin canvas is a sibling and must survive,
    // or every pick throws away a WebGL context and builds another
    const d = $('heroInfo');
    d.innerHTML = `<h2>${h.name}</h2><div class="sub">${T(h, 'title')}${h.model ? '' : ' · no imported model'}</div>
      <div class="statgrid">
        <span>Health</span><b>${h.hp}</b><span>Mana</span><b>${h.mana}</b>
        <span>Damage</span><b>${h.dmg}</b><span>Armor</span><b>${h.armor}</b>
        <span>Move</span><b>${h.moveSpeed}</b><span>Range</span><b>${h.atkRange}</b>
        <span>STR / AGI / INT</span><b>${h.str} / ${h.agi} / ${h.int}</b>
      </div>`;
    if (this.onHeroShown) this.onHeroShown(h);
    for (const a of h.abilities || []) {
      const row = el('div', 'ab');
      row.innerHTML = `<img src="${icon(a.icon)}" onerror="this.style.opacity=.25">
        <div><b>${T(a, 'name')}</b><p>${T(a, 'desc').slice(0, 220)}</p></div>`;
      d.appendChild(row);
    }
  }

  renderTeams(players, you, phase) {
    this.players = players; this.you = you;
    const box = $('teams'); box.innerHTML = '';
    for (const t of [0, 1]) {
      box.appendChild(el('h3', null, `${t === 0 ? '红方' : '蓝方'}`));
      for (const p of players.filter((x) => x.team === t)) {
        const hero = this.heroes.find((h) => h.id === p.heroId);
        const row = el('div', 'pslot' + (p.id === you ? ' me' : ''));
        row.innerHTML = `<i class="rd ${p.ready ? 'on' : ''}"></i><span>${esc(p.name)}</span>
                         <small>${hero ? hero.name : '—'}</small>`;
        box.appendChild(row);
      }
    }
    $('btnTeam0').classList.toggle('on', players.find((p) => p.id === you)?.team === 0);
    $('btnTeam1').classList.toggle('on', players.find((p) => p.id === you)?.team === 1);
  }

  /**
   * Cinematic mode, as CinematicModeBJ asks for it: the interface fades out
   * over `fade` seconds and letterbox bars close in over the same time; the
   * player's control goes with it (main.js gates its input on S.cinematic).
   * The bars are Warcraft III's own framing for a cinematic; their height is
   * a figure of ours, not one from any file (see style.css).
   */
  setCinematic(on, fade = 0.5) {
    document.body.style.setProperty('--cinefade', `${Math.max(0, +fade || 0)}s`);
    document.body.classList.toggle('cinematic', !!on);
  }

  startGame() {
    this.setCinematic(false, 0);
    $('lobby').classList.add('hidden');
    $('hud').classList.remove('hidden');
    // Nothing ever re-hid this, so the second match in a room was played under
    // the first one's opaque, click-eating banner.
    $('gameover').classList.add('hidden');
    // let the preview go: the game needs the memory more than the menu does
    if (this.onLobbyClosed) this.onLobbyClosed();
  }

  /**
   * Warcraft III's timer dialog, in the corner where the game puts it.
   *
   * This map runs its duel countdown through one -- "Duel in", five minutes --
   * and it is the only clock a player gets, since the map never touches the
   * day/night cycle. The title arrives with Warcraft III's own colour markup
   * (`|cAARRGGBB ... |r`), which is honoured rather than stripped: the map
   * chose yellow and it should read yellow.
   */
  updateClock(clock) {
    const box = $('gameclock');
    if (!box) return;
    if (!clock) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const m = /\|c[0-9a-f]{2}([0-9a-f]{6})/i.exec(clock.title || '');
    const title = String(clock.title || '').replace(/\|c[0-9a-f]{8}|\|r/gi, '');
    const t = $('clockTitle');
    t.textContent = title;
    t.style.color = m ? '#' + m[1] : '';
    const left = Math.max(0, clock.left || 0);
    const mm = Math.floor(left / 60);
    const ss = Math.floor(left % 60);
    $('clockTime').textContent = mm + ':' + String(ss).padStart(2, '0');
    box.classList.toggle('soon', left <= 15);
  }

  /** The map maintains its own scoreboard; mirror it verbatim. */
  updateScore(board, killsToWin) {
    this.board = board;
    if (board?.kind === 'multiboard') {
      const t = board.teams || [];
      $('k0').textContent = t[0] ? t[0].value : 0;
      $('k1').textContent = t[1] ? t[1].value : 0;
      if (t[0]) { $('k0').title = t[0].label; $('k0').previousElementSibling; }
      $('scoreMid').textContent = board.title || '';
      const lbl = document.querySelectorAll('#topbar .score span');
      if (lbl[0] && t[0]) lbl[0].textContent = t[0].label;
      if (lbl[1] && t[1]) lbl[1].textContent = t[1].label;
    } else if (board?.rows?.length) {
      const r = board.rows;
      $('k0').textContent = r[0] ? r[0].value : 0;
      $('k1').textContent = r[1] ? r[1].value : 0;
      $('scoreMid').textContent = board.title || '';
    } else {
      $('scoreMid').textContent = `先到 ${killsToWin} 击杀`;
    }
  }

  updateHero(h) {
    this.hero = h;
    $('pname2').textContent = h.name;
    $('heroClass').textContent = `等级 ${h.level} ${T(h, 'title')}`;
    const set = (bar, txt, v, m) => {
      $(bar).style.width = `${Math.max(0, Math.min(100, (v / Math.max(1, m)) * 100))}%`;
      if (txt) $(txt).textContent = `${Math.round(v)} / ${Math.round(m)}`;
    };
    set('hpbar', 'hptext', h.hp, h.maxHp);
    set('mpbar', 'mptext', h.mana, h.maxMana);
    set('xpbar', null, h.xp, h.xpNeed || 1);
    $('stats').innerHTML = `<div class="combat-stats"><div>Damage: <b>${h.dmg}</b></div><div>Armor: <b>${h.armor}</b></div></div>
      <div class="hero-attributes">${[['str', '力量'], ['agi', '敏捷'], ['int', '智力']].map(([key, name]) =>
        `<div data-tooltip="${name}: ${h[key]}"><img src="/assets/ui/${key}.png" alt="${name}"><b>${h[key]}</b></div>`).join('')}</div>`;
    if (this.unitSel) { this.renderSelected(this.unitSel); return; }
    // A selected shop takes over the panel and the card, and the inventory
    // stays: Warcraft III leaves your six slots visible while you shop, which
    // is the only way to see whether there is room for what you are buying.
    if (this.shopSel) {
      this.renderShopPanel(this.shopSel);
      this.renderShopCard(this.shopSel);
      this.renderInventory(h);
      return;
    }
    this.renderAbilities(h);
    this.renderInventory(h);
    const r = $('respawn');
    if (!h.alive) { r.classList.remove('hidden'); r.textContent = `Reviving in ${h.respawnIn}s`; }
    else r.classList.add('hidden');
  }

  /**
   * The hero's inventory: six slots, as Warcraft III gives one.
   *
   * Items apply their bonuses passively the moment they are carried, so this is
   * only about seeing and spending them -- click to use a charge, right-click to
   * drop.  Empty slots are still drawn, because knowing how much room is left is
   * half of what an inventory is for.
   */
  activateItem(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 5 || this.inventoryHero?.alive === false || this.canUseItems?.() === false) return;
    const it = this.inventoryHero?.items?.[slot];
    if (!it) return;
    this.beforeUseItem?.();
    if (it.targeted && this.onAimItem) this.onAimItem(slot, it);
    else this.net.send({ t: 'useItem', slot });
  }

  renderInventory(h) {
    this.inventoryHero = h;
    queueMicrotask(() => this.placeCard());
    const box = $('inventory');
    if (!box) return;
    box.innerHTML = '';
    const carried = h.items || [];
    for (let i = 0; i < 6; i++) {
      const it = carried[i];
      const cell = el('div', 'islot' + (it ? '' : ' empty'));
      if (it) {
        cell.innerHTML = `<img src="${icon(it.icon)}" onerror="this.style.opacity=.2">` +
                         (it.charges > 0 ? `<b class="chg">${it.charges}</b>` : '');
        cell.dataset.tooltip = `${it.name} (Numpad ${[7,8,4,5,1,2][i]})${it.charges > 0 ? ` (${it.charges} charges)` : ''}` +
                     (it.targeted ? '\nclick then click a target · right-click to drop'
                                  : '\nclick to use · right-click to drop');
        // an item aimed at a unit arms the cursor instead of firing at once
        cell.onclick = () => this.activateItem(i);
        // right-click drops; shift+right-click sells it back. Warcraft III sells
        // by dragging the item onto a shop, which a single canvas cannot offer,
        // so the gesture is ours -- the refund and the event it fires are not.
        cell.oncontextmenu = (ev) => {
          ev.preventDefault();
          this.net.send({ t: ev.shiftKey ? 'pawnItem' : 'dropItem', slot: i });
        };
      }
      box.appendChild(cell);
    }
  }

  renderSelected(ent) {
    this.unitSel = ent;
    this.inventoryHero = null;
    $('respawn').classList.add('hidden');
    $('pname2').textContent = ent.name || ent.u || '';
    $('heroClass').textContent = '';
    // RTS 建造中: 农民选择卡显示建筑进度
    if (ent.bld) {
      const bn = BUILD_BUTTONS.find(([t]) => t === ent.bld.type);
      $('heroClass').textContent = `建造中: ${bn ? bn[1] : ent.bld.type} ${ent.bld.pct}%`;
    }
    for (const [bar, text, value, max] of [['hpbar', 'hptext', ent.h, ent.H], ['mpbar', 'mptext', ent.m, ent.M]]) {
      $(bar).style.width = `${100 * Math.max(0, Math.min(1, (value || 0) / (max || 1)))}%`;
      $(text).textContent = max ? `${Math.round(value || 0)} / ${Math.round(max)}` : '';
    }
    $('xpbar').style.width = '0%';
    $('stats').replaceChildren();
    $('inventory').replaceChildren();
    if (this.canCommand?.(ent)) {
      if (TRAIN_BY_BUILDING[ent.u]) {
        // RTS 命令面板: 该建筑训练自己的单位 (官方人族建筑表)
        const ab = $('commands');
        ab.replaceChildren(...TRAIN_BY_BUILDING[ent.u].map(([type, name, cost]) => {
          const b = cmdBtn(type, `${name} (${cost}金)`);
          b.onclick = () => window.__trainBtn && window.__trainBtn(type);
          return b;
        }));
      } else if (ent.u === 'hpea' || ent.u === 'hmil') {
        // RTS 命令面板: 农民选建筑来放
        const ab = $('commands');
        ab.replaceChildren(...BUILD_BUTTONS.map(([type, name, gold, sec]) => {
          const b = cmdBtn(type, `${name} ${gold}金/${sec}s`);
          b.onclick = () => window.__buildBtn && window.__buildBtn(type);
          return b;
        }));
      } else {
        this.renderAbilities({ alive: !!ent.a, abilities: [], skillPoints: 0 });
        $('commands').replaceChildren();
      }
    }
    else { $('abilities').replaceChildren(); $('commands').replaceChildren(); }
  }

  /** 训练按钮配置: type / 名称 / 费用 (与 server/world.js TRAIN 表一致) */
  static TRAIN_SETUP() { return TRAIN_BY_BUILDING; }

  renderAbilities(h) {
    renderCard(this, h, T);
  }

  /**
   * The build tag in the corner.
   *
   * The build number is the useful half day to day -- it answers "is the server
   * running what I just changed?" -- so it leads. The hash is what identifies a
   * build to anyone else, and the date is only ever wanted once, so both go in
   * the tooltip rather than on screen.
   */
  /**
   * @param map  which map this server is serving, from game.json's meta.name
   *
   * The build number hashes client/, server/ and shared/ and deliberately not
   * data/, so two servers built from the same code but a different map report
   * the same number. That is the right answer for "which build" and the wrong
   * one for "which server am I looking at", which is the question you actually
   * have when more than one is running. The map name settles it.
   */
  setBuild(b, debug, map) {
    const box = $('build');
    if (!box || !b) return;
    box.innerHTML = `v${b.v} \u00b7 <b>build ${b.n}</b>`
      + (debug ? ' \u00b7 <span class="dbg">DEBUG</span>' : '')
      + (map ? `<span class="map">${esc(map)}</span>` : '');
    const when = b.t ? new Date(b.t) : null;
    box.title = `${b.hash}${when ? ` \u00b7 ${when.toLocaleString()}` : ''}`
      + (map ? `\n${map}` : '')
      + (debug ? '\nFOC_DEBUG is on: L levels the hero to the cap' : '');
  }

  /**
   * Lay the ability and inventory buttons into the command card's own cells.
   *
   * The cells are measured out of the console art rather than chosen, so this
   * only has to hand each button the rectangle the game left for it. Called
   * again after either panel re-renders, since both replace their children.
   */
  placeCard() {
    const cells = this.cardCells;
    if (!cells || !cells.length) return;
    const put = (el, style) => {
      if (!el || !style) return;
      el.style.position = 'fixed';
      for (const k of ['left', 'right', 'top', 'bottom']) el.style[k] = 'auto';
      Object.assign(el.style, style);
      el.style.width = style.width;
      el.style.height = style.height;
    };
    const slots = [...document.querySelectorAll('#abilities .slot')];
    const items = [...document.querySelectorAll('#inventory .islot')];
    for (const host of ['abilities', 'inventory']) {
      const e = $(host);
      if (e) { e.style.position = 'static'; e.style.display = 'contents'; }
    }
    // The command card is the abilities' and the inventory has its own six
    // slots beside it, which is where Warcraft III puts them.
    slots.forEach((el, i) => put(el, cells[Number(el.dataset.cell ?? i)]));
    items.forEach((el, i) => put(el, (this.invCells || [])[i]));
  }

  /** Match the minimap's drawing buffer to the opening the console gives it. */
  fitMinimap() {
    const c = $('mmcanvas');
    if (!c) return;
    const r = c.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
  }

  /**
   * The connection is gone. The client is trying to get its seat back (see
   * reconnect in main.js) and says so; the Refresh button stays for when the
   * seat is gone, because a fresh page is then the only way in.
   */
  showDisconnected(msg) {
    const d = $('disconnected');
    if (!d) return;
    const t = d.querySelector('p');
    if (t && msg) t.textContent = msg;
    d.classList.remove('hidden');
    const b = $('btnRejoin');
    if (b) b.onclick = () => location.reload();
  }
  hideDisconnected() { $('disconnected')?.classList.add('hidden'); }

  log(text, cls) {
    this.logLines.push({ text, cls, t: performance.now() });
    if (this.logLines.length > 9) this.logLines.shift();
    const box = $('log'); box.innerHTML = '';
    for (const l of this.logLines) box.appendChild(el('div', l.cls, l.text));
  }

  /**
   * Selecting a shop, the way Warcraft III does it.
   *
   * The console does not open a window for a shop: selecting the building
   * REPLACES what the bottom bar is showing. The portrait becomes the shop's
   * model, the name and bars become the shop's, and the command card -- the
   * same grid the hero's abilities live in -- fills with its stock. Clicking a
   * cell buys.
   *
   * This used to be a floating list on the 'b' key, which had two problems:
   * it is not what the game does, and four of this map's heroes bind an
   * ability to 'b', so on those heroes the key was swallowed by the ability
   * table before it ever reached the shop.
   */
  selectShop(ent, shop) {
    this.shopSel = shop ? { ent, shop } : null;
    if (this.hero) this.updateHero(this.hero);
    this.onShopChange?.(this.shopSel);
  }
  clearShop() { if (this.shopSel) this.selectShop(null, null); }

  /** The shop's own name and health, in the panel the hero's would use. */
  renderShopPanel({ ent, shop }) {
    $('pname2').textContent = shop.name || ent.u;
    $('heroClass').textContent = '';
    const hp = ent.h ?? 0, maxHp = ent.H ?? 0;
    const set = (bar, txt, v, m) => {
      $(bar).style.width = `${Math.max(0, Math.min(100, (v / Math.max(1, m)) * 100))}%`;
      if (txt) $(txt).textContent = m > 0 ? `${Math.round(v)} / ${Math.round(m)}` : '';
    };
    set('hpbar', 'hptext', hp, maxHp);
    set('mpbar', 'mptext', ent.m ?? 0, ent.M ?? 0);
    set('xpbar', null, 0, 1);
    const gold = this.hero ? this.hero.gold : 0;
    $('stats').innerHTML =
      `<span>SHOP</span><b>${esc(shop.name || '')}</b>` +
      `<span>STOCK</span><b>${shop.items.length}</b>` +
      `<span>GOLD</span><b>${gold}</b><span></span><b></b>`;
    $('respawn').classList.add('hidden');
  }

  /** The shop's stock, laid into the command card's own cells. */
  renderShopCard({ shop }) {
    queueMicrotask(() => this.placeCard());
    const box = $('abilities');
    if (!box) return;
    box.innerHTML = '';
    const gold = this.hero ? this.hero.gold : 0;
    for (const it of shop.items) {
      const afford = gold >= (it.gold || 0);
      // 'shopitem' keeps the shop's styling off the ability buttons that share
      // these cells -- the gold price uses the corner an ability rank sits in.
      const cell = el('div', 'slot shopitem' + (afford ? '' : ' tooldear'));
      cell.style.backgroundImage = it.icon ? `url(${icon(it.icon)})` : 'none';
      cell.dataset.tooltip = `${it.name} — ${it.gold || 0} gold`
                 + (afford ? '' : '\nNot enough gold')
                 + (it.desc || it.tip ? `\n${it.desc || it.tip}` : '');
      cell.innerHTML = `<span class="lv">${it.gold || 0}g</span>`
                     + (it.icon ? '' : `<span class="noicon">${(it.name || '?')[0]}</span>`);
      cell.onclick = () => this.net.send({ t: 'buy', itemId: it.id });
      box.appendChild(cell);
    }
  }

  gameOver(winner, board) {
    const g = $('gameover');
    g.classList.remove('hidden');
    const rows = (board && board.rows || [])
      .map((r) => `${esc(String(r.label).replace(/\|c........|\|r/g, ''))} ${esc(r.value)}`).join(' &nbsp;·&nbsp; ');
    g.innerHTML = `<div class="box"><h2>${winner != null ? `Team ${winner + 1} wins` : 'Match over'}</h2>
      <p class="dim">${rows}</p></div>`;
  }

  toggleScore(show) {
    const s = $('score');
    if (!show) { s.classList.add('hidden'); return; }
    s.classList.remove('hidden');
    const close = () => {
      const button = document.createElement('button'); button.textContent = 'Close (Esc)';
      button.onclick = () => this.onShowScore?.(false); s.appendChild(button);
    };
    // prefer the map's own scoreboard when it built one
    if (this.board?.kind === 'multiboard' && this.board.rows.length) {
      const [head, ...body] = this.board.rows;
      s.innerHTML = `<table><caption>${esc(this.board.title)}</caption><tr>${
        head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${
        body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
      close(); return;
    }
    const rows = this.players.map((p) => {
      const h = this.heroes.find((x) => x.id === p.heroId);
      return `<tr><td>${esc(p.name)}</td><td>${h ? h.name : '—'}</td>
              <td>${p.team === 0 ? '红方' : '蓝方'}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`;
    }).join('');
    s.innerHTML = `<table><tr><th>Player</th><th>Hero</th><th>Team</th><th>K</th><th>D</th></tr>${rows}</table>`;
    close();
  }

  drawMinimap(bounds, ents, youId, terrainImg, footprint = []) {
    const c = $('mmcanvas'), g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    if (terrainImg) g.drawImage(terrainImg, 0, 0, W, H);
    else { g.fillStyle = '#0d1017'; g.fillRect(0, 0, W, H); }
    const bx = bounds.maxX - bounds.minX, by = bounds.maxY - bounds.minY;
    if (footprint.length) {
      g.save(); g.beginPath(); g.rect(0,0,W,H); g.clip();
      g.strokeStyle='#fff'; g.lineWidth=1.5;
      g.beginPath();
      footprint.forEach((p,i) => {
        const x=(p.x-bounds.minX)/bx*W,y=(bounds.maxY-p.y)/by*H;
        if(i) g.lineTo(x,y); else g.moveTo(x,y);
      });
      g.closePath(); g.stroke(); g.restore();
    }
    if (this.minimapOrder?.until > performance.now()) {
      const p=this.minimapOrder;
      g.strokeStyle='#66ff99';g.lineWidth=2;g.beginPath();
      g.arc((p.x-bounds.minX)/bx*W,(bounds.maxY-p.y)/by*H,6,0,Math.PI*2);g.stroke();
    }

    for (const alert of this.minimapAlerts || []) {
      const age = performance.now() - alert.time;
      if (age < 0 || age > 5000) continue;
      g.save(); g.globalAlpha = 1 - age / 5000;
      g.strokeStyle = alert.kind === 'death' ? '#ffd966' : '#ff4433';
      g.lineWidth = 2; g.beginPath();
      g.arc((alert.x-bounds.minX)/bx*W, (bounds.maxY-alert.y)/by*H,
        5 + (age % 1000) / 100, 0, Math.PI*2);
      g.stroke(); g.restore();
    }

    for (const e of ents) {
      const px = ((e.x - bounds.minX) / bx) * W;
      const py = H - ((e.y - bounds.minY) / by) * H;
      if (e.k === 4) continue;
      g.fillStyle = e.i === youId ? '#ffe680' : e.t === 0 ? '#5aa9e6' : e.t === 1 ? '#e2564d' : '#9a9a9a';
      const r = e.i === youId ? 3.5 : e.k === 2 ? 3 : 2.5;
      g.beginPath(); g.arc(px, py, r, 0, 6.284); g.fill();
    }
  }
}
