import {
  CONTINUITY_WINDOW_SECONDS,
  FALLBACK_SECTION,
  MIN_VOICE_CONTINUITY,
  PERCUSSION_CHANNEL,
  SECTIONS,
  SECTION_PROGRAM_RANGES,
} from './constants.ts';
import type { SectionName } from './constants.ts';
import { labelWithOrdinal, parsePartName } from './part-names.ts';
import type { Part, Score, ScoredNote, Voice, VoiceTree } from './types.ts';

/** GM patch names, used to label an instrument whose parts carry no name in common. */
const GM_PROGRAM_NAMES = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
  'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass',
  'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Choir', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
  'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
  'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
] as const;

const PERCUSSION_SECTION: SectionName = 'Percussion';

const SECTION_VOICE_PREFIX = 'section';
const INSTRUMENT_VOICE_PREFIX = 'instrument';
const PART_VOICE_PREFIX = 'part';
const VOICE_ID_SEPARATOR = '-';
/** Grouping key for parts whose names name no instrument, so they still group by patch. */
const PROGRAM_KEY_PREFIX = 'program';

/** Onsets closer together than this are heard as the same attack, and so as a doubling. */
const ONSET_QUANTUM_SECONDS = 0.05;
const PITCH_CLASSES = 12;
/** Mean-pitch gap at which two voices no longer mask one another. */
const REGISTER_SPREAD_SEMITONES = 12;

/** How the three signals trade off when ranking a node as a candidate voice. Continuity
 *  leads because a voice that rests reads as a stopped agent; independence follows
 *  because muting a doubled line barely changes what is heard. */
const CONTINUITY_WEIGHT = 0.5;
const INDEPENDENCE_WEIGHT = 0.3;
const REGISTER_WEIGHT = 0.2;

/** A node only subdivides if doing so yields more than one voice. */
const MIN_SPLIT_CHILDREN = 2;

type VoiceNode = {
  voiceId: string;
  name: string;
  partIds: string[];
  path: string[];
  children: VoiceNode[];
  notes: ScoredNote[];
};

/** Quantised onsets to the pitch classes struck on them: the shape two nodes are compared
 *  on to decide whether one is merely doubling the other. */
type OnsetShape = Map<number, Set<number>>;

/** Where a part's section came from. Reported so the curation tooling can measure how
 *  often a real file's GM programs are load-bearing, and how often they are absent. */
export const SECTION_SOURCES = ['percussion', 'name', 'program', 'fallback'] as const;
export type SectionSource = (typeof SECTION_SOURCES)[number];

/** Track names outrank GM programs here: an engraver that emits MIDI as a by-product
 *  leaves every track on program 0, which would file a whole string quartet under
 *  Keyboard, whereas a name that resolves to an instrument is never that wrong. */
export function classifyPart(part: Part): { section: SectionName; source: SectionSource } {
  if (part.percussion || part.channel === PERCUSSION_CHANNEL) {
    return { section: PERCUSSION_SECTION, source: 'percussion' };
  }
  const named = parsePartName(part.name).section;
  if (named) return { section: named, source: 'name' };
  const range = SECTION_PROGRAM_RANGES.find(
    (candidate) => part.program >= candidate.from && part.program <= candidate.to,
  );
  if (range) return { section: range.section, source: 'program' };
  return { section: FALLBACK_SECTION, source: 'fallback' };
}

function continuityOf(notes: ScoredNote[], duration: number): number {
  const windows = Math.max(1, Math.ceil(duration / CONTINUITY_WINDOW_SECONDS));
  const sounding = new Set<number>();
  for (const note of notes) {
    const first = Math.floor(note.time / CONTINUITY_WINDOW_SECONDS);
    const last = Math.floor((note.time + note.duration) / CONTINUITY_WINDOW_SECONDS);
    for (let window = first; window <= last && window < windows; window += 1) sounding.add(window);
  }
  return sounding.size / windows;
}

function onsetShapeOf(notes: ScoredNote[]): OnsetShape {
  const shape: OnsetShape = new Map();
  for (const note of notes) {
    const onset = Math.round(note.time / ONSET_QUANTUM_SECONDS);
    const classes = shape.get(onset) ?? new Set<number>();
    classes.add(note.midi % PITCH_CLASSES);
    shape.set(onset, classes);
  }
  return shape;
}

/** Fraction of `shape`'s attacks that `other` also strikes at the unison or octave. */
function doublingOf(shape: OnsetShape, other: OnsetShape): number {
  if (shape.size === 0) return 0;
  let matched = 0;
  for (const [onset, classes] of shape) {
    const otherClasses = other.get(onset);
    if (!otherClasses) continue;
    for (const pitchClass of classes) {
      if (otherClasses.has(pitchClass)) {
        matched += 1;
        break;
      }
    }
  }
  return matched / shape.size;
}

function meanPitchOf(notes: ScoredNote[]): number {
  if (notes.length === 0) return 0;
  let total = 0;
  for (const note of notes) total += note.midi;
  return total / notes.length;
}

/** A name that carries nothing is worse than no name: told to listen for "one:" or "RH",
 *  a listener has nothing to find. The GM patch is then the better label, even where it
 *  was too coarse to have settled the section. */
function partLabel(part: Part): string {
  const parsed = parsePartName(part.name);
  if (parsed.placeholder) return GM_PROGRAM_NAMES[part.program] ?? parsed.label;
  return parsed.label;
}

function instrumentKey(part: Part): string {
  const { instrument } = parsePartName(part.name);
  return instrument ?? `${PROGRAM_KEY_PREFIX}${VOICE_ID_SEPARATOR}${part.program}`;
}

function instrumentName(parts: Part[]): string {
  const [first, ...rest] = parts;
  if (!first) return FALLBACK_SECTION;
  const { instrument } = parsePartName(first.name);
  if (instrument) return instrument;
  if (rest.every((part) => partLabel(part) === partLabel(first))) return partLabel(first);
  return GM_PROGRAM_NAMES[first.program] ?? partLabel(first);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, VOICE_ID_SEPARATOR).replace(/^-|-$/g, '');
}

function partNode(part: Part): VoiceNode {
  return {
    voiceId: `${PART_VOICE_PREFIX}${VOICE_ID_SEPARATOR}${part.partId}`,
    name: partLabel(part),
    partIds: [part.partId],
    path: [],
    children: [],
    notes: part.notes,
  };
}

/** Two desks of the same instrument reach us indistinguishable whenever the score named
 *  neither, and half-named whenever it named only some. Either way the whole group is
 *  renumbered by track order, because a listener counting desks needs the numbering to be
 *  complete before it means anything. */
function numberedParts(parts: Part[]): VoiceNode[] {
  const nodes = parts.map(partNode);
  const distinct = new Set(nodes.map((node) => node.name));
  if (distinct.size === nodes.length) return nodes;
  return nodes.map((node, index) => ({
    ...node,
    name: labelWithOrdinal(instrumentName(parts), index + 1),
  }));
}

function groupNode(options: {
  voiceId: string;
  name: string;
  children: VoiceNode[];
}): VoiceNode {
  const { voiceId, name, children } = options;
  return {
    voiceId,
    name,
    partIds: children.flatMap((child) => child.partIds),
    path: [],
    children,
    notes: children.flatMap((child) => child.notes),
  };
}

/** A lone child says nothing its parent does not, so the chain collapses to the coarsest
 *  node. A chain ending in a single part takes that part's name, which is what a listener
 *  can actually pick out. */
function collapsed(node: VoiceNode): VoiceNode {
  const children = node.children.map(collapsed);
  const only = children.length === 1 ? children[0] : undefined;
  if (!only) return { ...node, children };
  return {
    ...node,
    name: only.children.length === 0 ? only.name : node.name,
    children: only.children,
  };
}

function withPaths(node: VoiceNode, parentPath: string[]): VoiceNode {
  const path = [...parentPath, node.voiceId];
  return { ...node, path, children: node.children.map((child) => withPaths(child, path)) };
}

function descendants(node: VoiceNode): VoiceNode[] {
  return [node, ...node.children.flatMap(descendants)];
}

function sectionNodes(parts: Part[]): VoiceNode[] {
  const bySection = new Map<SectionName, Part[]>();
  for (const part of parts) {
    const section = classifyPart(part).section;
    bySection.set(section, [...(bySection.get(section) ?? []), part]);
  }

  const ordered = SECTIONS.filter((section) => bySection.has(section));
  return ordered.map((section) => {
    const members = bySection.get(section) ?? [];
    const byInstrument = new Map<string, Part[]>();
    for (const part of members) {
      const key = instrumentKey(part);
      byInstrument.set(key, [...(byInstrument.get(key) ?? []), part]);
    }
    const instruments = [...byInstrument].map(([key, instrumentParts]) =>
      groupNode({
        voiceId: [INSTRUMENT_VOICE_PREFIX, slug(section), slug(key)].join(VOICE_ID_SEPARATOR),
        name: instrumentName(instrumentParts),
        children: numberedParts(instrumentParts),
      }),
    );
    return groupNode({
      voiceId: `${SECTION_VOICE_PREFIX}${VOICE_ID_SEPARATOR}${slug(section)}`,
      name: section,
      children: instruments,
    });
  });
}

function toVoice(node: VoiceNode): Voice {
  return { voiceId: node.voiceId, name: node.name, partIds: node.partIds, path: node.path };
}

/**
 * Groups a score into section → instrument → part and ranks every grouping on how well it
 * would carry a session: how much of the piece it sounds in, how little it doubles another
 * line, and how far its register sits from the voices already offered.
 *
 * Parts too sparse to pass `MIN_VOICE_CONTINUITY` are held back as backing, so no session
 * is ever given a line whose written rests would be mistaken for it stopping.
 */
export function buildVoiceTree(score: Score): VoiceTree {
  const voicedParts = score.parts.filter(
    (part) => continuityOf(part.notes, score.duration) >= MIN_VOICE_CONTINUITY,
  );
  const backingPartIds = score.parts
    .filter((part) => !voicedParts.includes(part))
    .map((part) => part.partId);

  const roots = sectionNodes(voicedParts).map((node) => withPaths(collapsed(node), []));
  const everyNode = roots.flatMap(descendants);
  const shapes = new Map(everyNode.map((node) => [node.voiceId, onsetShapeOf(node.notes)]));
  const meanPitch = new Map(everyNode.map((node) => [node.voiceId, meanPitchOf(node.notes)]));

  const baseScore = new Map(
    everyNode.map((node) => {
      const shape = shapes.get(node.voiceId) ?? new Map<number, Set<number>>();
      const overlaps = (other: VoiceNode): boolean =>
        other.partIds.some((partId) => node.partIds.includes(partId));
      const doubling = everyNode
        .filter((other) => other !== node && !overlaps(other))
        .reduce(
          (worst, other) =>
            Math.max(worst, doublingOf(shape, shapes.get(other.voiceId) ?? new Map())),
          0,
        );
      const continuity = continuityOf(node.notes, score.duration);
      return [
        node.voiceId,
        CONTINUITY_WEIGHT * continuity + INDEPENDENCE_WEIGHT * (1 - doubling),
      ];
    }),
  );

  const rankOf = (node: VoiceNode): number => baseScore.get(node.voiceId) ?? 0;

  const separationFrom = (node: VoiceNode, chosen: VoiceNode[]): number => {
    if (chosen.length === 0) return 1;
    const mean = meanPitch.get(node.voiceId) ?? 0;
    const nearest = Math.min(
      ...chosen.map((other) => Math.abs(mean - (meanPitch.get(other.voiceId) ?? 0))),
    );
    return Math.min(1, nearest / REGISTER_SPREAD_SEMITONES);
  };

  /** Ranks siblings in the order they should be offered, each pick judged against the
   *  voices already sounding so the set spreads across the register. */
  const offerOrder = (candidates: VoiceNode[], alongside: VoiceNode[]): VoiceNode[] => {
    const remaining = [...candidates].sort(
      (a, b) => rankOf(b) - rankOf(a) || a.voiceId.localeCompare(b.voiceId),
    );
    const picked: VoiceNode[] = [];
    while (remaining.length > 0) {
      let bestIndex = 0;
      let bestValue = -1;
      for (const [index, candidate] of remaining.entries()) {
        const value =
          rankOf(candidate) + REGISTER_WEIGHT * separationFrom(candidate, [...alongside, ...picked]);
        if (value > bestValue) {
          bestValue = value;
          bestIndex = index;
        }
      }
      picked.push(...remaining.splice(bestIndex, 1));
    }
    return picked;
  };

  const rootOrder = offerOrder(roots, []);

  return {
    backingPartIds,
    voicesFor(sessionCount: number): Voice[] {
      const wanted = Math.max(1, sessionCount);
      let offered = rootOrder.slice(0, Math.min(wanted, rootOrder.length));

      while (offered.length < wanted) {
        const splittable = offered.filter((node) => node.children.length >= MIN_SPLIT_CHILDREN);
        if (splittable.length === 0) break;
        const target = splittable.reduce((best, node) => (rankOf(node) > rankOf(best) ? node : best));
        const index = offered.indexOf(target);
        const alongside = offered.filter((node) => node !== target);
        const needed = wanted - offered.length + 1;
        const children = offerOrder(target.children, alongside).slice(0, needed);
        offered = [...offered.slice(0, index), ...children, ...offered.slice(index + 1)];
      }

      return offered.map(toVoice);
    },
  };
}
