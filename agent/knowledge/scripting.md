# Table scripting

Each table has one VBScript (`script.vbs` in a pack). Verified on the bundled templates, `vpx_first`, Game of Thrones LE and World Cup Soccer, and live through the AgentBridge on 2026-10-11.

## How scripts connect to parts

- Events are Subs named `<PartName>_<Event>`: `Drain_Hit`, `sw25_Hit`, `LeftSlingShot_Slingshot`, `Plunger_Init`, `<Timer>_Timer`, `Table1_KeyDown(keycode)` / `Table1_KeyUp(keycode)` (keys are table events, `Table1` being the table's name).
- A collection with `fire_events` routes its members' events to one handler with an index: `Sub Targets_Hit(idx)`.
- Hit targets and walls raise `_Hit` only with `hitEvent: true` (the transplanted `sw25` has it).
- Handlers defined **after the game started** are connected too (verified: a `sw25_Hit` added with `run_script` raw mode received the next hit). Redefining a Sub or Function replaces it. This is how features are tried live before being written into `script.vbs`.

## What a new table's script does (and does not)

VPX's blank table script (`src/assets/blankTable.vpx`) is pure physics and sound:

- loads `controller.vbs` (DOF) with `ExecuteGlobal GetTextFile("controller.vbs")`
- keys: plunger `PullBack` / `Fire`, flippers `RotateToEnd` / `RotateToStart`, nudge keys `Nudge angle, strength`
- ball lifecycle: `Plunger_Init` does `BallRelease.CreateBall` then `BallRelease.Kick 90, 7`; `Drain_Hit` destroys the ball and releases a new one, counting balls in play in `BIP`
- sling animations on timers, positional sound helpers (`AudioPan`, `AudioFade`, `Vol`, `Pitch`), rolling sounds, ball shadows

There is **no score, ball count, tilt, game start or rules**: an original table must write its own game flow. `vpx_first` is this template plus a third flipper and a manual ball control helper.

## ROM tables vs originals

- ROM-driven tables set `Const cGameName = "<rom>"` (e.g. `wcs_l2`, `gameofthrones`), call `vpminit me` and `Controller.Run` in `Table1_Init`, and map lamps with `vpmMapLights`. Their rules run in PinMAME; the script only wires switches (`Controller.Switch(25) = 1`) and solenoids. Editing their rules means editing the ROM, not the script.
- Originals have `cGameName = ""` and implement rules in VBScript.
- VPW tables bring large helper libraries in the script itself, e.g. `STHit switch` / `DTHit switch` (standing / drop target physics and animation, keyed by arrays like `STArray`). A handler moved to another table may call helpers that do not exist there.

## Pitfalls for agents

- **`Option Explicit` is on in every table checked**, so an undefined name is a runtime error, raised when the line runs, not at load. Inside an event handler the error does not stop the game: VPX logs it (`Runtime error on line 530, col 27: Variable is undefined: 'target'`) and the handler stops at the failing line. Check `game_state` (it flags new log errors) or `playtest_log` after exercising a change.
- **Never add `MsgBox` or `InputBox`.** They open modal dialogs that block the game (and any agent playtest). The templates use `MsgBox` only for fatal setup errors (missing `controller.vbs`, ROM failing to start).
- `GetBalls` returns an array: `balls = GetBalls : Set b = balls(0)`; `GetBalls(0)` fails with "Object required".
- String literals need their quotes: `PlaySound "target"`. Watch for them being lost when a shell command writes the script.
- Script text is VBScript in the table's file encoding; keep edits ASCII unless the file already uses something else.
- **A compile error disables the whole table script, silently.** VPX logs `Compile error on line N, col M` and the table keeps running with no script: no ball is created and nothing responds, which looks like a broken playtest, not a script error. `playtest` now returns `script_errors` when this happens; check before anything else.
- A single line `If engaged Then LaunchDiverter.RotateToEnd Else LaunchDiverter.RotateToStart` (method calls in both branches) failed to compile in VPX with "Syntax error" at the `Else`; use the block form `If … Then` / `Else` / `End If` (2026-10-12).
