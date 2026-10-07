# FOC Web — *Fight of Characters 7.7b* in the browser

A browser port of the Warcraft III community map **Fight of Characters**, running on an
authoritative Node server with a Three.js top-down 3D client. Powered by a JASS VM running the real map scripts from the w3x file in real time. 


**🤖I handled direction, architecture choices such as the 1:1 trigger mapping, designing verification audits, review and QA. Everything else in this repository is LLM-generated including the code, the tooling, execution of the audits and this README. Written with Claude Code and Codex under an agentic workflow.** 🤖



# [Video](https://www.youtube.com/watch?v=vcHNVRgg-5s)
## Screenshots
### In-Game
<img width="1972" height="1242" alt="image" src="https://github.com/user-attachments/assets/db55897f-6fc9-4d6c-8628-42948e877d30" />

<img width="1388" height="1001" alt="image" src="https://github.com/user-attachments/assets/4ac8ee8f-648e-42e6-8520-9c402cca6483" />

<img width="1400" height="1013" alt="image" src="https://github.com/user-attachments/assets/3b671237-cb96-4624-9806-0b1024419321" />



### Character Selector
<img width="1427" height="961" alt="image" src="https://github.com/user-attachments/assets/ad184b37-ff8d-4110-b831-459a308856f1" />






Currently built against `fight_of_characters 7.7b E.w3x` — but the pipeline is
**map-agnostic**: no hero, ability, unit or region id is hardcoded anywhere. Point it at a
different FOC map and rebuild (see [Switching maps](#switching-maps)).

Every asset and every number in this project is **extracted from the original `.w3x` and the
retail Warcraft III archives** — nothing is hand-drawn or invented. The game logic is not
reimplemented: the map's own JASS script runs in a JASS virtual machine on the server.

```
<map>.w3x + War3*.mpq  ──►  tools/ (extraction + conversion)  ──►  public/ (runtime assets)
                                                                    │
                                       server/ (authoritative sim) ─┴─ client/ (Three.js)
```

## What is in this repository

**Source only.** The pipeline, the server, the client — about a megabyte of code.

It does **not** contain, and cannot legally redistribute, any of the following:

- **Warcraft III's archives** (`war3.mpq`, `War3x.mpq`, `War3Patch.mpq`, `War3xlocal.mpq`) —
  Blizzard's property. Bring your own retail install.
- **The map** (`fight_of_characters 7.7b E.w3x`) — its author's work.
- **Anything derived from either**: the extracted scripts and object data, the converted models,
  textures and sounds, the compiled tables. All of it is regenerated from your own copies by the
  build, which is why `assets/`, `data/`, `public/`, `extracted/` and `war3_extracted/` are
  ignored rather than committed. Together they are roughly 1.4 GB.

So this repository is the *machinery*: point it at your own copy of the game and the map, run the
build, and it produces a playable port. Nothing here is useful without them.

**Licence** — [MIT](LICENSE), and it covers the machinery only: `tools/`, `server/`, `client/`,
`shared/` and the documentation. It does not extend to Blizzard's data and art, or to the map,
for the reason above — neither is mine to license and neither is in this repository. `LICENSE`
says the same at more length, including the small quotations of the map's own text that appear in
source comments to explain what a piece of code is looking at.

## Quick start

```bash
npm install
npm start                      # http://localhost:8080   (PORT=8081 npm start to change)
npm test                       # the whole suite; starts its own server
```

Open the page in two or more tabs, pick a character, hit **Ready**. The match starts when
every player in a team slot is ready.

Rebuild everything from the map file:

```bash
python3 -m venv .venv && .venv/bin/pip install numpy pillow
bash tools/pipeline.sh
```

The retail archives (`War3Patch.mpq`, `War3x.mpq`, `war3.mpq`, and the `*local` ones if you
have them) go next to the `.w3x`. They are read in Warcraft III's own priority order by
`tools/gamedata.py`.

Besides Python, the pipeline shells out to four things and fails loudly without them:

| | |
|---|---|
| **ffmpeg**, built with libvorbis | 6 192 sounds → Ogg. Check with `ffmpeg -encoders \| grep vorbis` — an ffmpeg without it converts nothing. |
| **fluidsynth 2.x** | the ambient themes are not clips: they are a MIDI score plus the DLS instrument bank it is played on, rendered once here. Without it they stay silent and nothing else is affected. |
| **Node 20.11+** | the trigger prober, the portrait bake and every test |
| **Chromium** | step 8 renders each hero's own model for the lobby. `CHROME=/path/to/chrome` if it is not on one of the usual paths (`tools/chrome.mjs` lists them). |

Step 8 starts a server on 8077 for the length of the portrait bake and stops it again;
`FOC_PORT` moves it. The last step verifies the build — the cliff geometry, a full script
boot and a trigger audit — and now exits nonzero when any of them is unhappy. The whole
test suite is `npm test`, which starts its own server and runs everything.

## Controls

| Input | Action |
|---|---|
| Left click | Move |
| Right click | Attack unit / attack-move to point |
| Ability hotkeys | **the map's own** (`ahky`), printed on each button — most heroes do not use plain `QWERDF` |
| Click the green `+` | Spend a skill point (right-click an icon also works) |
| `S` | Stop · `B` Shop · `Space` centre on hero · `Tab` scoreboard |
| Middle-drag | Pan camera · wheel zooms · double-click re-follows hero |

## What comes out of the map

| | |
|---|---|
| Files recovered from the protected `.w3x` | **268**, including 155 imported assets |
| Heroes | **26**, with **130** abilities carrying real names, tooltips, cooldowns, mana and damage |
| Unit types | **997** (the map's on top of Warcraft III's), **968** with a converted model |
| Abilities | **1 046**, with the art and missile data Warcraft III draws for them |
| Items | **332** resolved types (Blizzard's on top of the map's), **47** sold in shops |
| Missiles | **375** unit types with a weapon missile: art, speed, arc and homing |
| Models | **1 105** MDX → glTF 2.0 `.glb` |
| Textures | **1 902** BLP/TGA → PNG |
| Sounds | **6 192** Storm-compressed clips → Ogg, plus the map's 60 imported MP3s |
| Terrain | 97 × 65 vertices, Cityscape tileset, 9 ground textures, real per-cell tile indices |
| Cliffs | **502** layer transitions → **498** Blizzard cliff meshes (54 distinct) + 4 ramp cells |
| Pathing | 384 × 256 walkability grid straight from `war3map.wpm` (59 % walkable) |
| Layout | Team bases, 5 shops, spawn points and camera bounds, all read from the map's own script |

The map is **protected**: its `(listfile)` was replaced with a stub, `war3map.j` was renamed,
and every file is MPQ-encrypted. `tools/mpq.py` handles this end to end:

1. **Header** — the `headerSize` field is corrupted by the protector; the hash/block table
   offsets are intact and self-consistent, so the header is parsed with a fixed 32-byte size.
2. **Encryption** — every file is encrypted with a key derived from its *filename*, which the
   protector deleted. Where the name cannot be mined out of the map data, the key is recovered
   by known-plaintext attack on the encrypted sector-offset table (`crack_key`): the first
   offset is always `(numSectors+1) × 4`, which pins the low byte of the key and yields the rest.
3. **Filenames** — since the file key *is* `hash(plainName)`, candidate strings mined from the
   decrypted contents are hashed and matched back against the cracked keys.

MPQ resolves names by hash, so a file can be readable even when nothing lists it. The extractor
probes the archives directly for anything the script references, which is how assets missing from
every listfile (spell effects, `TerrainArt\Water.slk`) still get pulled.

## Architecture

`war3map.j` is thousands of functions and hundreds of triggers. Porting that by hand silently
loses things, so instead the script runs verbatim:

```
server/jass/parse.js    JASS lexer + parser -> AST
server/jass/vm.js       generator-based interpreter (JASS threads can sleep)
server/jass/engine.js   handles, trigger/timer scheduler, event dispatch, 1102 natives
server/jass/boot.js     loads common.j + Blizzard.j + tft_supplement.j + war3map.j
server/world.js         engine-level simulation (movement, pathing, auto-attack, damage)
server/abilities.js     the base Warcraft III abilities, driven by the map's own data
```

The split follows Warcraft III itself. Anything the *engine* does — unit movement, acquisition
and leashing, auto-attack, damage and armour, base ability behaviour — lives in `world.js` and
`abilities.js`. Anything the *map* does — creep waves, duels, scoring, every spell's bespoke
effects — is the map's own script, executed as written.

At boot the VM runs `config()` and `main()` as Warcraft III would: **278 triggers, 28 timers,
120 units created, 0 errors**.

The rest of the walkthrough — how a spell runs end to end, ability overrides, spell art,
particles, team colour, the clock, shadows, ribbons, missiles, translation, items, unit
enumeration, targeting, the client, and the audit tooling — is in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

Four sections stay here instead. They are the shortest honest answer to "is this
really running the map rather than imitating it": each is a case where the obvious
reimplementation would have been wrong, and the map's own data said so.

### Creep waves, and one falsy zero

The map runs three creep waves as periodic triggers, and they **escalate rather than stack**:

| beat | roster | bodies |
|---|---|---|
| 30 s | gnolls, nagas, spiders | 42 |
| 60 s | bandits, priests, grunts, footmen, knights, wizards | 68 |
| 90 s | bloodfiends, tauren, necromancers, ghosts, doom guards | — |

```jass
call BO(300.)                       // five minutes in
call DisableTrigger(udg_trigger43)  // 30s wave off
call EnableTrigger(udg_trigger45)   // 60s wave on
call BO(900.)                       // fifteen minutes later
call DisableTrigger(udg_trigger45)
call EnableTrigger(udg_trigger46)   // 90s wave on
```

Nothing here schedules creeps; the map's own triggers do, and the 30-second wave was already exact
— ten waves in five minutes, each at 30.0 s, each 42 bodies, matching the roster count. The
handover never happened, though, and the cause was one character in this port:

```js
TimerGetElapsed: (t) => (t ? (eng.now - (t.started || eng.now)) / 1000 : 0)
```

The map starts its stopwatch during init, so `started` is **0** — falsy — and `started || eng.now`
falls through to now, reporting zero elapsed *forever*. `BO` is the map's own polled wait: it
subtracts elapsed from its target and loops until the remainder reaches zero, so with a stopwatch
frozen at zero it never converges. `?? ` instead of `||` fixes it, and the handover then lands
between 299 s and 310 s exactly as scripted.

The blast radius is the part worth remembering: **`BO()` is called at 193 sites**. It is the map's
universal wait, behind every staged sequence in the game, and all of them were hanging on a
timestamp that happened to be zero.

`tools/spawn_test.mjs` watches the waves land and checks the beat and the body count.

### Dummy units, and a leak that is the map's own

Warcraft III maps cast most of their bespoke spells through **dummy units**: an invisible helper is
created, ordered to cast, and discarded. They are invisible because they carry Locust and name a
model that does not exist — and this map writes that name four different ways in Korean (`없다`,
`없음`, `업다`, `읎지여`), so matching the spelling is a losing game. What settles it is that the
unit is Locust *and* names no model that was ever converted.

The client used to draw a stand-in mesh for any unresolvable model — deliberately, so missing art
is visible rather than silently absent — which for a dummy is exactly wrong: it walks the
battlefield as a grey capsule. **27 of this map's unit types would have shown that way.** Byakuya's
Senka is where it was noticed.

The dummy it creates is never removed:

```jass
call CreateNUnitsAtLoc(1,'h005', owner, loc, bj_UNIT_FACING)
set udg_unit05 = bj_lastCreatedUnit
call IssueImmediateOrderById(udg_unit05, 852127)
```

No `RemoveUnit`, no `UnitApplyTimedLife` on that path, though the map calls both elsewhere — so it
leaks one unit per cast in the original game too, invisibly. Measured here: twenty casts, twenty
dummies, none removed.

They are left in the simulation, because a trigger that counts units of a type would notice if they
disappeared and the map's behaviour is the thing being reproduced. What changed is only that
`snapshot()` no longer sends them: the client has nothing to draw for a dummy, so transmitting one
is pure cost. Twenty casts took the wire from 62 entities to 42, every one of the remainder a real
creep.

### Changing form

Metamorphosis (`AEme`) and Chemical Rage (`ANcr`) genuinely replace the unit: the ability's `unit`
field names the alternate form, and Warcraft III swaps it back when the buff ends. That is why
they carry no effect art — the new body *is* the effect. Approximating it with a damage buff left
nine heroes' whole transformation as a number going up quietly.

`World.morph` swaps the type-derived fields and `unmorph` puts them back. The hero keeps its
identity across the change — same level, experience, skills and inventory — and life and mana
carry as *fractions*, so entering a form with a larger pool does not heal you for the privilege
and leaving one does not kill you. On the client a unit's view is built once from the model its
type names, so `main.js` rebuilds it when the type underneath it changes.

An order string is also not proof that an ability can be cast. Warcraft III gives its passive
skills one — Attribute Bonus answers to `attributemodskill` — because the skill tree needs
something to name. What separates them is the icon: passive art lives under
`ReplaceableTextures\PassiveButtons`, and nothing castable does. Reading the order alone meant the
engine "cast" a permanent stat bonus, found a number in its data and threw it at the target as
damage, and no hero ever received the stats. They are now applied in `recalc`, next to the item
bonuses, from the same three data slots the stat tomes use.

The converse is not true either, and reading it as though it were disabled a spell. An order
string proves an ability can be ordered; its *absence* proves nothing, because Blizzard writes
`Order=` into `Units\*AbilityFunc.txt` for only some abilities — Fire Bolt, Finger of Death,
Cloak of Flames and Neutral Regen each carry an `Art=` line and no order at all, and 462 of the
map's 1046 abilities are in that position. The map settles it: two of them raise
`EVENT_PLAYER_UNIT_SPELL_EFFECT` in `war3map.j`, so they are plainly cast. `isPassive` now lets
an empty order fall through to the targets the ability declares, and the four bases above are
named passive on the evidence of how the map itself hands them out rather than on the missing
field. `tools/passive_test.mjs`, 20 checks.

### Where the numbers come from

Gameplay constants are layered exactly as the game layers them: `Units\MiscGame.txt` from the
archives, then **the map's own `war3mapMisc.txt` on top**. This map overrides 16 of them,
including `MaxHeroLevel=50`, `DefenseArmor=0.02` and every hero stat bonus — reading only the
Blizzard tables gets all of them wrong.

Warcraft III derives life from strength, mana from intelligence and armour from agility for every
hero, but **attack damage from that hero's own primary attribute**. This map leans on that: it sets
a base template granting +15 to every attribute per level and then overrides each hero on top, so a
hero who never overrides the strength gain still carries +15 strength a level. Reading damage off
strength rather than the primary attribute therefore does not misprice heroes slightly -- it
roughly doubles some of them. `tools/hero_audit.mjs` prints every hero's attributes and what the
engine derives from them at levels 1, 25 and 50, and flags the heroes whose largest gain is not
their primary attribute.

A map's `war3map.w3u` carries two independent tables, and they must stay independent. The
"original" table edits the standard Warcraft III units; a custom unit inherits the **default**
values of its base, not the author's edits to that base. Chaining them hands a hero whatever was
done to the standard unit it was built from — and this map edits `Ulic`, `Obla`, `Oshd` and `Hmkg`
into 700-damage, 7500-life templates for its own use elsewhere, which gave exactly the five heroes
derived from them 210–760 base damage at level 1 while the other twenty-one sat on Blizzard's 0.
Reading the tables independently puts the whole roster on 60 damage at level 1, bar the boss and
the one hero who sets his own.

Field ids have to come from `Units\\UnitMetaData.slk` rather than a guess, for units exactly as for
abilities. `ucbs` is the cast backswing and `ucol` the collision radius; reading the first as the
second gave 25 of the 26 heroes a collision of `0.1` — the map's backswing value — and dropped the
real overrides on 127 units. `ua1z` is `Missilespeed`, not the attack's target list, and `umh1` is
`MissileHoming`, not a damage upgrade.

The same rule binds harder for **ability data slots**, because there is nothing to notice when it
is broken. Warcraft III stores no "damage" field: it stores `DataA..DataF`, and which of those
carries the damage depends on the base ability. `Units\\AbilityMetaData.slk` says so — its
`useSpecific` column names the bases each field belongs to and which slot it occupies — and
`UI\\WorldEditStrings.txt` turns the field id into the label a map author reads. Blizzard's own
`Hbz1` is **Number of Waves** and `Hbz2` is **Damage**; reading them the other way round leaves the
*total* damage correct and the shape unrecognisable, so a 30-wave ultimate ran as 1100 waves and
bombarded a 600 radius for eighteen minutes with nothing downstream able to tell. `ANcf` names no
fields of its own at all — its `code` column is `ANbf` — and `ANfd` keeps its damage in slot 3
behind two graphic-timing fields, so aliasing it to Death Coil made a 10,000-damage ultimate deal
0.25. `tools/slot_test.mjs` holds every case in `server/abilities.js` to the meaning the map
declares, and fails if a new case reads a slot without saying what it thinks the slot is.

Experience follows the documented `f(x) = A*f(x-1) + B*x + C` tables. Skill unlocks come from
each ability's own `reqLevel` / `levelSkip`, not a fixed every-other-level rule, so an ultimate
can legitimately want hero level 30.

## Switching maps

The pipeline finds the `.w3x` itself (`tools/mapfile.py`: `$FOC_MAP`, else the only map in the
directory, else the newest). Drop the new map in and run:

```bash
FOC_MAP="my map.w3x" bash tools/pipeline.sh
npm start
```

Everything downstream — heroes, abilities, items, shops, terrain, spawns, teams, win conditions,
gameplay constants — is derived from the map at build time. `tools/stage.py` rebuilds
`public/assets/{models,textures,sounds}` from scratch each run, so the previous map's files are
never served, and what can actually spawn comes from the map-derived tables rather than from
whatever happens to be on disk.

What still needs a look after a swap: heroes whose model path is empty in the map data, and any
ability the map drives through a mechanism the probe in `spell_targets.mjs` cannot see. Then run
`FOC_MAP_J=extracted/war3map.j node tools/ability_audit.mjs` — its dead-ability, buff-seam and
stub-native lists are the honest size of the new map's gap before anyone plays it.

## Status

**Working**

| | |
|---|---|
| Extraction | the protected `.w3x`, the four retail archives, models, textures, sounds, terrain, cliffs, pathing |
| Simulation | the map's own JASS script in a VM on the server; creep waves with acquisition ranges and guard leashing; duels; scoring; the multiboard; fountains; waygates; respawn |
| Combat | engine ability behaviour plus the map's own triggers; ranged attacks and spells with real missile travel time; damage, armour and auto-attack |
| Progression | hero picking, XP, levelling, skill unlocks, a six-slot inventory, shops, items that lie in the world and are walked to, powerups on contact, selling back at the map's own rate |
| Form changes | heroes that morph keep their level, skills and inventory across it |
| Destructables | the map's 115 walls, gates and trees stamp their real pathing footprints; a gate can be attacked, shudders when struck, plays its collapse, and opens the route it sealed |
| Buff art | a buff's target model hangs at its named attachment point for as long as the buff lasts — Ichigo's Hollow orb lands on his head, eight bones deep |
| Effects | particle emitters (without which ~80 of Warcraft III's effect models are empty), ribbon trails behind the blades of the seven heroes that carry them, omni lights, camera shake, ground shadows, ubersplats and splats, corpses that decay and leave bones |
| Model events | blood, footprints and thrown body parts fired from the model's own keyframes, and the footsteps, impacts and death cries on the same keys |
| Texture animation | beams flow, portals turn, flipbooks step — including the 52 materials that run on a clock of their own rather than on the playing sequence |
| Lightning | chain lightning, mana burn, drain and forked bolts, built from `LightningData.slk` rather than played as a model |
| Animation | chosen the way the game chooses it — the map's token sets weighted by rarity, honouring the Required Animation Names that decide, for one, that a tower is an arcane tower |
| Attachments | effects hung on the model's own attachment points instead of at the unit's feet |
| Presentation | Warcraft III's own console frame, minimap, blended terrain, animated water, stepped cliffs; the top strip carries the real resource bar and buttons, and the camera aims at the strip of screen the console leaves visible |
| Floating text | the map's 48 text tags — the spell name shouted over its caster, the duel's 3-2-1-Fight, "Winner is `<hero>`", the lane signboards standing beside each base — plus the engine's own: the bounty gold over a body, the critical strike's damage, and "miss". Colour, drift, lifetime and fade are read from `UI/MiscData.txt`, the word from `GlobalStrings.fdf`, and the typeface is the game's own Friz Quadrata |
| Camera and cinematics | the map's 39 scripted camera pans, each shown to the player it was aimed at; animation speed, so a haste or a channel plays at the rate the script asks for and the two units it freezes stay frozen; the full-screen cinematic wash an ultimate throws |
| Music and ambience | the map's own score, a looping four-minute track it starts when a mode begins and stops itself when a team wins; and the ambient theme under it, which is not a clip at all — Warcraft III keeps it as a MIDI score plus the DLS instrument bank it is played on, so the pipeline renders the pair once with the game's own bank and ships ogg |
| Day and night | the sun and ambient colours come from the two `DNC` models the map names, whose single light is animated across a sequence that *is* the day: warm at midnight, white from about 06:00 to 17:20. The fog is the map's own too — black from 3000 to 5000, where the renderer had been drawing its own blue from 4200 |
| Multiplayer | two players in one room, opposing teams, own colours, seeing each other's moves, chat and dropped items |

**Approximated or missing**

| | |
|---|---|
| Dead spells | `tools/ability_audit.mjs` prints the live list — currently 4 abilities with no engine case, no map trigger and no data fallback, all of them passives on summons, and the buff seams it checks alongside are down to none. A second check asks the harder question: `tools/unread_test.mjs` compares the slots each case reads against the slots the ability *declares*, over the whole roster, and every field the map filled in that nothing reads is either fixed or written down with a reason in `tools/unread_accepted.json` |
| Stub natives | a native the engine has never heard of is reported; one that exists with an empty body is not, which is how the text tags stayed invisible while every test passed. `tools/stub_audit.mjs` walks the other way, ranking every empty-bodied native by how much of the map runs into it: 214 of 506 are stubs, 54 of them reached across 314 call sites, down from 244 and 442 as the camera, animation speed, cinematic filter, music, ambience and day/night light were done |
| Ramp wedges | `CliffTrans` pieces are drawn as ordinary cliff walls, affecting the 20 cells flanking the two base ramps |
| `ParticleEmitter1` | parsed, exported, and spawns its pieces, but has never been confirmed to put a pixel on screen |
| Ribbon colour | a ribbon's colour and alpha over its life are not applied; its visibility track, and an emitter's visibility and emission rate, are |
| Attack backswing | a swing resolves the moment it starts, though the missile it throws now takes time to arrive |
| Pathing | A* over the map's real walkability grid, not Warcraft III's flow-field movement |
| The day/night clock | the light is the map's own, but the hour does not advance. How long a full day takes is in none of the files the archives supply, and the map never touches the clock, so the hour stays where a melee map starts rather than moving on a period invented here |
| Not implemented | fog of war; the sky model that goes with the day/night light; `TerrainDeformRipple`, the cosmetic shockwave — the craters it sits beside do work |

**Translation** — this map's text is Korean, and is now also carried in English by an
LLM-written overlay, `data/translations.ko-en.json`, kept deliberately outside the extraction: every hero title, ability
name and tooltip line the roster uses (25 titles, 128 names, 378 description lines,
nothing left over). `compile_game.py` emits the English *alongside* the map's own strings
rather than in place of them, the `EN` / `한` button chooses, and anything the overlay has
no entry for falls through to the original — so the map's text is never lost and never
guessed at. See [Translation](docs/ARCHITECTURE.md#translation).
