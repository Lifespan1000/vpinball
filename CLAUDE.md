# CLAUDE.md

This is a personal fork of [Visual Pinball X](https://github.com/vpinball/vpinball) (`origin` = `Lifespan1000/vpinball`, `upstream` = `vpinball/vpinball`). It is C++ built with CMake, plus parallel MSVC `.vcxproj`/`.sln` files. Build instructions are in [make/README.md](make/README.md); per-area docs are in [docs/](docs/).

## Upstream's AI policy — read before anything goes upstream

[CONTRIBUTING.md](CONTRIBUTING.md) **discourages AI-assisted contributions and prohibits ones made entirely by AI.** Work in this fork is unrestricted, but anything headed for an upstream pull request must follow it:

- A fix written entirely by an agent may only be offered upstream as a **draft PR** that states the issue (with repro steps) and says plainly that the fix is AI-generated, as a starting point rather than a finished contribution.
- Anything else must be understood, proofread and tested on real hardware with representative tables by the user, with the AI use disclosed in the PR description.
- Keep PR descriptions and comments short. Never post in upstream issues or PRs on the user's behalf — upstream wants to talk to humans.
- Never open an upstream PR, issue or comment without the user's explicit go-ahead for that specific one.

## Working in the fork

- Branch for every change and keep `master` tracking `upstream/master` (`git fetch upstream && git merge --ff-only upstream/master`). This file lives only on the fork's `master`; never include it in a branch meant for upstream.
- One self-contained change per branch, with no unrelated formatting or line-ending churn — upstream rejects bundled PRs.
- When adding, removing or renaming a source file, update **both** the CMake manifests (`make/CMakeLists_sources.txt`, `make/CMakeLists_plugins.txt`) and the matching `.vcxproj`/`.vcxitems` in `make/`.
- Do not submit code or ideas from proprietary or source-available pinball simulators (see "Respect Copyright" in CONTRIBUTING.md).

## Build and test (Windows x64)

This machine has no MSYS2, so dependencies come from upstream CI instead of `external.sh`: the `VPinballX-…-dev-third-party-windows-x64-Release.zip` artifact of a recent `vpinball` workflow run (`gh run download <id> -R vpinball/vpinball -n <name>.zip`), extracted over `third-party/`, then `git checkout -- third-party` to keep the tracked headers at HEAD. The solution is generated with `make/create_vs_solution.bat` (answer `2026`) into `.build/vsproject/`, and built with VS Build Tools 2026 (needs the C++ ATL component):

```bash
MSBuild.exe .build/vsproject/VisualPinball.slnx -p:Configuration=Release_BGFX -p:Platform=x64 -m -nodeReuse:false
```

`-nodeReuse:false` matters: resident MSBuild nodes block the VS installer. A running VPX locks `VPinballX_BGFX64.exe`, so close it before linking. Outputs are in `.build/bin/<project>/Release_BGFX-x64/`. `vpx-test.exe` is a GUI-subsystem app, so pass `--out=<file>` to see its results; `--test-case-exclude="*[render]*"` skips the tests that need a GPU.

## Agent tooling (fork only)

Tables are edited as VPZ packs: folders of JSON (one file per part in `parts/`), `script.vbs`, and assets. See [docs/VPZ File Format.md](docs/VPZ%20File%20Format.md). Headless commands added in this fork (exit code 0/1, details in the VPX log):

- `-Convert <table> <output>` — .vpx ⇄ pack; an output without extension is a pack folder.
- `-ExportParts <table> <output pack> <name,name,...>` — the named parts plus every asset, material, part group and collection they use.
- `-ImportParts <table> <parts pack> <output> [rename|existing]` — merges a parts pack in; clashing part names get a numeric suffix, clashing assets are renamed by default.

Command line errors still open a **modal dialog that blocks forever**; validate paths before invoking VPX headlessly, and use a timeout.

`agent/mcp-server/` is the MCP server Claude Code uses for all of this (registered as `vpinball` in the PersonalSpace workspace `.mcp.json`; run `npm install` there on a fresh clone). Its tools wrap the commands above with the input checks and timeouts they need, and edit parts with schema validation, writing nothing when an edit is invalid. Untouched values keep their exact text, so diffs show only real edits. `npm test` there runs an end-to-end test over MCP stdio, including a VPX round trip. New shaped parts (flasher, light, ramp, rubber, surface, trigger) need `dragpoints`: the editor creates a part's outline when placing it, but loading a part does not, so `create_part` refuses one without them — copying an existing part with `from` is usually better anyway.

Playtests are observed and driven through `agent/vpx-plugin/` (AgentBridge), a plugin serving a local HTTP API on 127.0.0.1:2114 from inside VPX: run VBScript in the table's context (results come back through `AgentBridge.Report`; raw mode redefines Subs live), press player buttons, read ball positions. The MCP tools `playtest`, `game_state`, `press`, `trace_ball`, `run_script` and `screenshot` use it. It is built by its own CMake project, not upstream's build files, so merges stay conflict free:

```bash
cmake -S agent/vpx-plugin -B .build/agent-plugin -G "Visual Studio 18 2026" -A x64
cmake --build .build/agent-plugin --config Release   # installs into the VPX build's plugins/agentbridge
```

It runs arbitrary script, so it is never enabled in the user's own settings: every `playtest` runs VPX with `-PrefPath` set to a private temporary folder holding a copy of `%APPDATA%\VPinballX\10.8\VPinballX.ini` (bridge playtests enable the plugin there and set `[Player] PauseOnFocusLoss = 0`, a setting added by this fork: VPX otherwise pauses the game whenever its window loses focus, freezing every agent playtest). The private folder also gives each playtest its own `vpinball.log`; the shared log mixes lines from every VPX process running at the time. Windows keeps that folder locked for ~100 ms after VPX exits and `fs.rmSync`'s `maxRetries` does not retry that `EPERM`, so cleanup retries explicitly. Plugin script members `AddRef`/`Release` are called with a null return slot (`PSC_ADD_REF`), so they must not write `pRet`. `npm test` in `agent/mcp-server` includes a live bridge test that opens a VPX window for a few seconds.

**Before designing or changing a table, read `agent/knowledge/`:** [geometry-and-physics.md](agent/knowledge/geometry-and-physics.md) (units, axes, angle convention, measured flipper and playfield values), [scripting.md](agent/knowledge/scripting.md) (event model, what a new table's script lacks, ROM vs original tables, VBScript traps) and [playtesting.md](agent/knowledge/playtesting.md) (the edit → live patch → place the ball → verify → persist → fresh playtest loop). Everything in them was measured or verified on real tables; keep it that way when adding to them, and date new findings. Errors in a table's event handlers never reach `run_script`; `game_state` flags new ones and `playtest_log` lists them.

`agent/` also holds:

- `agent/schemas/parts/<type>.schema.json` — generated by `node agent/tools/gen-part-schemas.mjs src/utils/JSONSerializer.cpp agent/schemas/parts <pack dir>...`. Property names come from the serializer's field maps; types, ranges and examples from the sample packs (advisory, not limits). Regenerate after pulling upstream changes to `JSONSerializer.cpp`.
- `node agent/tools/validate-pack.mjs <pack dir>` — VPX silently drops unknown properties on load, so run this after every hand edit.

Moving a feature between tables is more than its named part: VPW-style tables pair an invisible physics part (`sw25`) with baked visuals (`BM_sw25`), per-light lightmaps (`LM_*_sw25`, meaningless outside their table), and script handlers (`Sub sw25_Hit`) that often call the table's helper library. Carry the physics part and bake mesh, drop the lightmaps, and port the script by hand. Mesh `.glb` files change by ~1e-11 on every conversion, so expect noise in diffs.
