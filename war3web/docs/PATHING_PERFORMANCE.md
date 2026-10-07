# Pathfinding load regression

The wave-related stall was reproducible without rendering: 40 units pursuing a
unit behind an impassable wall caused approximately 550 ms server ticks, against
33.3 ms available at 30 Hz. Null paths bypassed `repathAt`, so all 40 units retried
A* on every tick. The old idle-roster performance test did not exercise this case.

Changes:

- Failed pursuit and patrol routes respect the retry deadline.
- Automatic pursuit and body-detour searches use a FIFO queue, capped at 16
  searches and a soft 6 ms per tick. New orders cancel stale queued requests;
  queued targets use their current position. Explicit initial orders stay immediate.
- A* uses a binary heap and caches cell clearance within each search.
- Clear direct routes bypass A*. Swept terrain tests visit a narrow band around
  the segment instead of a whole diagonal bounding rectangle.
- Body tests discard units outside the movement segment's bounds, and searches
  use spatial buckets for body occupancy.
- Cached terrain connectivity rejects provably disconnected routes. Destroying
  ground/flight blockers invalidates the corresponding cache. Unit radius and
  dynamic bodies are still checked by the actual route search.

Local measurements (milliseconds, synthetic movement fixtures):

| Scenario | Before mean / worst | After mean / worst |
| --- | --- | --- |
| 40 unreachable pursuers | 558 / 588 (5 ticks) | 0.85 / 4.11 (90 ticks) |
| 400 moving units | 14.93 / 66.35 (120 ticks) | 8.81 / 16.25 (120 ticks) |

A separate real-map run, with JASS timers, the initial roster and 400 added
attackers (521 total units), measured approximately 18.9 ms average, 23.7 ms p95
and 35.3 ms worst tick. These are local measurements, not timing assertions or
production guarantees. One synchronous search can exceed the soft queue budget;
under sustained load automatic routes wait their turn while simulation continues.

Reproduce with `node tools/pathing_load_test.mjs`, or
`MAP_LOAD=1 node tools/pathing_load_test.mjs` for the additional real-map case.
The test checks retry limits, FIFO progress, queue cancellation, terrain reopening,
direct-route bypass and diagonal scan work. The existing movement, terrain,
turn-rate, casting and gate-destruction tests verify behavior. An additional
seeded comparison of 10,000 swept segments matched the previous exact clearance
implementation.
