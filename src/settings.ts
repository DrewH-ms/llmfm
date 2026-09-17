import {
  AUDIO_MODES,
  AUTOPLAY_MODES,
  DEFAULT_AUDIO,
  DEFAULT_AUTOPLAY,
  DEFAULT_FADE_SECONDS,
  DEFAULT_GATE_POLICY,
  DEFAULT_IDLE_DROPOUT_MINUTES,
  DEFAULT_MASTER_VOLUME,
  DEFAULT_PROMPT_GAP,
  DEFAULT_SILENCE_MODE,
  FADE_MAX_SECONDS,
  FADE_MIN_SECONDS,
  FADE_STEP_SECONDS,
  GATE_MODES,
  GATE_POLICIES,
  IDLE_DROPOUT_MAX_MINUTES,
  IDLE_DROPOUT_STEP_MINUTES,
  MASTER_VOLUME_MAX,
  MASTER_VOLUME_STEP,
  PROMPT_GAP_MODES,
  SILENCE_MODES,
} from './constants.ts';

/** A setting the dashboard can render and cycle without knowing what it means. Adding a
 *  setting here is the whole change: the menu, the wire format, and validation all read
 *  from this list.
 *
 *  That only holds within one process. The dashboard is a separate program with its own
 *  compiled copy, so a daemon left running from before a setting existed answers 400 to a
 *  menu that still offers it. The daemon therefore publishes this list on `/state` and the
 *  menu is built from what it sends, which is why the functions below take a spec rather
 *  than look one up by key. */
export type SettingSpec =
  | {
      kind: 'choice';
      key: string;
      title: string;
      help: string;
      choices: readonly string[];
      labels?: Readonly<Record<string, string>>;
    }
  | {
      kind: 'number';
      key: string;
      title: string;
      help: string;
      min: number;
      max: number;
      step: number;
      /** Printed after the number, e.g. 's'. Without it "Fade 2" names no quantity. */
      unit?: string;
      /** Rendered instead of the number at `min`, where a value often means "off". */
      zeroLabel?: string;
    }
  | { kind: 'toggle'; key: string; title: string; help: string };

export const SETTING_SPECS: readonly SettingSpec[] = [
  {
    kind: 'choice',
    key: 'mode',
    title: 'Sound means',
    help: 'Reward: an agent sounds while it works. Alert: it sounds when it needs you.',
    choices: GATE_MODES,
    labels: { reward: 'an agent is working', alert: 'an agent needs you' },
  },
  {
    kind: 'choice',
    key: 'gate',
    title: 'Play when',
    help: 'Which sessions the music answers to.',
    choices: GATE_POLICIES,
    labels: {
      'per-agent': 'each agent has a part',
      any: 'any agent is working',
      all: 'all agents are working',
      always: 'always',
    },
  },
  {
    kind: 'number',
    key: 'fadeSeconds',
    title: 'Fade',
    help: 'How long a part takes to fade in or out as its agent starts or stops.',
    min: FADE_MIN_SECONDS,
    max: FADE_MAX_SECONDS,
    step: FADE_STEP_SECONDS,
    unit: 's',
  },
  {
    kind: 'number',
    key: 'masterVolume',
    title: 'Master volume',
    help: 'Overall level, applied over every part.',
    min: 0,
    max: MASTER_VOLUME_MAX,
    step: MASTER_VOLUME_STEP,
  },
  {
    kind: 'choice',
    key: 'audio',
    title: 'Sound source',
    help: 'Play the score, or mute and unmute the music you are already playing.',
    choices: AUDIO_MODES,
    labels: { midi: 'play the score', duck: 'mute what you are playing' },
  },
  {
    kind: 'choice',
    key: 'silenceMode',
    title: 'On silence',
    help: "LLMFM's own music only: pause keeps your place in the score, mute keeps the transport running.",
    choices: SILENCE_MODES,
    labels: { pause: 'pause the transport', mute: 'mute, keep running' },
  },
  {
    kind: 'choice',
    key: 'promptGap',
    title: 'After you approve',
    help: 'The CLI says nothing when you answer a prompt. This is the guess for that gap.',
    choices: PROMPT_GAP_MODES,
    labels: { silent: 'assume still blocked', resume: 'assume work resumed' },
  },
  {
    kind: 'number',
    key: 'idleDropoutMinutes',
    title: 'Drop idle sessions',
    help: 'A closed terminal is never cleaned out of the CLI session file, so without this it keeps its instrument.',
    min: 0,
    max: IDLE_DROPOUT_MAX_MINUTES,
    step: IDLE_DROPOUT_STEP_MINUTES,
    unit: ' min',
    zeroLabel: 'never',
  },
  {
    kind: 'choice',
    key: 'autoplay',
    title: 'When a track ends',
    help: 'A track ending is the one silence that is never about you.',
    choices: AUTOPLAY_MODES,
    labels: { off: 'stop', sequential: 'play the next track', random: 'play a random track' },
  },
  {
    kind: 'toggle',
    key: 'bluetoothReceive',
    title: 'Bluetooth audio',
    help: 'Take audio from a phone paired with this PC. Turning this on switches the sound source to ducking, which is what gates the phone.',
  },
  {
    kind: 'toggle',
    key: 'startupMotif',
    title: 'Startup motif',
    help: 'Play the opening four notes when the daemon starts.',
  },
];

export const SETTING_DEFAULTS = {
  mode: GATE_MODES[0],
  gate: DEFAULT_GATE_POLICY,
  fadeSeconds: DEFAULT_FADE_SECONDS,
  masterVolume: DEFAULT_MASTER_VOLUME,
  audio: DEFAULT_AUDIO,
  silenceMode: DEFAULT_SILENCE_MODE,
  idleDropoutMinutes: DEFAULT_IDLE_DROPOUT_MINUTES,
  promptGap: DEFAULT_PROMPT_GAP,
  autoplay: DEFAULT_AUTOPLAY,
  bluetoothReceive: false,
  startupMotif: true,
} as const;

export function specFor(key: string): SettingSpec | null {
  return SETTING_SPECS.find((spec) => spec.key === key) ?? null;
}

function clampToStep(spec: Extract<SettingSpec, { kind: 'number' }>, value: number): number {
  const stepped = Math.round(value / spec.step) * spec.step;
  return Math.min(Math.max(stepped, spec.min), spec.max);
}

/** Validates an incoming value against the spec. Returns null for anything the spec does
 *  not allow, so the HTTP surface never has to know the shape of an individual setting. */
export function coerceSetting(key: string, value: unknown): string | number | boolean | null {
  const spec = specFor(key);
  return spec ? coerceWithSpec(spec, value) : null;
}

export function coerceWithSpec(
  spec: SettingSpec,
  value: unknown,
): string | number | boolean | null {
  if (spec.kind === 'choice') {
    return typeof value === 'string' && spec.choices.includes(value) ? value : null;
  }
  if (spec.kind === 'toggle') return typeof value === 'boolean' ? value : null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return clampToStep(spec, value);
}

/** The next value when the user cycles a setting, so the dashboard holds no per-setting
 *  logic. Numbers move by a step; choices and toggles wrap. */
export function nextSetting(
  key: string,
  current: unknown,
  direction: 1 | -1,
): string | number | boolean | null {
  const spec = specFor(key);
  return spec ? nextWithSpec(spec, current, direction) : null;
}

export function nextWithSpec(
  spec: SettingSpec,
  current: unknown,
  direction: 1 | -1,
): string | number | boolean | null {
  if (spec.kind === 'toggle') return !(current === true);
  if (spec.kind === 'number') {
    const base = typeof current === 'number' && Number.isFinite(current) ? current : spec.min;
    return clampToStep(spec, base + spec.step * direction);
  }
  const index = spec.choices.indexOf(String(current));
  const from = index >= 0 ? index : 0;
  const count = spec.choices.length;
  return spec.choices[(from + direction + count) % count] ?? null;
}

/** What the menu prints for a value. Kept beside the spec so both sides agree. */
export function displaySetting(key: string, value: unknown): string {
  const spec = specFor(key);
  return spec ? displayWithSpec(spec, value) : String(value);
}

export function displayWithSpec(spec: SettingSpec, value: unknown): string {
  if (spec.kind === 'toggle') return value === true ? 'on' : 'off';
  if (spec.kind === 'number') {
    const numeric = typeof value === 'number' ? value : spec.min;
    if (spec.zeroLabel && numeric === spec.min) return spec.zeroLabel;
    return `${numeric}${spec.unit ?? ''}`;
  }
  return spec.labels?.[String(value)] ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function labelsOf(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (typeof label === 'string') labels[key] = label;
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

function parseSpec(value: unknown): SettingSpec | null {
  if (!isRecord(value)) return null;
  const { kind, key, title, help } = value;
  if (typeof key !== 'string' || typeof title !== 'string' || typeof help !== 'string') return null;
  if (kind === 'toggle') return { kind, key, title, help };
  if (kind === 'choice') {
    const choices = stringList(value['choices']);
    // A choice with nothing to choose would render as a dead row that cycles to null.
    if (choices.length === 0) return null;
    const labels = labelsOf(value['labels']);
    return { kind, key, title, help, choices, ...(labels === undefined ? {} : { labels }) };
  }
  if (kind !== 'number') return null;
  const { min, max, step } = value;
  if (typeof min !== 'number' || typeof max !== 'number' || typeof step !== 'number') return null;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(step > 0) || max < min) return null;
  const unit = typeof value['unit'] === 'string' ? value['unit'] : undefined;
  const zeroLabel = typeof value['zeroLabel'] === 'string' ? value['zeroLabel'] : undefined;
  // Spread rather than assign: an explicit `unit: undefined` is a different object from one
  // without the key, and the round-trip test compares these against the compiled list.
  return {
    kind,
    key,
    title,
    help,
    min,
    max,
    step,
    ...(unit === undefined ? {} : { unit }),
    ...(zeroLabel === undefined ? {} : { zeroLabel }),
  };
}

/** The daemon's own setting list, narrowed. Returns an empty array for anything
 *  unusable, which callers read as "this daemon does not publish specs" and answer by
 *  falling back to their compiled copy. */
export function parseSettingSpecs(value: unknown): SettingSpec[] {
  if (!Array.isArray(value)) return [];
  const specs: SettingSpec[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const spec = parseSpec(entry);
    if (!spec || seen.has(spec.key)) continue;
    seen.add(spec.key);
    specs.push(spec);
  }
  return specs;
}
