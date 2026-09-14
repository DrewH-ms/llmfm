# LLMFM

**Radio for your coding agents.** A local daemon plays a MIDI score through the
Windows system synthesizer while your Copilot CLI agents are working, and falls silent
when one needs you. Sound means "still going". Silence means "you're up".

Nothing is downloaded, nothing leaves the machine, and if the daemon is not running the
CLI behaves exactly as normal.

## Requirements

- Windows with the Microsoft GS Wavetable Synth (present by default)
- Node 24+ (runs TypeScript directly; there is no build step)

## Quick start

```powershell
npm install
node bin/llmfm.ts install   # install the Copilot CLI hooks
node bin/llmfm.ts start     # run the daemon
```

Then **open a new Copilot CLI session**. Hooks are loaded once at session start, so a
terminal that was already open will not report to the daemon.

To stop observing entirely:

```powershell
node bin/llmfm.ts uninstall
```

Uninstall removes only our own hook file and restores the prior state.

## Commands

| Command | Purpose |
| --- | --- |
| `node bin/llmfm.ts start [track.mid]` | Run the daemon |
| `node bin/llmfm.ts install` | Install the Copilot CLI hooks |
| `node bin/llmfm.ts uninstall` | Remove them |
| `node bin/llmfm.ts status` | Report daemon and hook state |
| `node bin/llmfm.ts tracks` | List bundled tracks |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLMFM_URL` | `http://127.0.0.1:7777` | Where hooks post events. Needed when the CLI runs across a network boundary (WSL, dev container). |
| `LLMFM_PORT` | `7777` | Port the daemon listens on |
| `LLMFM_SESSION` | unset | Pin audio to a single session id. Scope is otherwise machine-wide. |
| `LLMFM_WATCH_FILE` | `1` | Set to `0` to ignore `open-sessions-state.json` and rely on hooks alone |
| `LLMFM_LOG` | unset | Set to `1` to log hook event names and short session ids. Never logs payload contents. |

## Sessions started before the hooks were installed

Hooks are loaded once, at session start. A session opened before `install` never reports
through them, so it is tracked only through `open-sessions-state.json` — and that file
cannot see a mid-turn permission prompt. Such a session reads as *working* for its whole
turn, which keeps the music playing while it is actually waiting on you.

Since scope is machine-wide, one pre-install session is enough to hold the music on. Open
a fresh session after installing, or pin audio with `LLMFM_SESSION`.

`node bin/llmfm.ts status` shows each session's `source`; `hook` is fully tracked,
`file` is the degraded case above.

## How it works

Copilot CLI lifecycle hooks report session state to a daemon on `127.0.0.1:7777`. The
daemon holds the score, gates each part's volume, and drives the OS synthesizer over a
`winmm` bridge. It never wraps, spawns, or intercepts the CLI.

Scope is **machine-wide**: any `copilot` session on the box reports to the same daemon,
across any number of terminals and VS Code windows.

Two signals are combined. Hooks are low-latency and authoritative. The CLI's
`open-sessions-state.json` is polled as corroboration, so a missed or mis-parsed event
self-corrects. That file's authority is deliberately *directional* — it can see a turn
ending, but it cannot see a mid-turn permission prompt, so it is never allowed to
restore a part that a `notification` hook silenced.

### Transport

Every part is gated individually, and the transport pauses only when no part is audible,
resuming from the position it froze at. With one session all parts gate together and it
behaves like hold music. With several, the transport keeps running so parts stay locked
to each other and a rejoining part enters wherever the piece currently is.

## Music and licensing

MIDI messages are sent to the synthesizer already installed on your machine. The
synthesizer's sample data (`gm.dls`) is never read, copied, extracted, or redistributed —
that is what its licence requires, and it is why there is nothing to download.

Bundled music is public domain. See `tracks/tracks.json` for provenance.

## Privacy

No network egress, no telemetry, no third-party services. Hook payloads contain prompt
text and repository paths; they are parsed in memory and are not logged.
