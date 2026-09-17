import type { Voice, VoiceAssignment } from './types.ts';

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;
const BYTE_VALUES = 256;
const WORD_BITS = 32;

/** A node of the section → instrument → part tree, rebuilt from the voices' `path`s. */
type TreeNode = {
  voice: Voice | null;
  children: Map<string, TreeNode>;
};

function fnvStep(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
}

function hashString(value: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash = fnvStep(hash, code & BYTE_MASK);
    hash = fnvStep(hash, (code >>> BYTE_BITS) & BYTE_MASK);
  }
  return hash;
}

function hashWord(word: number): number {
  let hash = FNV_OFFSET_BASIS;
  for (let shift = 0; shift < WORD_BITS; shift += BYTE_BITS) {
    hash = fnvStep(hash, (word >>> shift) & BYTE_MASK);
  }
  return hash;
}

/** Extends the hash once exhausted so each level gets a fresh slice and earlier levels keep their answer. */
function createSliceReader(key: string): () => number {
  let word = hashString(key);
  let shift = 0;
  return () => {
    if (shift === WORD_BITS) {
      word = hashWord(word);
      shift = 0;
    }
    const slice = (word >>> shift) & BYTE_MASK;
    shift += BYTE_BITS;
    return slice;
  };
}

function chooseIndex(count: number, nextSlice: () => number): number {
  let value = 0;
  let range = 1;
  while (range < count) {
    value = value * BYTE_VALUES + nextSlice();
    range *= BYTE_VALUES;
  }
  return value % count;
}

/** Windows paths arrive in whatever casing and separator style the CLI reported; a repo must sound the same. */
function normalizeCwd(cwd: string): string {
  const unified = cwd.toLowerCase().replace(/[\\/]+/g, '/');
  return unified.endsWith('/') ? unified.slice(0, -1) : unified;
}

function buildTree(voices: Voice[]): TreeNode {
  const root: TreeNode = { voice: null, children: new Map() };
  for (const voice of voices) {
    let node = root;
    for (const step of voice.path) {
      const existing = node.children.get(step);
      if (existing) {
        node = existing;
        continue;
      }
      const child: TreeNode = { voice: null, children: new Map() };
      node.children.set(step, child);
      node = child;
    }
    node.voice = voice;
  }
  return root;
}

function descend(root: TreeNode, key: string): Voice | null {
  const nextSlice = createSliceReader(key);
  let node = root;
  while (node.children.size > 0) {
    const steps = [...node.children.keys()].sort();
    const step = steps[chooseIndex(steps.length, nextSlice)];
    const child = step === undefined ? undefined : node.children.get(step);
    if (!child) return node.voice;
    node = child;
  }
  return node.voice;
}

function commonPrefixLength(left: string[], right: string[]): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

/** Nearest free voice to `preferred` — longest shared branch, then next round the list — so a displaced session stays near. */
function probe(options: {
  voices: Voice[];
  preferredIndex: number;
  taken: Set<string>;
}): Voice | null {
  const { voices, preferredIndex, taken } = options;
  const preferred = voices[preferredIndex];
  if (!preferred) return null;

  let best: Voice | null = null;
  let bestShared = -1;
  for (let offset = 1; offset < voices.length; offset += 1) {
    const candidate = voices[(preferredIndex + offset) % voices.length];
    if (!candidate || taken.has(candidate.voiceId)) continue;
    const shared = commonPrefixLength(preferred.path, candidate.path);
    if (shared > bestShared) {
      best = candidate;
      bestShared = shared;
    }
  }
  return best;
}

export function assignVoices(options: {
  sessions: { sessionId: string; cwd: string | null }[];
  voices: Voice[];
}): VoiceAssignment {
  const { sessions, voices } = options;
  const root = buildTree(voices);
  const indexById = new Map(voices.map((voice, index) => [voice.voiceId, index]));

  const bySession = new Map<string, Voice>();
  const unvoicedSessionIds: string[] = [];
  const taken = new Set<string>();

  for (const session of sessions) {
    if (bySession.has(session.sessionId)) continue;
    const key = session.cwd === null ? session.sessionId : normalizeCwd(session.cwd);
    const preferred = descend(root, key);
    const preferredIndex = preferred === null ? undefined : indexById.get(preferred.voiceId);

    let voice: Voice | null = null;
    if (preferred && !taken.has(preferred.voiceId)) {
      voice = preferred;
    } else if (preferredIndex !== undefined) {
      voice = probe({ voices, preferredIndex, taken });
    }

    if (!voice) {
      unvoicedSessionIds.push(session.sessionId);
      continue;
    }
    taken.add(voice.voiceId);
    bySession.set(session.sessionId, voice);
  }

  return { bySession, unvoicedSessionIds };
}
