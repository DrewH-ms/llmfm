# LLMFM — status

*Written 15 Sep 2026. Deadline Wednesday night, 16 Sep.*

Radio for your coding agents. A local daemon plays a MIDI orchestral score through the
Windows GM synth; each Copilot CLI session owns a voice, and a voice falls silent when
its agent needs you. **Silence is the signal** — that premise decides nearly every design
question below.

Repo `DrewH-ms/llmfm`, private, `main`, 25 commits. `tsc` clean, **115/115 tests passing**.

---

## What works today

**Tier 1 and Tier 2 of the plan are complete.** Everything below is verified running
against the real Microsoft GS Wavetable Synth, not just typechecked.

| Area | State |
| --- | --- |
| Hold music for one session | Plays while working, fades and pauses on stop, resumes at position |
| Ensemble mode | Score split into voices, one per session, gated live |
| Mid-turn stops | `notification` hook catches `permission_prompt` and `elicitation_dialog` |
| Voice tree | section → instrument → part, subdividing with live session count |
| Stable assignment | Hashed cwd picks a *path* down the tree, never arrival order |
| Overflow | Sessions beyond legible capacity show *unvoiced*, never double-booked |
| File watcher | `open-sessions-state.json` as a self-correcting fallback |
| Simulation mode | Synthetic session events on a timer |
| Alert (reverse) mode | Gate target inverted per session, same code path |
| Install / uninstall | Full state restore |
| Terminal dashboard | Drill-down sections, SSE, hand-rolled ANSI, no TUI dependency |
| Track library | 17 screened tracks with per-file licence and sha256 |
| Custom `.mid` drop-in | User folder, picked up without a restart |
| Startup motif | The score's own opening phrase as a sting |

### The dashboard

```
MENU
▸ Music                 17 tracks ›
  Settings              8 options
  Sessions              11 · 1 sounding · 10 muted
  Master volume         ███████████░░░░░░░░░░░░░   45
```

Music holds: skip to next track, add your own music (opens the drop-in folder), connect
Bluetooth (dummy), then the library with `▶` on what's playing.

---

## The decisions worth remembering

These are the ones that cost real time to reach, and that are expensive to rediscover.

**The arbitration rule — four bugs deep.** `open-sessions-state.json`'s `working` field
tracks *the CLI process being busy*, not the agent needing you. So only its `false` and
its word on a session's existence carry information. The guard is
`if (previous && (entry.working || !previous.working)) continue;`. Without it the file
flips a mid-turn-blocked session back to *working* and the music resumes while the agent
sits on a permission prompt — which breaks the premise outright.

**The file may only evict what it once claimed.** An earlier version evicted any
hook-sourced session missing from the file after five seconds. That hits every real
session during the `sessionStart` race, and breaks the product entirely for anyone whose
CLI does not maintain that undocumented file.

**Spec drift is a process boundary, not a code smell.** `settings.ts` claimed the menu,
wire format and validation "cannot drift" because they read one list. True inside one
process; false across two. The TUI and daemon are separate programs with separate
compiled copies, so a daemon started before a setting existed answers 400 to a row the
newer menu still draws. *That was the entire cause of the `Sound means` / `Fade` /
`When track ends` failures — not a bug in any of those settings.* The daemon now
publishes its own spec list on `/state` and the menu is built from what the daemon says
it accepts.

**Track quality is two measurements, not one.** A usable track needs velocity spread
*and* recognisable part names. Judging on dynamics alone picked Egmont — 85 distinct
velocities and **0 of 14 parts identifiably named**, so nothing can be told apart by ear
and the patch remap has nothing to bite on. Coriolan wins on both (12/12 named, 75
velocities) and is the default.

| | named parts | velocities |
| --- | --- | --- |
| **Coriolan** (default) | **12/12** | **75** |
| Dvořák 9 *New World* | 11/15 | 100 |
| Egmont | 0/14 | 85 |

28 of the original 45 Mutopia files had exactly **one** distinct velocity — LilyPond's
mechanical MIDI export does not render dynamic marks. The gate is: fewer than 5 distinct
velocities fails.

**Orchestral context decides a patch, not the name alone.** Mutopia puts string sections
on solo patches (40/41/42/43), which sounds thin. But a singular `violino1` is a *desk*
in an orchestra and may be the *only violin* in a quartet. The rule gates on the score
around the part: a wind complement plus a body of strings means orchestra. Verified
across the whole library — Coriolan remaps all five desks to 48; the quartets, *Eine
kleine*, Brandenburg 5 and the Bach violin concerto are untouched; Dvořák 9 was already
correct and changed nothing.

**Licensing is enforced by hash, not by trust.** Every shipped file is pinned to the
sha256 its licence record was written for. This exists because a Kunst der Fuge file once
sat under a Mutopia filename whose record claimed public domain — had we published in
that window, we would have shipped unredistributable material. The bytes and the filename
are both gone now, and the test closes the class regardless of how it happened.

**Licence verdicts (checked live):** Kunst der Fuge — *not* redistributable, terms
prohibit any use beyond personal and private. MIDI World — "All rights reserved", no
per-file licence. Mutopia — fine, and the allow-list fails closed.

---

## Still to go

### Blocks going public

- **`history-purge`** — `beethoven5.mid` came from Kunst der Fuge and is still in git
  history in every commit before `3f31603`. Must be purged with `git filter-repo` and the
  remote force-updated **before `DrewH-ms/llmfm` is made public.** The repo is private, so
  there is no exposure yet, but this gates the hackathon release.

### Committed, not yet built

- **`duck-integrate`** — `audio: midi | duck`, riding system volume against agent state so
  it works with Spotify or a phone over Bluetooth. The spike is **accepted and verified**
  (`src/system-volume.ts`, `bridge/volume-bridge.ps1`, 3/3 tests, Core Audio via COM
  interop, no dependencies). Key finding: killing the Node parent also kills the
  PowerShell child, so in-bridge restore cannot be the only defence — the baseline is
  persisted to a device-scoped claim file and restored on next start only if the level has
  not moved since. Never ducks to zero, so the worst case after a crash is
  quieter-than-expected rather than a silent machine. Non-negotiable: never leave system
  volume changed after exit.
- **`bin-link`** — `package.json` bin + `npm link` so `llmfm` runs from any directory. The
  wrong-directory stack trace has been hit once already; demo day is the worst place to
  hit it again.
- **`polish`** — tune fade lengths and part selection **by ear on laptop speakers**, and
  rehearse the demo with four sessions opened after install.

### Measurements not yet taken

- **`spike-perceptibility`** — how many parts can gate in and out and stay individually
  perceptible on laptop speakers. The answer sets where the voice tree should stop
  subdividing, and may promote section grouping over instrument grouping. This is the one
  open question that could still change the product's shape.
- **`subagent-hooks`** — whether `subagentStart`/`Stop` carry the parent's or the
  sub-agent's `sessionId`. They would beat the file-absence heuristic, but the heuristic
  works and must not be replaced blind.

### Nice to have

- **`cfg-continuity`** — expose `MIN_VOICE_CONTINUITY`. Held at its default deliberately:
  at 2–4 sessions it never binds, and lowering it admits voices whose *written rests* read
  as a stopped agent.
- **`cfg-show-subagents`** — render sub-agents greyed out and non-gating so a fleet
  operator can see they exist. Display only; must not touch gating.
- **`instrument-key`** — key the instrument tier by part-name family rather than GM
  program. On this score five string parts share program 48, so the tier collapses to one
  node. Cosmetic; section and part tiers already carry the product.
- **`terminal-title`** — OSC write to `CONOUT$` to label a session with its instrument.
  Untested, and may be clobbered by the CLI's own repaint.
- **`bach-harpsichord`** — in the Bach violin concerto the ripieno `ViolinI`, `ViolinII`,
  `Viola` and `Continuo` all carry GM program 6 (Harpsichord) while `SoloViolin` correctly
  carries 40, so the strings sound as harpsichords. Pre-existing and out of the orchestral
  rule's scope — that score is chamber-scored, so the rule correctly declines to act.
  Fixing it needs a rule about *implausible programs*, not implausible names.

### Parked by you

- **`track-sources`** / **`track-library-100`** — scaling toward 100 tracks, Vivaldi's
  *Four Seasons* included. Stood down pending a source whose instrumentation survives the
  Windows synth. `tools/discover-tracks.ts` and the dynamics gate can re-find candidates
  if this resumes.

---

## Demo procedure

1. Start the daemon; confirm it opened the Microsoft GS Wavetable Synth.
2. Open the dashboard in a second terminal.
3. **Open all four demo terminals last** — hooks load once at session start, so a
   pre-existing session will never report.
4. One session: hold music, silence on stop, resume mid-phrase on reply.
5. Add three more on genuinely slow tasks; let the texture fill in and thin out live.
6. Answer one visibly; let the part rejoin.
7. Keep simulation mode ready as the fallback if network or API access fails.

## Constraints that bind any further work

- Native Node type stripping. **No build step, no bundler.** Erasable syntax only — no
  `enum`, no `namespace`, no parameter properties, no `any`.
- **No new dependencies.** `@tonejs/midi` is the only one, and it is CommonJS:
  `import pkg from '@tonejs/midi'; const { Midi } = pkg;`
- **No runtime network egress.** Curation is a separate, explicitly-run dev-time tool.
- Never bundle or extract `gm.dls`. MIDI goes to the installed synth.
- Hook payload logging stays off by default — payloads contain prompt text.
- `Hackathon\` is reference only and **off limits to edit**.
