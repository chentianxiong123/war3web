# Warcraft III gameplay parity audit — 2026-09-13

Status: all six findings fixed on 2026-09-14. The sections below preserve the
original observations and evidence; their code line numbers refer to the audit
baseline. `tools/gameplay_parity_test.mjs` now asserts the corrected behavior
with 92 checks, and the diagnostic reports matching observed/expected results.

Implementation: explicit JASS attack/damage types reach damage resolution;
expired buffs recompute stats; regeneration uses map attributes and rate units;
weapon attacks roll every die and wait for the extracted damage point; controlled
heroes acquire targets while idle without inheriting creep leashes. Weapon timing
is preserved across morphs. A released projectile and its cooldown survive orders
that cancel the remainder of the attack animation.

Validation: gameplay_parity, carried, casttime, morph, numorder, proc,
spellshape, texttag, match, spell, victory and wincond tests passed. The casting
regression now expects idle acquisition after casting. Proc/text-tag fixtures
advance through windup before inspecting damage. No retail side-by-side capture
was run.

Six reproduced mismatches in shared gameplay rules follow. This was a focused
engine audit, not a hero-by-hero sweep.

Baseline: the bundled Warcraft III data and this map's overrides take precedence
over stock ladder numbers. For example, this map uses 0.1 strength/intelligence
regeneration bonuses and 0.75 spell damage against hero armor. Do not replace
those with values copied from a stock-game guide.

Run `node tools/gameplay_parity_probe.mjs` from the project root. It exercises the
real World methods and registered damage native with isolated units. It does not
start a server, boot map triggers, or run retail Warcraft III. The output reports
observations and expected behavior; exit zero means the diagnostic ran, not that
parity passed. Retail comparison remains useful for exact timing and edge cases.

## 1. Scripted attack types are ignored — high priority

- **Observed:** a 100-damage native call from a hero against zero-armor fortified
  armor deals 50 for both `ATTACK_TYPE_CHAOS` and `ATTACK_TYPE_HERO`.
- **Expected:** 100 for Chaos, 50 for Hero, using this map's compiled damage table.
- **Cause:** `server/jass/engine.js:694` passes `attackType` and `damageType`, but
  `server/world.js:939` chooses only between `opts.spell` and the source unit's
  attack type. Neither native parameter is consulted by the resolver.
- **Reachability:** `extracted/war3map.formatted.j:4764` is a real Chaos damage
  call. The script contains 22 literal Chaos/Normal pairs, plus other combinations.
  Blizzard's `UnitDamageTargetBJ` forwards the selected types to the native in
  `war3_extracted/Scripts/Blizzard.j:3834`.
- **Reference:** [Blizzard's attack/armor table](https://classic.battle.net/war3/basics/armorandweapontypes.shtml)
  distinguishes Chaos and Hero versus fortified armor; `data/gameplay.json`
  supplies the actual multipliers used for this map.
- **Repair criterion:** resolve the explicit attack type independently of the
  source unit's weapon. Add a separate damage-type policy with reference-backed
  tests for armor and immunity; this probe establishes the attack-type defect,
  not the correct behavior of every damage-type combination.

## 2. Expired buffs leave their stat changes behind — high priority

- **Observed:** Byakuya moves at 250, a 50% slow lowers him to 125, and after the
  timed buff is removed he still moves at 125. Probe advances 200 ms past a
  100 ms fixture duration and confirms the buff list is empty.
- **Expected:** expiration restores his unmodified 250 speed.
- **Cause:** `applyBuff` recalculates stats (`server/world.js:1406`), but the
  expiration filter at `server/world.js:2159` removes buffs without recalculating.
  Speed, attack speed, armor, damage and regeneration modifiers are stored by
  `recalc` rather than computed afresh every frame.
- **Reachability:** real spell handlers apply timed slows, including
  `server/abilities.js:336`. The short fixture duration merely makes the same
  expiry path easy to observe. Another stat recalculation may clear the lingering
  modifier; it is not necessarily permanent for the rest of the match.
- **Repair criterion:** recompute affected stats when a stat-changing buff ends,
  preserving any remaining buffs and items. Verify natural expiry separately
  from replacement and dispel.

## 3. Basic attacks skip the damage point — high priority

- **Observed:** `stepAttack` deals melee damage before world time advances at all.
  An immediate Stop cannot cancel that hit because it has already landed.
- **Expected:** a cancellable interval before the attack's damage point. Byakuya's
  map record explicitly declares `udp1 = 0.3`; 23 of the 26 roster heroes have
  that same explicit override. Attack-speed scaling affects the eventual timing.
- **Cause:** `tools/unittypes.py` reads spell cast points but drops weapon damage
  points. `server/world.js:2444` starts the attack and calls the melee payload,
  or launches its projectile, in the same invocation.
- **Primary data:** `war3_extracted/Units/UnitMetaData.slk:4149` maps `udp1` to
  `dmgpt1`. `war3_extracted/UI/WorldEditStrings.txt:5233` identifies that field as
  the attack animation damage point. The H00N record is in
  `data/war3map.w3u.json`.
- **Impact:** last-hit timing and cancelling an attack before impact differ from
  the authored game, even when the visual animation looks correct.
- **Repair criterion:** carry weapon timing through extraction and implement
  attack start, damage/projectile release, and recovery. Check cancellation,
  stun, target loss and attack-speed scaling. Use retail to settle exact release
  and backswing edge cases rather than assuming animation duration is cooldown.

## 4. Every roster hero loses a damage die — medium priority

- **Observed:** Byakuya's unarmored basic attack ranges from 61 to 66.
- **Expected:** 62 to 72: 60 attribute/base damage plus two six-sided dice.
- **Cause:** `server/world.js:2465` rolls one die and uses `dmgDice` only as a
  greater-than-zero flag. All 26 roster heroes declare two damage dice.
- **Primary data:** `data/unittypes.json` retains `dmgDice` and `dmgSides`;
  Blizzard's `UnitMetaData.slk` maps `ua1d` to `dice1`, and
  `WorldEditStrings.txt:5205` labels it the damage number of dice. Stock
  `data/blz_units.json` Hpal also provides min/average/max weapon damage 2/7/12
  for its two six-sided dice, independently corroborating their interpretation.
- **Repair criterion:** sum the specified number of independent rolls; multiplying
  a single roll by the dice count gets the endpoints but the wrong distribution.

## 5. Hero regeneration uses the wrong formulas — high priority

- **Observed:** at level 1 without items/buffs, Byakuya recovers 0.25 HP and 5 mana
  in one second, while kept below his resource caps.
- **Expected from this map:** 2.25 HP/s (`0.25 + 20 × 0.1`) and 2.01 mana/s
  (`0.01 + 20 × 0.1`).
- **Cause:** `server/world.js:706` omits strength regeneration.
  `server/world.js:2162` uses that incomplete HP rate and multiplies the base
  mana regeneration rate by maximum mana. Intelligence regeneration is omitted.
  Both map coefficients are already extracted but unused here.
- **Primary data:** `extracted/war3mapMisc.txt:7` and `:8` explicitly set the two
  coefficients to 0.1; `tools/unittypes.py:25` reads base `regenHP`/`regenMana`.
  [Blizzard's hero formulas](https://classic.battle.net/war3/basics/heroes.shtml)
  establish attribute-based regeneration and base mana regeneration per second.
- **Repair criterion:** use the map coefficients and correct rate units. Verify
  base stats, gained attributes and equipment independently. Also inspect zero
  rates and non-hero mana regeneration before declaring regeneration complete.

## 6. Stop disables automatic combat for player heroes — medium priority

- **Observed:** with an enemy already in melee range, a controlled hero makes
  zero attacks in two seconds after Stop. Switching the same fixture to Hold
  produces three attacks in two seconds.
- **Expected:** an idle stopped unit can acquire and engage an enemy; Hold allows
  attacks in range while preventing pursuit. [Blizzard's unit commands guide](https://classic.battle.net/war3/basics/unitcommands.shtml)
  explicitly distinguishes those behaviors.
- **Cause:** Stop sets `idle` (`server/world.js:1005`), `stepAI` exits for all
  controlled heroes (`:2207`), and `stepAttack` excludes idle orders (`:2447`).
  Bought heroes are marked controlled at `:1764`. Completing an ordinary Move
  also sets idle, so this affects arrival as well as pressing Stop.
- **Repair criterion:** separate basic target acquisition from neutral-creep
  guarding/leashing. Keep Move non-retaliatory while moving, restore idle
  acquisition afterward, and preserve Hold's no-chase behavior.

## Original implementation priorities (completed)

Damage types and buff expiry first, then regeneration, damage dice, and attack
timing/acquisition. These fix shared rules rather than introducing hero-specific
exceptions. Each diagnostic is now covered by behavior regression tests.
