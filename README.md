# LLMFM

**Radio for your coding agents.** A local daemon plays a MIDI score through the
Windows system synthesizer while your Copilot CLI agents are working, and falls silent
when one needs you. Sound means "still going". Silence means "you're up".

Nothing is downloaded, nothing leaves the machine, and if the daemon is not running the
CLI behaves exactly as normal.

## Requirements

- Windows with the Microsoft GS Wavetable Synth (present by default)
- [Node 24+](https://nodejs.org/) — TypeScript runs directly, so there is no build step

## How to install

Download `llmfm.zip` from [the latest release](https://github.com/DrewH-ms/llmfm/releases/latest),
extract it somewhere you intend to keep, and double-click **`llmfm.cmd`**. It installs the
Copilot CLI hooks on first run and then opens the dashboard.

From a terminal, or from a clone, it is three commands:

```powershell
git clone https://github.com/DrewH-ms/llmfm.git
cd llmfm
npm install                  # the release zip ships these, so skip it there
node bin/llmfm.ts install    # install the Copilot CLI hooks
node bin/llmfm.ts            # start the daemon and open the dashboard
```

Then **open a new Copilot CLI session** — hooks load once at session start, so a terminal
that was already open will not report to the daemon.

**Keep the folder where it is.** Installing writes the full path of `hooks/notify.js` into
`~/.copilot/hooks/llmfm.json`, so this folder is the installed program rather than a
scratch checkout. If you move it, run `node bin/llmfm.ts install` again from the new
location. Your playlists and settings live in the folder too, so copy them across when you
upgrade.

## Running it

The dashboard is the program: it runs the daemon in the same process, so quitting it with
`q` stops the music and hands your audio back. Leave the terminal open while you work.
Daemon output goes to `llmfm.log` rather than the screen, so it cannot land in the middle
of a frame. If a daemon is already running, this attaches to it instead and leaves it
playing when you quit.

Resuming an existing session in a new terminal also works — resume starts a fresh
process, which loads hooks.

To stop observing entirely:

```powershell
node bin/llmfm.ts uninstall
```

Uninstall removes only our own hook file and restores the prior state.

## Commands

| Command | Purpose |
| --- | --- |
| `node bin/llmfm.ts [track.mid]` | Run the daemon and the dashboard together |
| `node bin/llmfm.ts start [track.mid]` | Run the daemon alone, no dashboard |
| `node bin/llmfm.ts tui` | Dashboard alone, against a daemon already running |
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

### Muting sessions

`llmfm.config.json`, in this folder beside `playlists/`, is re-read about once a second, so
edits apply mid-piece.
Press `m` in the dashboard to toggle the highlighted session, or write it by hand:

```json
{
  "muted": ["Rasa", "api-service (cb75a9e8)"],
  "promptGap": "silent"
}
```

A rule matches the folder name, the full handle the dashboard prints, or a session id
prefix of four characters or more. Prefer the **folder name**: session ids change every
restart, so a rule keyed on one quietly stops applying tomorrow.

A muted session releases its voice for someone else rather than sounding like an agent
that stopped, and it stays listed in the dashboard so you can find it again.

### `promptGap` — the one thing the CLI will not tell us

When you approve a permission prompt, the CLI emits **no event**. The next signal is the
tool *finishing*. So between approving and completion, nothing distinguishes "still
waiting on you" from "working hard". Neither setting is free:

- `silent` — the part stays quiet until the tool completes. Silence never lies
  about needing you, but a long approved command sounds exactly like a blocked one. The
  dashboard marks these `BLOCKED?` so the screen can say what the audio cannot.
- `resume` (default) — the part rejoins a few seconds after the prompt. Long commands
  sound right, but step away mid-prompt and the music returns while you are still needed.

### `subagents` — work nobody is sitting in front of

A sub-agent fires hooks but is never listed as an open session, so it is never a session
you are waiting at. Its parent, meanwhile, fires `agentStop` the moment it dispatches and
goes back to waiting:

- `fold` (default) — the sub-agent's work counts as its parent working, matched on the
  shared working directory. The dashboard marks the parent `SUB-AGENT`, so you can see the
  music is riding work that is not its own. A parent sitting on a permission prompt is
  never folded: a prompt is a real request for you and outranks inferred work.
- `ignore` — sub-agents count for nothing, and a parent falls silent while the work it
  dispatched runs.
- `voice` — each sub-agent takes an instrument of its own, which dilutes the signal: a
  fleet of them keeps the orchestra playing over the one session waiting on you.

Two terminals open on the same repository cannot be told apart, so folded work counts for
both.

### Bluetooth audio — playing your phone through this PC

With `bluetoothReceive` on, a phone paired with this machine can stream to it over A2DP,
and LLMFM gates *that* stream instead of playing a score. It is the nicest way to use the
product: your own music, silenced when an agent needs you.

Turning it on switches `audio` to `duck`, because only the duck gate can silence audio
LLMFM does not own. The two settings are held in step in both directions — choosing the
MIDI score turns Bluetooth receive back off.

Received audio arrives as an ordinary playback session on the current output device, so
LLMFM mutes **that session** rather than the whole output. Teams and your terminal bell
keep working while the phone is silenced. If the phone's session cannot be found, nothing
is muted and the dashboard says so, rather than silencing the endpoint and taking
everything else down with it.

> **Tested with iPhone only.** Android devices are **untested** — pairing, the A2DP sink
> and the per-session mute may all behave differently, and the device name LLMFM matches
> on is reported by the phone. If you try one, the dashboard's Bluetooth row and
> `node bin/llmfm.ts status` are the place to look first.

Windows must already have the phone paired; LLMFM opens the audio connection but does not
pair devices for you.

## Sessions started before the hooks were installed

Hooks are loaded once, at session start. A session opened before `install` never reports
through them, so it is tracked only through `open-sessions-state.json` — and that file
cannot see a mid-turn permission prompt. Such a session reads as *working* for its whole
turn, which keeps the music playing while it is actually waiting on you.

Since scope is machine-wide, one pre-install session is enough to hold the music on. Open
a fresh session after installing, resume the existing one in a new terminal, or pin audio
with `LLMFM_SESSION`.

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

When the score reaches its end the `autoplay` setting decides what happens: `off` loops
the current piece, `sequential` walks the library in order, and `random` draws from a
shuffled bag so every track is heard before any repeats and the piece just played is
never the next one. Sessions keep their voices across the change — the tree is rebuilt
and reassigned, and the outgoing score's notes are released before the new one binds.

### Browsing the library

`GET /tracks` returns every playable file with its title, composer, licence, format and
the number of voices the classifier finds in it. Anything at two voices or fewer is
flagged `holdMusicOnly`: a Bach prelude is a legitimate choice for a single session, but
it cannot tell four agents apart, and the UI should say so rather than hide it.
`POST /track` with `{"file": "..."}` switches tracks, and accepts only names that are
already in that list.

Each track also reports `integrity`. The licence in `tracks.json` was recorded against a
specific sha256, so sourcing a track and trusting a track are separate questions: a file
whose bytes no longer match its record reads `mismatch`, and a file with no recorded
digest — anything you supplied yourself — reads `unrecorded` rather than borrowing the
licence of the name it was given. `src/tracks.test.ts` fails if any shipped file drifts
from the record that licensed it.

MIDI is what the product is really built for: per-part volume gating means addressing each
instrument on its own channel. An mp3 or wav is one mixed stereo pair with no parts to
gate, so a recording is gated as a whole — it plays while any agent that is not muted is
working. `format` is reported per track so a client can explain that rather than
pretending a recording can be split.

Set **Sound source** to `duck` and LLMFM stops playing anything of its own. Instead it
rides whatever you are already playing — a browser, a media player, anything the machine
is mixing — by muting and unmuting the Windows output endpoint: your audio while the gate
is open, silence while an agent needs you. There is no pausing another application's
stream, and nothing about it is inspected: no app-specific code, no API, no network.

It is the mute flag rather than a level of zero, deliberately. Windows draws a muted
speaker in the tray, so on the one occasion we fail to put it back you can see why your
machine is silent and fix it in a click — where a level of zero reads as broken hardware or
a dropped connection. Unmuting also returns your level exactly.

The endpoint is borrowed, never taken. It is unmuted when you switch **Sound source** away,
when the daemon shuts down, and — because the bridge watches the daemon by handle — when
the daemon dies without saying so. A hard kill that takes the bridge with it is covered by
a claim file the next start reads. A mute or a level you change yourself becomes the new
baseline rather than something to restore over. Plug in a headset mid-session and the gate
follows it: the device you were on is put back before the new one is taken.

**On silence** applies to LLMFM's own music only. In duck mode there is no transport of
ours to pause or keep running, so it has no effect there: the gate closing always mutes.

Your own music lives in `playlists/`, beside the config, one folder per playlist —
`bundled/` is the shipped music, and anything you add is listed without a licence record,
because we have not verified one for it. See `playlists/README.md`.

## Music and licensing

LLMFM's own source is MIT — see [`LICENSE`](LICENSE). The bundled music is **not**: it is
third-party content redistributed under the licence each publisher states for it.

MIDI messages are sent to the synthesizer already installed on your machine. The
synthesizer's sample data (`gm.dls`) is never read, copied, extracted, or redistributed —
that is what its licence requires, and it is why there is nothing to download.

Bundled music comes from the [Mutopia Project](https://www.mutopiaproject.org/), which
states a licence per file. Some files are public domain; others are Creative Commons
Attribution or Attribution-ShareAlike and are redistributed with the credit their licence
requires. **See [`playlists/bundled/ATTRIBUTION.md`](playlists/bundled/ATTRIBUTION.md) for
the credits**, and `playlists/bundled/tracks.json` for the full provenance record — source
URL, stated licence, and the date retrieved — of every file.

A public-domain composition does not imply a public-domain sequence: a MIDI file of a
Beethoven symphony is its own copyrightable work. Only files whose licence is stated by
the publisher are shipped. `tools/curate-tracks.ts` fetches the library and records that
provenance; it is run by hand, and the daemon itself never touches the network.

Curation also screens for dynamics. A score whose notes all share one velocity is refused
before it is written into `playlists/bundled/`, because the signal this product sends is
one part fading out while the others carry on, and a flat score gives that fade nothing to move
against — it reads as the music breaking rather than as a voice leaving. Engraving tools
write a flat velocity unless dynamics were engraved, so every file is measured and none is
trusted for its source. `src/dynamics.test.ts` holds the bundled library to the same bar.

Instrumentation is corrected at load. Engraved editions routinely put a whole string
section on the solo GM patches and horns on 69, which is English Horn — a woodwind. A part
whose name says it is a section moves to String Ensemble, and a part named as a horn moves
to French Horn. The decision reads the part name, never the program alone, so a genuine
concerto soloist keeps the patch its score chose; `part.scoredProgram` keeps the original
for inspection.

## Privacy

No network egress, no telemetry, no third-party services. Hook payloads contain prompt
text and repository paths; they are parsed in memory and are not logged.
