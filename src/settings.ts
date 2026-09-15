import {
  DEFAULT_GATE_POLICY,
  DEFAULT_IDLE_DROPOUT_MINUTES,
  DEFAULT_MASTER_VOLUME,
  DEFAULT_PROMPT_GAP,
  DEFAULT_SILENCE_MODE,
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
 *  from this list, so the two sides cannot drift the way the hook config once did. */
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
      /** Rendered instead of the number at `min`, where a value often means "off". */
      zeroLabel?: string;
    }
  | { kind: 'toggle'; key: string; title: string; help: string };

export const SETTING_SPECS: readonly SettingSpec[] = [
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
    key: 'masterVolume',
    title: 'Master volume',
    help: 'Overall level, applied over every part.',
    min: 0,
    max: MASTER_VOLUME_MAX,
    step: MASTER_VOLUME_STEP,
  },
  {
    kind: 'choice',
    key: 'silenceMode',
    title: 'On silence',
    help: 'Pause keeps your place in the score; mute keeps the transport running.',
    choices: SILENCE_MODES,
    labels: { pause: 'pause the transport', mute: 'mute, keep running' },
  },
  {
    kind: 'number',
    key: 'idleDropoutMinutes',
    title: 'Drop idle sessions',
    help: 'A closed terminal is never cleaned out of the CLI session file, so without this it keeps its instrument.',
    min: 0,
    max: IDLE_DROPOUT_MAX_MINUTES,
    step: IDLE_DROPOUT_STEP_MINUTES,
    zeroLabel: 'never',
  },
  {
    kind: 'choice',
    key: 'promptGap',
    title: 'After a prompt',
    help: 'Nothing is emitted when you answer a prompt, so this is a guess either way.',
    choices: PROMPT_GAP_MODES,
    labels: { silent: 'stay silent', resume: 'resume after a pause' },
  },
  {
    kind: 'toggle',
    key: 'startupMotif',
    title: 'Startup motif',
    help: 'Play the opening four notes when the daemon starts.',
  },
];

export const SETTING_DEFAULTS = {
  gate: DEFAULT_GATE_POLICY,
  masterVolume: DEFAULT_MASTER_VOLUME,
  silenceMode: DEFAULT_SILENCE_MODE,
  idleDropoutMinutes: DEFAULT_IDLE_DROPOUT_MINUTES,
  promptGap: DEFAULT_PROMPT_GAP,
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
  if (!spec) return null;
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
  if (!spec) return null;
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
  if (!spec) return String(value);
  if (spec.kind === 'toggle') return value === true ? 'on' : 'off';
  if (spec.kind === 'number') {
    const numeric = typeof value === 'number' ? value : spec.min;
    if (spec.zeroLabel && numeric === spec.min) return spec.zeroLabel;
    return String(numeric);
  }
  return spec.labels?.[String(value)] ?? String(value);
}
