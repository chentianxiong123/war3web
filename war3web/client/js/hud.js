// Classic console controls. Data comes from tools/hud_assets.py, not the lobby.
export const COMMANDS = [
  ['move', 'Move', 'M', 0, 'Orders the unit to move to the target location.'],
  ['stop', 'Stop', 'S', 1, 'Cancels the current order.'],
  ['hold', 'Hold Position', 'H', 2, 'Stand still and attack enemies within range. Do not chase.'],
  ['attack', 'Attack', 'A', 3, 'Attack a unit, or move to a location engaging enemies along the way.'],
  ['patrol', 'Patrol', 'P', 4, 'Travel between the current position and a target location, engaging enemies.'],
];
// 人族技能图标 (官方 CommandButtons 图; abilities.json 的 icon 列在中文版 slk 缺失,
// 用 Id->图 映射补齐 — 文件名就是官方图标名)
const SKILL_ICONS = {
  Ahea: 'BTNHeal', Ainf: 'BTNInnerFireOn', Adis: 'BTNDispelMagic', Aslo: 'BTNSlow',
  Aivs: 'BTNInvisibility', Aply: 'BTNPolymorph', Adef: 'BTNDefend',
};

export function initHud(ui) {
  ui.hudData = { art: {}, abilities: {} };
  ui.skillMenu = false;
  const tip = document.createElement('div');
  tip.id = 'wcTooltip'; tip.className = 'hidden'; tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  // Delegate hover: snapshots replace card elements, so per-element mouseleave
  // handlers would leave a stale tooltip behind after every update.
  let pointer = { x: -1, y: -1 };
  const refresh = () => {
    const node = document.elementFromPoint(pointer.x, pointer.y)?.closest('[data-tooltip]');
    if (!node || document.getElementById('hud').classList.contains('hidden')) {
      tip.classList.add('hidden'); return;
    }
    tip.textContent = node.dataset.tooltip;
    tip.classList.remove('hidden');
  };
  document.addEventListener('pointermove', e => { pointer = { x: e.clientX, y: e.clientY }; refresh(); });
  document.addEventListener('pointerout', e => { if (!e.relatedTarget) { pointer.x = -1; refresh(); } });
  ui.refreshTooltip = refresh;
  const chat = document.createElement('input');
  chat.id = 'wcChat'; chat.className = 'hidden'; chat.maxLength = 200;
  chat.placeholder = '发给所有人:'; chat.setAttribute('aria-label', '发送给所有玩家');
  document.getElementById('hud').appendChild(chat);
  chat.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      if (chat.value.trim()) ui.net.send({ t: 'chat', text: chat.value.trim() });
      chat.value = ''; chat.classList.add('hidden'); chat.blur();
    } else if (e.key === 'Escape') { chat.classList.add('hidden'); chat.blur(); }
  });
  ui.openChat = () => { chat.classList.remove('hidden'); chat.focus(); };
  ui.closeDialog = () => document.getElementById('wcDialog')?.remove();
  ui.openDialog = (kind) => {
    ui.closeDialog();
    const host = document.createElement('div'); host.id = 'wcDialog';
    const panel = document.createElement('section'); panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', kind);
    const title = document.createElement('h2'); title.textContent = kind;
    panel.appendChild(title);
    const text = (value, tag = 'p') => { const n = document.createElement(tag); n.textContent = cleanText(value); panel.appendChild(n); return n; };
    if (kind === 'Quests') {
      if (!ui.quests?.length) text('No quests have been discovered.');
      for (const quest of ui.quests || []) {
        text(quest.title, 'h3'); text(quest.description);
        for (const item of quest.items || []) text(`${item.completed ? '✓' : '•'} ${item.description}`);
      }
    } else if (kind === 'Allies') {
      for (const player of ui.players) text(`${player.name} — Team ${player.team + 1}`);
    } else {
      const score = text('Scoreboard', 'button');
      score.onclick = () => { ui.closeDialog(); ui.onShowScore?.(true); };
      const label = text('Sound Volume', 'label');
      const volume = document.createElement('input'); volume.type = 'range'; volume.min = 0; volume.max = 1; volume.step = .05;
      volume.value = ui.getVolume?.() ?? .55; volume.setAttribute('aria-label', 'Sound volume');
      volume.oninput = () => ui.setVolume?.(Number(volume.value)); label.appendChild(volume);
    }
    const close = document.createElement('button'); close.textContent = 'Return to Game (Esc)';
    close.onclick = ui.closeDialog; panel.appendChild(close); host.appendChild(panel); document.body.appendChild(host); close.focus();
  };
  fetch('/data/hud.json').then(r => {
    if (!r.ok) throw new Error('HUD data missing; run tools/hud_assets.py');
    return r.json();
  }).then(data => {
    ui.hudData = data;
    if (ui.hero) ui.updateHero(ui.hero);
  }).catch(e => console.error(e));
}

function cleanText(value) {
  return String(value || '').replace(/\|c[\da-f]{8}|\|r/gi, '').replace(/\|n/g, '\n');
}

export function renderCard(ui, h, translate) {
  const box = document.getElementById('abilities');
  const next = document.createDocumentFragment();
  const occupied = new Set();
  const add = (key, label, image, desired, action, disabled = false) => {
    let cell = desired;
    if (occupied.has(cell)) cell = Array.from({ length: 12 }, (_, i) => i).find(i => !occupied.has(i));
    if (cell == null || cell < 0 || cell > 11) return null;
    occupied.add(cell);
    const node = document.createElement('button');
    node.className = 'slot' + (disabled ? ' unavailable' : '');
    node.dataset.cell = cell; node.dataset.command = key; node.dataset.tooltip = label;
    node.setAttribute('aria-label', label.split('\n')[0]);
    node.setAttribute('aria-disabled', String(disabled));
    if (image) node.style.backgroundImage = `url("${image}")`;
    node.onclick = e => { if (!disabled) action(e); };
    next.appendChild(node);
    return node;
  };
  const art = key => ui.hudData.art[key] || `/assets/ui/${key}.png`;
  if (ui.skillMenu) {
    add('cancel', 'Cancel (Esc)\nReturn to the command menu.', art('cancel'), 11, () => {
      ui.skillMenu = false; ui.renderAbilities(ui.hero);
    });
  } else {
    for (const [key, name, hotkey, cell, desc] of COMMANDS) {
      add(key, `${name} (${hotkey})\n\n${desc}\nHold Shift to queue.`, art(key), cell, e => ui.onCommand?.(key, e.shiftKey), !h.alive);
    }
    if (h.skillPoints > 0) {
      const n = add('skill', `Hero Abilities (O)\n\nSelect an ability to learn.\nSkill points remaining: ${h.skillPoints}`,
        art('skill'), 7, () => { ui.skillMenu = true; ui.renderAbilities(ui.hero); });
      if (n) n.classList.add('learnable');
    }
  }
  h.abilities.forEach((a, i) => {
    if (ui.skillMenu ? a.innate || a.lvl >= a.maxLvl : a.lvl < 1) return;
    const layout = ui.hudData.abilities[a.id];
    const pos = layout?.[ui.skillMenu ? 'research' : 'button'] || [i % 4, ui.skillMenu ? 0 : 2];
    const canLearn = h.skillPoints > 0 && a.lvl < (a.cap ?? a.maxLvl);
    const disabled = ui.skillMenu ? !canLearn : !h.alive || a.cdLeft > 0 || (a.info?.mana || 0) > h.mana;
    const key = String(a.key || a.hotkey || '').toUpperCase();
    const required = a.reqLevel + a.lvl * a.levelSkip;
    const label = `${translate(a, 'name')}${key ? ` (${key})` : ''} - Level ${ui.skillMenu ? a.lvl + 1 : a.lvl}`;
    const text = `${label}\n${a.info?.mana ? `\nMana: ${a.info.mana}` : ''}${a.info?.cooldown ? `\nCooldown: ${a.info.cooldown} seconds` : ''}\n\n${translate(a, 'desc') || ''}`
      + (ui.skillMenu && !canLearn ? `\n\nRequires hero level ${required}${h.skillPoints ? '' : '\nRequires a skill point'}` : '');
    const n = add(`ability-${i}`, text, a.icon ? `/assets/${a.icon}` : (SKILL_ICONS[a.id] ? `/assets/textures/ReplaceableTextures/CommandButtons/${SKILL_ICONS[a.id]}.png` : null), pos[0] + pos[1] * 4,
      () => {
        if (ui.skillMenu) {
          ui.net.send({ t: 'learn', slot: i }); ui.skillMenu = false;
        } else ui.onCastSlot?.(i);
      }, disabled);
    if (n && !ui.skillMenu && a.cdLeft > 0) {
      const sweep = document.createElement('span'); sweep.className = 'cooldown-sweep';
      const fraction = Math.min(1, a.cdLeft / Math.max(a.cdLeft, a.info?.cooldown || 0.01));
      sweep.style.background = `conic-gradient(rgba(0,0,0,.78) ${fraction * 360}deg, transparent 0)`;
      n.appendChild(sweep);
    }
  });
  // Keep buttons attached between snapshots. Replacing a button between the
  // pointer-down and pointer-up events drops real mouse clicks.
  // Only this card's own buttons are keyed by command. The shop lays its stock
  // into these same cells and marks none of it, so a `new Map` over every child
  // collapsed the whole stock onto one `undefined` key and left all but the last
  // cell behind: coming back from a shop showed 17 cells, the twelve that belong
  // here and five items still for sale. Anything without a command is not ours.
  const old = new Map();
  for (const n of [...box.children]) {
    if (n.dataset.command) old.set(n.dataset.command, n);
    else n.remove();
  }
  for (const node of [...next.children]) {
    const existing = old.get(node.dataset.command);
    if (existing) {
      old.delete(node.dataset.command);
      existing.className = node.className;
      existing.dataset.cell = node.dataset.cell;
      existing.dataset.tooltip = node.dataset.tooltip;
      existing.setAttribute('aria-label', node.getAttribute('aria-label'));
      existing.setAttribute('aria-disabled', node.getAttribute('aria-disabled'));
      existing.style.backgroundImage = node.style.backgroundImage;
      existing.onclick = node.onclick;
      existing.replaceChildren(...node.childNodes);
    } else box.appendChild(node);
  }
  for (const node of old.values()) node.remove();
  ui.placeCard(); ui.refreshTooltip?.();
}
