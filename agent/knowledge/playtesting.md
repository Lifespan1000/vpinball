# Playtesting a change

The loop that worked for finishing the `sw25` transplant on 2026-10-11 (World Cup Soccer target moved into `vpx_first`), all through the `vpinball` MCP tools.

1. **Edit the pack** (`update_part`, `create_part`, `import_parts`, script edits), then `validate_pack`.
2. **`playtest`** the pack folder. It returns once the game runs; `game_time` starts near 0.
3. **Try script live** with `run_script` raw mode (define or replace the handler), so iterating does not need a restart.
4. **Put the ball where the feature is** instead of hoping a flipper shot gets there. Balls are scriptable:

   ```vbscript
   Dim balls, b : balls = GetBalls : Set b = balls(0)
   b.X = 587 : b.Y = 1050 : b.Z = 25 : b.VelX = 0 : b.VelY = -18 : b.VelZ = 0
   ```

   then `trace_ball` (about 1.5 s at 150 ms) to see the path. Fired up from 225 below `sw25`, the ball struck it at about (559, 853) and glanced off along its 35° face.
5. **Check the effect** with `run_script` (`AgentBridge.Report Sw25Hits`), and check `game_state` for `new_log_problems`: a handler error is only visible there and in `playtest_log`.
6. **Make it permanent** in `script.vbs`, then `stop_playtest` and start a fresh `playtest` without any live patch, and repeat step 4–5. Only this proves the saved table works.
7. `screenshot` when the look matters (it captures the window even when other windows cover it, not when it is minimized).

## Notes

- `press` drives real player input: hold flippers with `press: true` / `false`, the plunger is `LaunchBall` (a 1000 ms pulse is a full pull). Tables with credits need `AddCredit` then `StartGame`.
- The game keeps running while the VPX window is unfocused only in bridge playtests (they set `PauseOnFocusLoss = 0`); a playtest without the bridge pauses as soon as the user clicks elsewhere.
- The VPX log is written asynchronously; an error may show up a few milliseconds after the call that caused it.
- ROM tables need their ROM in VPX's PinMAME folder to run their rules; without it they fail at `Controller.Run` with a dialog.
