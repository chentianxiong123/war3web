// 命令卡上的一切都来自官方表。这里只负责取数并把它凑成 renderCard 画的形状, 渲染
// (落格 / 灰化 / 冷却 / 提示 / 按键复用) 全部是上游 renderCard 的事, 一行没改。
//
//   data/hud.json           Units\*AbilityFunc.txt 的 Buttonpos  (tools/hud_assets.py)
//   data/ability_icons.json abilities.json 的 art.icon -> PNG      (tools/icons.py)
//   data/ability_meta.json  同一张表的蓝量/冷却/施法距离            (tools/icons.py)
//   data/unit_card.json     Units\*UnitFunc.txt 的 Builds / Trains, 费用时间人口
//
// 这几张表取代了这里原来的三张手写表: 9 个人族建筑、6 个人族训练对、5 个命令按钮。
// 它们只覆盖人类, 而且和官方数据不一致 —— 兵营被写成训"步兵 + 弓箭手", 而
// Units\HumanUnitFunc.txt 的 Trains=hfoo,hrif,hkni 是步兵/圣骑士/骑士; 弓箭手不是这个
// 等级的建筑能训的, 它自己的箭塔 (hgtw 国王祭坛) 反而漏了。农民能建的也是 9 个, 而
// Builds 列的是 11 个。图标也从 hud_assets.py 另存的 assets/ui 副本改回官方全量表
// (tools/extract_icons.py 提取的 1150 个 CommandButtons)。
const ICON_PATHS = await fetch('/data/icons.json').then(r => r.json()).catch(() => ({}));
const ABIL_ICONS = await fetch('/data/ability_icons.json').then(r => r.json()).catch(() => ({}));
const ABIL_META = await fetch('/data/ability_meta.json').then(r => r.json()).catch(() => ({}));
const UNIT_CARD = await fetch('/data/unit_card.json').then(r => r.json()).catch(() => ({}));
const ITEM_ICONS = await fetch('/data/item_icons.json').then(r => r.json()).catch(() => ({}));
// 命令按钮自己的图标 (BTNBasicStruct = 建造入口, BTNMove 等), 官方全量表 1150 个。
const BTN_ICONS = await fetch('/data/btn_icons.json').then(r => r.json()).catch(() => ({}));
setAbilityIcons(ABIL_ICONS);

import { initHud, renderCard, setAbilityIcons } from './hud.js';
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

export class UI {
  constructor(net) {
    this.net = net;
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

  showLobby(game) {
    // Terenas: no hero pick. The lobby is the objective, the teams and the
    // ready button; the FOC tavern grid and the spin preview are gone.
    $('objective').textContent = game.meta.objective || '';
    $('lobby').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('gameover').classList.add('hidden');
  }

  renderTeams(players, you, phase) {
    this.players = players; this.you = you;
    const box = $('teams'); box.innerHTML = '';
    for (const t of [0, 1]) {
      box.appendChild(el('h3', null, `${t === 0 ? '红方' : '蓝方'}`));
      for (const p of players.filter((x) => x.team === t)) {
        const row = el('div', 'pslot' + (p.id === you ? ' me' : ''));
        row.innerHTML = `<i class="rd ${p.ready ? 'on' : ''}"></i><span>${esc(p.name)}</span>`;
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
    // A sub-page of the card belongs to the *selected unit*, not to the frame that rebuilt
    // it: snapshots re-render this every tick, so resetting on every call would close the
    // peasant's building page before a single click landed. It resets when the selection
    // changes to a different unit.
    const changed = !this.unitSel || this.unitSel.i !== ent.i;
    this.unitSel = ent;
    if (changed) this.buildMenu = false;
    this.inventoryHero = null;
    $('respawn').classList.add('hidden');
    $('pname2').textContent = ent.name || ent.u || '';
    $('heroClass').textContent = '';
    // RTS 建造中: 农民选择卡显示建筑进度
    if (ent.bld) {
      const bn = UNIT_CARD[ent.bld.type];
      $('heroClass').textContent = `建造中: ${bn ? bn.name : ent.bld.type} ${ent.bld.pct}%`;
    }
    for (const [bar, text, value, max] of [['hpbar', 'hptext', ent.h, ent.H], ['mpbar', 'mptext', ent.m, ent.M]]) {
      $(bar).style.width = `${100 * Math.max(0, Math.min(1, (value || 0) / (max || 1)))}%`;
      $(text).textContent = max ? `${Math.round(value || 0)} / ${Math.round(max)}` : '';
    }
    $('xpbar').style.width = '0%';
    $('stats').replaceChildren();
    $('inventory').replaceChildren();
    // The card, and the card only. There used to be a second panel for this -- a row of
    // bordered HTML buttons spelling out "Farm 80 gold / 35s", floating to the right of the
    // minimap. Warcraft III has no such panel: a command card is twelve openings in the
    // console's own art, four across and three down, each holding an icon and nothing else.
    // So the buildings and the trained units went into that panel, and the official twelve
    // cells stayed empty, which is what "the official UI is not showing" meant in the end --
    // it was being drawn the whole time, with nothing in it.
    if (this.canCommand?.(ent)) {
      this.renderAbilities({ alive: !!ent.a, mana: ent.m || 0,
                             skillPoints: 0, abilities: this.cardAbilities(ent) });
    } else {
      $('abilities').replaceChildren();
    }
  }

  renderAbilities(h) {
    this._cardH = h;
    renderCard(this, h, T);
  }

  // Rebuild the current selection's card from scratch. The card's sub-pages (the skill menu,
  // the building menu) call this to change page; renderSelected does the same on a new
  // selection, so there is one shape an h ever has.
  rebuildCard() {
    const ent = this.unitSel;
    if (ent) this.renderAbilities({ alive: !!ent.a, mana: ent.m || 0,
                                    skillPoints: 0, abilities: this.cardAbilities(ent) });
  }

  /**
   * What the selected unit's card offers, in the shape renderCard draws.
   *
   * renderCard (upstream, unchanged) is the whole of Warcraft III's command card: it lays the
   * five orders into the cells CommandFunc names, puts each entry in the cell AbilityFunc's
   * Buttonpos gives it, greys what cannot be afforded, sweeps a cooldown over the rest, and
   * keeps the buttons attached between snapshots so a click is not dropped between the press
   * and the release. It takes one list and draws every element of it as an ability.
   *
   * Warcraft III's card is not hero-only: a priest's Heal sits in it beside the orders, and a
   * peasant's buildings sit in it too. So all three go into that one list, in the order the
   * game fills a card -- the unit's spells first, then what it produces, then what it builds.
   *
   * Nothing here picks a cell or draws anything.
   */
  cardAbilities(ent) {
    const strings = this.hudData?.strings || {};
    const out = [];

    // -- the unit's own spells, as the castable list the snapshot carries in `ab`
    for (const id of (Array.isArray(ent.ab) ? ent.ab : [])) {
      const meta = ABIL_META[id];
      if (!meta) continue;
      const L = (meta.levels && meta.levels[0]) || {};
      const s = strings[id] || {};
      out.push({
        id, kind: 'spell', spell: true,
        icon: ABIL_ICONS[id],
        lvl: 1, maxLvl: 1, reqLevel: 0, levelSkip: 0, cdLeft: 0,
        info: { mana: L.mana || 0, cooldown: L.cooldown || 0 },
        hotkey: s.hotkey || '',
        name: s.name || id,
        // The archives' own text, with the colour escapes and the <Ahea,DataA1> value
        // references taken out. The game substitutes the numbers from the ability's data
        // slots; those are left out rather than guessed at.
        desc: String(s.tip || '').replace(/\|c[\da-f]{8}|\|r/gi, '').replace(/\|n/g, '\n')
              .replace(/<\w+,[\w,]+>/g, '').trim(),
        // A melee map has no hero, so renderCard's `onCastSlot` path (which resolves
        // the slot against the hero's own card) returns before anything is armed.
        // Spell buttons must arm the *unit* cast path instead -- the same castUnit
        // message the server already handles for non-hero units -- otherwise a
        // priest's Heal or a footman's Defend is visible but dead.
        run: () => this.onUnitCast?.(id),
      });
    }

    // -- what it produces and what it builds: Units\*UnitFunc.txt, all four races.
    // `Trains` is the field the current tables use and `Sellunits` is what the same list is
    // called in the older ones; eleven types carry only that, so it is read as the fallback
    // rather than as a second list, which would put every unit on a Barracks' card twice.
    const type = UNIT_CARD[ent.u] || {};
    const offer = (kind, list, run) => {
      for (const id of (list || [])) {
        const t = UNIT_CARD[id];
        if (!t) continue;
        out.push({
          id: `${kind}:${id}`, kind, run,
          icon: ICON_PATHS[id],
          lvl: 1, maxLvl: 1, cdLeft: 0,
          name: t.name || id,
          desc: [t.gold != null ? `费用: ${t.gold} 金` : '',
                 t.buildTime ? `建造时间: ${t.buildTime} 秒` : '',
                 t.foodMade ? `人口: ${t.foodMade}` : ''].filter(Boolean).join('\n'),
        });
      }
    };
    offer('train', type.trains?.length ? type.trains : type.sellsUnits, (id) => this.onTrain?.(id));
    if (this.buildMenu) {
      // The building page: every building the unit can make, which is more than the card
      // holds on one page. renderCard fills cells row by row and spills the rest onto the
      // lowest free cell, and the corner is Cancel, which closes the page.
      offer('build', type.builds, (id) => this.onBuild?.(id));
    } else if (type.builds?.length) {
      // The main page: a single Build command, at the cell CommandFunc.txt gives it
      // (CmdBuildHuman Buttonpos = 0,2), with the archives' own icon. Warcraft III shows
      // a peasant eleven buildings through one button rather than eleven buttons.
      out.push({
        id: 'buildMenu', kind: 'build', spell: false, pos: [0, 2],
        icon: BTN_ICONS.btnbasicstruct,
        lvl: 1, maxLvl: 1, cdLeft: 0, name: '建造',
        desc: '建造建筑。',
        run: () => { this.buildMenu = true; this.rebuildCard(); },
      });
    }
    return out;
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
      return `<tr><td>${esc(p.name)}</td>
              <td>${p.team === 0 ? '红方' : '蓝方'}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`;
    }).join('');
    s.innerHTML = `<table><tr><th>Player</th><th>Team</th><th>K</th><th>D</th></tr>${rows}</table>`;
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
      g.fillStyle = (youId != null && e.p === youId) ? '#ffe680' : e.t === 0 ? '#5aa9e6' : e.t === 1 ? '#e2564d' : '#9a9a9a';
      const r = (youId != null && e.p === youId) ? 3.5 : e.k === 2 ? 3 : 2.5;
      g.beginPath(); g.arc(px, py, r, 0, 6.284); g.fill();
    }
  }
}
