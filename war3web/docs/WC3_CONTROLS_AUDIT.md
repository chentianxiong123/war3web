# Warcraft III controls and UI parity

Reference: Blizzard's [Special Commands](https://classic.battle.net/war3/basics/specialcommands.shtml) and [Unit Commands](https://classic.battle.net/war3/basics/unitcommands.shtml).

## Implemented: selection and basic command ownership

- Left-click selects a unit; empty ground clears the selection. Enemy and allied units can be inspected but cannot be commanded.
- Drag a box to select owned living units, up to 12. Shift-click adds/removes a unit; Shift-drag adds units. Ctrl-click or double-click selects owned units of that type on screen.
- Ctrl+0–9 saves a group. A number recalls it; pressing that number twice quickly centers on its surviving owned members. Groups reset between matches.
- Move, stop, hold position, attack, attack-move and patrol use the selected owned units. Non-hero units get a basic command card. The server independently checks ownership, life, visibility and Locust status, deduplicates IDs and bounds the selection to 12. An empty/invalid selection never falls back to the hero.
- Accepted player orders remove creep guard behavior from the commanded unit. Selected owned units can receive commands even while the player's hero is dead.
- Selection circles and ordinary health bars follow the selected units; Alt still shows all bars. The group panel lists selected units and allows selecting/removing a member.
- F1 selects the hero; pressing it while that hero alone is selected centers the camera. A global double-click no longer enables hero following.
- Hero abilities and items remain associated with the hero card. This batch does not introduce non-hero ability cards or subgroup spell dispatch.

## Implemented: queued basic orders and follow

- Hold Shift while issuing a movement, attack, patrol, stop or hold order to queue it for each selected unit (up to 35 pending orders). The current action remains intact. Normal orders and death clear the queue, dead queued targets are skipped, and the selected unit's pending count appears in the console.
- Right-clicking a friendly or neutral mobile unit follows its current position. Followers wait nearby, resume when the leader moves, and do not acquire unrelated enemies. They join the leader's attack if already in weapon range. A dead or removed leader releases the follow order.
- Queued movement and follow route updates use the automatic pathfinding budget. Stop/new orders cancel stale scheduled routes. Movement queued during a cast starts after the cast finishes, ahead of resuming its previous attack.

## Implemented: subgroup cycling and inventory keys

- Tab and Shift+Tab cycle selected unit types without changing the group receiving basic orders. Hero types lead the cycle. The active type is highlighted and drives the portrait/card; clicking another type in the group panel activates it, then clicking an active type's member selects that unit alone.
- Numpad 7/8, 4/5 and 1/2 activate inventory slots 1–6 through the same handler as mouse clicks. Physical key codes keep this working with Num Lock off, repeated keydown events do not repeatedly spend items, and targeted items arm the cursor. Hero inventory keys are inactive when another subgroup is active.
- The scoreboard is accessible from F10 → Scoreboard and closes with Escape or its Close button. Tab is reserved for subgroups.

## Implemented: minimap and manual camera controls

- Left-click/drag the minimap to place the camera; right-click issues a Move order to the selection, with Shift queueing. Aimed Move/Attack/Patrol commands accept minimap points (Attack becomes attack-move). Right-click cancels an armed command before issuing another order.
- Point-target abilities accept minimap locations. Unit-target abilities/items stay armed and ask for a unit in the world instead of silently panning or choosing an arbitrary minimap dot.
- Arrow keys, screen edges and middle-button drag pan the camera. Input pauses in chat/dialogs/cinematics and is cleared on window blur. Manual navigation cancels a scripted pan; otherwise map-script pans remain supported.
- The camera centers once on the initial hero and then stays under player/script control. F1 and double-tapped control groups remain explicit centering actions. Space cycles recent alerts (see below).
- The minimap shows an approximate view outline projected onto the camera's focus plane, plus brief order markers. Pointer mapping uses CSS bounds rather than backing pixels, including after resize/high-DPI changes.

## Implemented: alert history and Space

- Space cycles the latest eight alert locations, newest first, without changing selection or issuing orders. New alerts restart the cycle. Coordinates are saved at event time so moving/dead units do not move the destination. Empty history does nothing; F1 remains hero centering.
- Positive enemy damage to owned units creates an under-attack text alert. Own/allied hero deaths also enter history. Healing/zero damage, friendly damage and enemy victims do not create attack alerts. Events require their units in the client snapshot.
- Alerts pulse on the minimap for five seconds. Attack spam suppression is a local policy (one alert within 1,200 world units per ten seconds), not a verified WCIII timing constant. History resets on return to the lobby.
- Space respects chat, dialogs, scoreboard and cinematic input blocking, ignores key repeat and cancels a scripted camera pan when navigating. Accepted attack alerts play the original race-specific unit/town advisor warning, with generic fallback and table volume/flags. Map-script/building-completion transmission sources remain unimplemented.

## Remaining work, in priority order

1. **Order queues and smart orders:** explicit friendly attack behavior, queued spell/item actions, and graphical waypoint previews. Shift+ability currently uses the old learning behavior.
2. **Subgroups and hotkeys:** non-hero spell cards, full spellcaster/level/inventory-based subgroup ordering and splitting, the configurable subgroup-order modifier, and remaining hero/group selection conventions.
3. **Camera and minimap:** additional transmission sources, camera settings, and exact per-ability minimap targeting restrictions.
4. **Targeting feedback:** keep invalid casts aimed until canceled or successfully issued, show errors at the cursor/console, and improve target-validity previews.
5. **Group presentation:** unit portraits/health in the group panel, formation placement, and exact selection prioritization where units/buildings share a drag box. Current group buttons use names.

## Verification

`tools/selection_test.mjs` checks the selection limit, group lifecycle, malformed/unauthorized network orders, and orders while the hero is dead. `tools/selection_ui_test.mjs` exercises the real client mouse/keyboard handlers and console using a live match with deterministic selection fixtures. Existing viewport, HUD, morph and movement-order tests cover adjacent behavior. `tools/order_queue_test.mjs` covers queue progression, capacity, death/Stop cancellation, follow and ownership; browser input checks cover Shift-clicks on the world and command card. The pathfinding load regression runs alongside these checks. `tools/minimap_test.mjs` and `tools/minimap_ui_test.mjs` cover coordinate mapping, resize/high-DPI input, navigation, queueing, cancellation, manual camera control and blur/chat handling.

`tools/alerts_test.mjs` covers the eight-entry history, cycling, reset and spatial throttling. `tools/alerts_ui_test.mjs` checks event filtering, captured coordinates after unit movement/removal, selection-independent Space, repeat/modal guards and scripted-pan cancellation in the real client.
