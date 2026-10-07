import io

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    n = 0
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new)
            n += 1
        else:
            print(f'  [missing] {old[:50]!r} in {path}')
    open(path, 'w', encoding='utf-8').write(s)
    print(f'{path}: {n}/{len(pairs)} replaced')

base = '/mnt/shared/war3/foc-web/client/'

# ---- index.html 静态文本 ----
patch(base + 'index.html', [
    ('<title>FOCS — Fight of Characters Second</title>', '<title>魔兽争霸3 · Terenas 对战</title>'),
    ('<h1>FOC<span>S</span> <small>Fight of Characters Second — 2.0</small></h1>',
     '<h1>魔兽争霸<span>3</span> <small>Terenas 之战 — 官方对战</small></h1>'),
    ('<p class="dim">Select a character.</p>', '<p class="dim">等待开始…</p>'),
    ('placeholder="your name"', 'placeholder="你的名字"'),
    ('<button id="btnTeam0">Join Team 1</button>', '<button id="btnTeam0">加入红方</button>'),
    ('<button id="btnTeam1">Join Team 2</button>', '<button id="btnTeam1">加入蓝方</button>'),
    ('<button id="btnReady" class="primary">Ready</button>', '<button id="btnReady" class="primary">准备</button>'),
    ('<div class="score"><b id="k0">0</b><span>Team 1</span></div>', '<div class="score"><b id="k0">0</b><span>红方</span></div>'),
    ('<div class="score-mid" id="scoreMid">first to 100 kills</div>', '<div class="score-mid" id="scoreMid">Terenas 对战</div>'),
    ('<div class="score"><span>Team 2</span><b id="k1">0</b></div>', '<div class="score"><span>蓝方</span><b id="k1">0</b></div>'),
])

# ---- ui.js ----
patch(base + 'js/ui.js', [
    ("box.appendChild(el('h3', null, `Team ${t + 1}`));",
     "box.appendChild(el('h3', null, `${t === 0 ? '红方' : '蓝方'}`));"),
    ("$('scoreMid').textContent = `first to ${killsToWin} kills`;",
     "$('scoreMid').textContent = `先到 ${killsToWin} 击杀`;"),
    ("$('heroClass').textContent = `Level ${h.level} ${T(h, 'title')}`;",
     "$('heroClass').textContent = `等级 ${h.level} ${T(h, 'title')}`;"),
    ("[['str', 'Strength'], ['agi', 'Agility'], ['int', 'Intelligence']]",
     "[['str', '力量'], ['agi', '敏捷'], ['int', '智力']]"),
    ("`${winner != null ? `Team ${winner + 1} wins` : 'Match over'}`",
     "`${winner != null ? `${winner === 0 ? '红方' : '蓝方'}获胜` : '比赛结束'}`"),
    ("<td>Team ${p.team + 1}</td>", "<td>${p.team === 0 ? '红方' : '蓝方'}</td>"),
])

# ---- main.js ----
patch(base + 'js/main.js', [
    ("document.getElementById('btnReady').textContent = 'Ready';",
     "document.getElementById('btnReady').textContent = '准备';"),
    ("S.ready ? 'Not ready' : 'Ready'", "S.ready ? '取消准备' : '准备'"),
])

# ---- hud.js ----
patch(base + 'js/hud.js', [
    ("chat.placeholder = 'To All:';", "chat.placeholder = '发给所有人:';"),
    ("chat.setAttribute('aria-label', 'Chat to all players');",
     "chat.setAttribute('aria-label', '发送给所有玩家');"),
])

print('done')