# Table geometry and physics

Measured on 2026-10-11 from VPX's bundled tables (blank, example, light sequence), the user's own `vpx_first`, and two VPW tables (Game of Thrones LE, World Cup Soccer '94). Ranges below are what those tables use, not limits; `part_schema` has the observed range of every property over ~4,000 parts.

## Units and axes

- **VPX units (VPU):** 50 VPU = 1.0625 in, the diameter of a standard ball (`plugins/plugins/VPXPlugin.h`). Ball radius is 25, so a resting ball has z = 25.
- **Axes:** x grows to the right, y grows **down the playfield towards the player** (the drain is at large y), z grows up from the playfield.
- **Angles:** 0° points up the playfield (away from the player), and angles grow clockwise as seen from above. A left flipper rests at about 120° (pointing down and right) and swings up to about 70°; right flippers mirror this with negative angles. Verified live: holding `LeftFlipper` moved its `CurrentAngle` from 120.5 to 70.
- **Velocities** (ball `VelX`/`VelY`, `trace_ball` output) are in VPU per 10 ms physics tick. A full plunger pull sent the example table's ball up the lane at about 53.

## Playfield

| | Width × height (VPU) | Slope |
|---|---|---|
| Bundled blank / example tables | 952 × 2162–2165 | 6° (blank: 5–10° range) |
| vpx_first | 953 × 2353 | 6° |
| Game of Thrones LE (VPW) | 952 × 2115 | 6.5° |
| World Cup Soccer (VPW) | 953 × 2153 | 6.2° |

952 VPU wide is about 20.2 in, the standard playfield width. Table `difficulty` is 0.2 on the tables checked.

## Flippers

Main flippers on every table measured:

| Property | Bundled tables | VPW tables |
|---|---|---|
| Pivot centers | (278, 1803) and (596, 1803): 318 apart | (274–289, 1788–1822) and (594–611, same y): 320–322 apart |
| Length (`flipper_radius_max`) | 117.65 | 115–118 |
| Base / end radius | 20.6 / 11.8 | 19.9–20.6 / 10.4–11.7 |
| Start / end angle | 120.5 / 70 (mirrored) | 120.5–121.15 / 69–69.8 |
| Strength | 1800–2600 | 2500–3200 |
| Elasticity / friction | 0.8 / 0.8 | 0.88 / 0.7–0.9 |
| Return | 0.05 | 0.055–0.07 |

- The pair is centered at x ≈ 434–450, left of the playfield's middle (476) on every table measured (the plunger lane takes the right edge), with pivots 327–394 VPU above the bottom edge.
- **The lower playfield mirrors around that center, not the table's.** On the blank/example table the inlanes are at x = 129 and 743 and the playable width runs from the left wall (inner edge 23) to the plunger lane wall (inner edge 851), so mirroring a left side feature to the right is x' = 872 − x. Mirroring with the table width (952 − x) puts a right inlane feature into the right outlane (found 2026-10-12 building a ramp return).
- Upper flippers mounted against a wall need a feed guide **collinear with the flipper's top surface**, ending just outside its swept area: a steeper guide, or a pivot against the wall, made a ball rolling down the wall skip over the flipper or come to rest on its hub (measured 2026-10-12 on a mid-playfield flipper resting at ±147°).
- Upper (mini) flippers on Game of Thrones are standard length (114.7) with lower strength (2200).
- VPW tables hide their physics flippers (`visible: false`) and draw them with primitives; find them with `list_parts` type `flipper`, not by looking.
- World Cup Soccer uses an invisible 220 long flipper with tiny radii as a moving **diverter**: a flipper is the easy way to make any scripted swinging wall.

## Physical vs visual parts (VPW style)

Modern tables split each feature into an invisible physics part and separate visuals: `sw25` (hit target, `visible: false`), `BM_sw25` (baked mesh primitive) and `LM_<light>_sw25` (one lightmap per lamp that lights it). The lightmaps encode the source table's lighting and rarely belong in another table. Walls with a 3D look are often an invisible `surface` plus primitives. Ramps likewise.

## Shaped parts need outlines

Flasher, light, ramp, rubber, surface and trigger parts are defined by `dragpoints` (outline points with `center: {x, y}`). The editor creates them when a part is placed; a part written as JSON without them has no shape, so `create_part` refuses it. Copy an existing part (`from`) and move its points instead of authoring outlines from scratch.

## Ramps

- A ramp's height at a point is the linear interpolation from `height_bottom` (first dragpoint) to `height_top` (last), **plus that dragpoint's own `position_z`** (`src/parts/ramp.cpp`, `GetRampVertex`); physics uses the same heights. Bumps, dips and roller coaster waves are per point offsets from that line (2026-10-12, a two peak wire return).
- Build ramps as segments that meet at equal heights (entry, turn, return), as VPW tables do; a ball needs a speed of ~40 at the mouth to climb to height 110 over ~470 of length.
- For waves, compare effective heights (`h − 0.105 × distance down the table`, the 6° playfield slope): every peak must be well below the height the ball starts its descent at, or a slow ball settles in a dip. Test with a ball placed nearly stationary at the top.
- A ~40 radius hairpin at the top of a ramp threw a ball arriving at speed ~33 up to 80 above the ramp, over the standard 62 walls, and back down the entry. ~60 radius plus tall invisible walls (`left/right_wall_height` 150, `*_visible` 62: physics and visible heights are separate) kept it within ~20.
- Put a ramp mouth on the **measured** shot line of the flipper that feeds it (flip a rolling ball at a range of timings and record where it crosses the mouth's height), and make it ~130 wide; mouths placed from a drawing were off by 25–70.
- **Balls get trapped under ramp entries.** Where an entry is higher than ~55 a ball rolls underneath it, and where the entry slopes down to ball height (50) the ball is pinned under its edge. Check every new ramp by dropping still balls along realistic paths (from above the ramps, and shots into the gaps beside the mouths); grid points that land inside walls or under low ramp floors are artifacts. The fix that worked: a guide wall lower than the ramp floors (45) under the entries' high parts, apex up the table, sending balls out past the ramps' outer edges, plus a skirt beside (never under) the entries' low inner edges (2026-10-12).
