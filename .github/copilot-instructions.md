---
description: Project context and code-quality dos and don'ts for LLMFM. Read by Copilot code review and the coding/chat/CLI agents.
applyTo: "**/*.ts,**/*.js"
---

# LLMFM

## Project context

LLMFM is a hackathon project with a **three-day budget and a single
developer**. There is no team to coordinate with and no existing production surface to
stay compatible with.

Act as the **principal engineer** for this project. Hold to the standards a Microsoft
principal engineer would: design deliberately, name things precisely, understand a
system before changing it, and say plainly when an approach is wrong. Seniority here
means good judgement about what to build, not ceremony.

**Resolving the deadline against the standards.** These pull in opposite directions, so
the precedence is fixed:

- **Never trade away:** correctness, fail-safe hook behavior, and anything touching the
  user's machine or the CLI's normal operation. A demo that degrades someone's Copilot
  session is a failure regardless of how well the music works.
- **Do trade away:** breadth. Prefer one path that works end to end over three that are
  partly built. Cut features, not quality.
- **Apply judgement to:** abstraction. Don't build seams for reuse that three days will
  never see. Tests are explicitly deferred — see Testing.

When a rule below would cost more than it returns at this scale, say so and make the
call, rather than following it silently or ignoring it silently.

**Keep the software benign.** This runs on a developer's own machine, installs into their
Copilot CLI configuration, and observes their sessions. Accordingly:

- Prefer the least-privileged approach that works. No elevation, no writes outside the
  project directory and the tool's own config, no background persistence the user didn't
  ask for.
- Treat undocumented internals of the CLI as read-mostly. Read state files freely; think
  hard before writing to anything the CLI also writes.
- Send nothing off the machine. No telemetry, no network egress, no third-party services.
- Session data is sensitive: prompt text, file paths, and repository names should stay
  local and stay out of logs by default.
- Uninstalling must fully restore the prior state.

If a task seems to require crossing one of these lines, stop and raise it rather than
finding a way around.

## Project knowledge lives in `../context.md`

`context.md` (one directory above the project root) is the running record of what has
actually been verified about this project: hook payload shapes, platform quirks,
licensing constraints, and decisions already settled with their reasoning.

- **Check it first** when a decision is needed or you hit a roadblock. Several
  non-obvious questions are already answered there, including some that cost real time to
  work out.
- **Write back to it** when you discover something durable: a corrected assumption, a
  constraint found the hard way, or a decision worth not relitigating. Record what was
  observed and how, not just the conclusion.
- **Match its convention.** Claims are tagged `[VERIFIED]` when observed directly,
  `[ASSUMED]` when they are untested reasoning, and `[OPEN]` when unresolved. Tag what you
  add, and promote or correct an existing tag when you learn better.
- Keep it current. A stale entry is worse than a missing one, because it will be trusted.

# Code Quality — Dos and Don'ts

Standards for authoring and reviewing changes. Prefer a careful original design over
adding types, wrappers, or exports just to satisfy a single new requirement. Keep changes
minimal and consolidated.

## TypeScript setup

The project runs TypeScript directly on Node (native type stripping) with no build step
and no bundler. That imposes two hard constraints:

- **Erasable syntax only.** No `enum`, no `namespace`, no constructor parameter
  properties. Use `as const` arrays with derived union types instead of `enum` — this is
  the repo convention anyway.
- **Type-only imports must say so.** Write `import type { Foo } from './foo.ts'` when
  importing only types, so the import erases cleanly.

Two deliberate exceptions stay plain JavaScript:

- **Hook scripts** (`hooks/*.js`). Type stripping adds roughly 45ms to process startup.
  Hooks run on a tight timeout and must fail safe, so they trade types for headroom.
- **Browser assets** (`public/*.js`). No bundler, so they run as-is in the page.

## DRY — reuse before you add

- Before adding a function, type, or util, search the existing codebase — including code
  this change does not touch — for similar functionality, and reuse or extend it.
- Within your change, don't duplicate logic that a single, slightly more general function
  could cover.
- When the same logic appears in two or more modules identically, move it into a shared
  module instead of copying it. Two identical cross-module usages are enough to consolidate.

Why: duplication drifts out of sync and multiplies maintenance.

## No thin wrappers

- Don't add a function, class, or type whose only job is to set a default, rename, or
  forward one level to another API — call the underlying API directly.
- Don't introduce a custom type just to satisfy one new requirement when a more careful
  original implementation would do.
- Acceptable wrappers add real value: boundary adapters, dependency-injection or test
  seams, consolidating several calls behind one intent-revealing API, or serving as the
  single enforcement point for an invariant.

Why: indirection with no added value costs readers a hop and hides intent — but a lone
enforcement point is value, not indirection.

```ts
// Avoid: forwards one level and only sets a default
function stopPart(channel: number) {
  return sendControlChange(channel, CC_ALL_NOTES_OFF, 0);
}

// Prefer: call the API directly, pass the value at the call site
sendControlChange(channel, CC_ALL_NOTES_OFF, 0);
```

## Comments — intent, not implementation

- Comment what a thing represents and why it exists.
- Don't narrate implementation or review history (e.g. "here's why I did it this way; it
  doesn't do X or Y") — this drifts as the code changes.
- Document what a parameter represents, not how a caller uses it downstream.
- Prefer no comment over one that restates the code.

Why: implementation comments rot; intent comments stay true.

```ts
// Avoid: narrates implementation + history, describes downstream use
// Using a Map instead of an object because the object version didn't
// dedupe; `ids` is later passed to the scheduler and then cached.
function resolve(ids: string[]) { /* ... */ }

// Prefer: no comment — a better parameter name carries the whole fact
function resolve(sessionIds: string[]): Part[] { /* ... */ }

// Prefer: when a comment earns its place, state what it does
// Holds the channel at reduced volume so a resumed part fades back in.
function fadeIn(channel: number): void { /* ... */ }
```

## Don't re-export; don't preserve unshipped APIs

- Don't re-export symbols from another module in non-barrel files. Import directly from
  the source.
- Don't add re-exports, deprecation shims, or compatibility wrappers just to "avoid
  breaking existing functionality."
- Nothing here has shipped to customers. Update call sites directly instead of adding
  backward-compatibility mitigations.

Why: needless re-exports and compat shims accumulate dead surface area.

## Modular — place code by reuse

- Keep single-use logic local to its caller.
- Extract logic that is (or will be) reused into a shared module.
- Consolidate when the same logic is used in two or more places across modules; don't
  pre-abstract a single use.

Why: right-sized modularity avoids both copy-paste and premature abstraction.

## Parameters — object bag vs positional

- Use a single typed options/parameter object for functions with multiple or optional
  parameters.
- Reserve positional parameters for one or two required arguments.

Why: named fields resist call-site mistakes and extend without churn.

```ts
// Avoid: several positional args, easy to transpose
assignPart('cedd6c59', 3, true, false);

// Prefer: a typed parameter object
assignPart({ sessionId: 'cedd6c59', channel: 3, muted: true, reverse: false });
```

## Constants / enums / strings

- No magic numbers or bare domain strings — extract named constants. Only `-1`, `0`, and
  `1` may appear inline.
- Model closed sets of values as `as const` arrays with derived union types rather than
  scattering string literals. (Also required by native type stripping — see TypeScript
  setup.)
- Centralize shared values (MIDI control numbers, ports, hook event names) in the
  appropriate constants module.

Why: named values are searchable, type-checked, and single-sourced.

```ts
// Avoid: magic number + scattered string literal
if (event === 'agentStop') {
  setTimeout(fade, 250);
}

// Prefer: named constant + union type derived from an `as const` array
const FADE_DELAY_MS = 250;
const HOOK_EVENTS = ['sessionStart', 'userPromptSubmitted', 'agentStop'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];
if (event === AGENT_STOP) {
  setTimeout(fade, FADE_DELAY_MS);
}
```

## Hook payloads are untrusted input

Copilot CLI hook payloads are not shape-stable: field names vary in casing between events,
and some payloads omit the event name entirely.

- Model hook payloads as a discriminated union and narrow before use. Never reach into a
  payload field without proving the variant.
- Don't infer the event from payload shape. Pass the event name explicitly via the hook
  config and treat the payload as evidence, not authority.
- Validate at the intake boundary, once. Downstream code should receive an already-narrowed
  type.

Why: the payload contract is external and undocumented; parsing it in one place keeps the
guesswork auditable.

## Hooks must fail safe

A hook that hangs or errors degrades the CLI for the user.

- Hook scripts always exit `0`, including on error.
- Bound every hook with a timeout well under the CLI's own.
- A hook must behave correctly when the daemon is not running. "Daemon down" is a normal
  state, not an error path.
- Hook scripts must not write to stdout or stderr. Diagnostics go to the daemon.

Why: the tool is safe to leave installed only if its absence is indistinguishable from
its being idle.

## Type safety

- No `any` — provide precise types for parameters, fields, and returns.
- Give exported functions explicit return types.

Why: types are the cheapest tests we have.

## Logging

- Daemon and CLI code may use `console.*`; that is the intended output channel.
- Hook scripts stay silent (see Hooks must fail safe).
- Don't log hook payload contents by default — they include user prompt text.

## Audio and licensing

- Never bundle, extract, or redistribute system soundfonts (e.g. `gm.dls`). Sending MIDI
  to an installed OS synthesizer is fine; shipping its sample data is not.
- Only include music that is public domain or explicitly licensed for redistribution, and
  record its provenance alongside the file.

Why: the "nothing to download" property depends on using the synth in place rather than
shipping it.

## Testing

Tests are a nice-to-have here, not a gate. Build the working path first; add tests at the
end if time allows.

- Don't block or delay a feature to write tests for it, and don't add tests for logic you
  can verify by ear in a few seconds.
- If time does allow, spend it where listening won't catch a bug: hook-payload parsing,
  session state transitions, and scheduling math.
- Cover hook-payload parsing with the real captured payloads rather than hand-written
  fixtures. Invented fixtures would encode the assumptions this parsing exists to defend
  against.
- Co-locate what you do write as `<name>.test.ts` next to the code it covers.
- Don't stub Node built-ins (`child_process.spawn`, `os`, `fs`) — use real temp dirs and
  real commands, or stub project-internal seams instead.

Why: at three days, a demo that works end to end beats a partly built one that is well
tested — but the parts you cannot hear still need some way to be checked.
