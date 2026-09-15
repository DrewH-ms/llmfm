import type { SectionName } from './constants.ts';

/** What a MIDI track name yields once the sequencer's spelling is discounted.
 *
 *  A track name is the only evidence that separates lines a listener can name apart —
 *  Violin I from Violin II — and it is the evidence most often mangled. GM program
 *  numbers survive worse: engraving tools that emit MIDI as a by-product leave every
 *  track on program 0, so a name that resolves to an instrument outranks the program. */
export type PartName = {
  raw: string;
  /** Canonical English instrument, or null when the name names no instrument. */
  instrument: string | null;
  section: SectionName | null;
  /** Desk number within the instrument: Violin II is 2. */
  ordinal: number | null;
  /** What the listener is told to listen for. */
  label: string;
  /** The name carries no information at all: empty, or a sequencer's filler. */
  placeholder: boolean;
};

type InstrumentEntry = {
  canonical: string;
  section: SectionName;
  /** Whole-word spellings, already normalized. Ordered entries are searched in the order
   *  declared, so a compound name must precede the shorter name it contains. */
  aliases: string[];
};

/** Beyond this a number is a catalogue or opus reference, not a desk. */
const MAX_PART_ORDINAL = 8;

const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] as const;

const ORDINAL_WORDS = new Map<string, number>([
  ['i', 1], ['ii', 2], ['iii', 3], ['iv', 4], ['v', 5], ['vi', 6], ['vii', 7], ['viii', 8],
  ['1st', 1], ['2nd', 2], ['3rd', 3], ['4th', 4], ['5th', 5], ['6th', 6], ['7th', 7], ['8th', 8],
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8],
  ['first', 1], ['second', 2], ['third', 3], ['fourth', 4],
  ['primo', 1], ['prima', 1], ['secondo', 2], ['seconda', 2], ['terzo', 3], ['terza', 3],
  ['quarto', 4], ['quarta', 4],
  ['erste', 1], ['erster', 1], ['zweite', 2], ['zweiter', 2], ['dritte', 3], ['vierte', 4],
  ['premier', 1], ['premiere', 1], ['deuxieme', 2], ['troisieme', 3], ['quatrieme', 4],
]);

/** Names an engraver writes when the score gave it nothing, including the staff and
 *  context identifiers LilyPond leaks into the MIDI track name. */
const PLACEHOLDER_PATTERN = new RegExp(
  `^(?:track|trk|trak|staff|stave|stff|part|voice|vox|channel|chan|ch|midi|instrument|instr|inst|` +
    `untitled|unnamed|unknown|none|no name|new|default|music|score|global|main|melody|` +
    `solo|soli|acc|accomp|accompaniment|up|down|upper|lower|rh|lh|treble|` +
    `nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|` +
    `${[...ORDINAL_WORDS.keys()].filter((word) => /^[a-z]+$/.test(word)).join('|')}` +
    `)?\\s*\\d*$`,
);

/** Transposition the score prints after the instrument: "in Mi b", "in B flat", "en Fa". */
const TRANSPOSITION_PATTERN =
  /\b(in|en)\s+(a|b|c|d|e|f|g|h|do|re|ut|mi|fa|sol|la|si|as|es|is|ces|ges|bb|eb|ab|db|gb)\b(\s+(b|flat|sharp|bemol|bemolle|diesis|dur|moll|major|minor|maggiore|minore))?/g;

/** Read top to bottom: compound names first, so "cor anglais" is not taken for a horn and
 *  "basso continuo" is not taken for a double bass. */
const INSTRUMENTS: InstrumentEntry[] = [
  {
    canonical: 'English Horn',
    section: 'Woodwinds',
    aliases: ['english horn', 'cor anglais', 'corno inglese', 'corni inglesi', 'englischhorn'],
  },
  {
    canonical: 'Contrabassoon',
    section: 'Woodwinds',
    aliases: [
      'contrabassoon', 'double bassoon', 'controfagotto', 'contrafagotto', 'kontrafagott',
      'contrebasson', 'cbsn', 'cfg',
    ],
  },
  {
    canonical: 'Continuo',
    section: 'Keyboard',
    aliases: ['continuo', 'basso continuo', 'bc', 'figured bass', 'generalbass'],
  },
  {
    canonical: 'Piccolo',
    section: 'Woodwinds',
    aliases: ['piccolo', 'piccolos', 'ottavino', 'flauto piccolo', 'kleine flote', 'picc', 'pic'],
  },
  {
    canonical: 'Flute',
    section: 'Woodwinds',
    aliases: [
      'flute', 'flutes', 'flauto', 'flauti', 'flote', 'floete', 'floeten', 'floten', 'querflote',
      'traverso', 'fl', 'fls', 'flt', 'flts',
    ],
  },
  {
    canonical: 'Recorder',
    section: 'Woodwinds',
    aliases: ['recorder', 'recorders', 'blockflote', 'blockfloete', 'flauto dolce', 'flute a bec'],
  },
  {
    canonical: 'Oboe',
    section: 'Woodwinds',
    aliases: ['oboe', 'oboes', 'oboi', 'hautbois', 'hoboe', 'ob', 'obs'],
  },
  {
    canonical: 'Clarinet',
    section: 'Woodwinds',
    aliases: [
      'clarinet', 'clarinets', 'clarinetto', 'clarinetti', 'clarinette', 'clarinettes',
      'klarinette', 'klarinetten', 'cl', 'cls', 'clt', 'clar',
    ],
  },
  {
    canonical: 'Bassoon',
    section: 'Woodwinds',
    aliases: [
      'bassoon', 'bassoons', 'fagotto', 'fagotti', 'fagott', 'fagotte', 'basson', 'bassons',
      'fag', 'fg', 'bsn', 'bssn',
    ],
  },
  {
    canonical: 'Saxophone',
    section: 'Woodwinds',
    aliases: ['saxophone', 'saxophones', 'saxofon', 'sax', 'saxes', 'sassofono'],
  },
  {
    canonical: 'Horn',
    section: 'Brass',
    aliases: [
      'horn', 'horns', 'french horn', 'french horns', 'corno', 'corni', 'cor', 'cors',
      'waldhorn', 'waldhorner', 'horner', 'hn', 'hns', 'hrn', 'hrns',
    ],
  },
  {
    canonical: 'Trombone',
    section: 'Brass',
    aliases: [
      'trombone', 'trombones', 'trombone basso', 'tromboni', 'posaune', 'posaunen',
      'tbn', 'tbns', 'trb', 'trbn', 'pos',
    ],
  },
  {
    canonical: 'Trumpet',
    section: 'Brass',
    aliases: [
      'trumpet', 'trumpets', 'tromba', 'trombe', 'trompete', 'trompeten', 'trompette',
      'trompettes', 'clarino', 'clarini', 'tpt', 'tpts', 'trp', 'trpt',
    ],
  },
  {
    canonical: 'Tuba',
    section: 'Brass',
    aliases: ['tuba', 'tubas', 'basstuba', 'contrabass tuba'],
  },
  {
    canonical: 'Timpani',
    section: 'Percussion',
    aliases: ['timpani', 'tympani', 'timpano', 'kettledrums', 'pauken', 'timbales', 'timp', 'tmp'],
  },
  {
    canonical: 'Percussion',
    section: 'Percussion',
    aliases: [
      'percussion', 'percussions', 'percussioni', 'schlagzeug', 'schlagwerk', 'batterie',
      'batteria', 'drums', 'drum kit', 'drumset', 'perc', 'drs',
    ],
  },
  {
    canonical: 'Harp',
    section: 'Keyboard',
    aliases: ['harp', 'harps', 'arpa', 'arpe', 'harfe', 'harpe', 'hp', 'hrp'],
  },
  {
    canonical: 'Harpsichord',
    section: 'Keyboard',
    aliases: [
      'harpsichord', 'cembalo', 'clavicembalo', 'clavecin', 'kielflugel', 'hpschd', 'hpsd', 'cemb',
    ],
  },
  {
    canonical: 'Organ',
    section: 'Keyboard',
    aliases: ['organ', 'organo', 'orgel', 'orgue', 'pedal organ', 'org'],
  },
  {
    canonical: 'Piano',
    section: 'Keyboard',
    aliases: [
      'piano', 'pianos', 'pianoforte', 'fortepiano', 'klavier', 'clavier', 'klaviatur',
      'pno', 'pf', 'pft',
    ],
  },
  {
    canonical: 'Celesta',
    section: 'Keyboard',
    aliases: ['celesta', 'celeste', 'cel'],
  },
  {
    canonical: 'Cello',
    section: 'Strings',
    aliases: [
      'cello', 'cellos', 'violoncello', 'violoncelli', 'violoncelle', 'violoncelles',
      'violoncell', 'vc', 'vcl', 'vlc', 'vcs', 'celli',
    ],
  },
  {
    canonical: 'Contrabass',
    section: 'Strings',
    aliases: [
      'contrabass', 'contrabasses', 'contrabasso', 'contrabassi', 'contrabbasso',
      'contrabbassi', 'double bass', 'double basses', 'doublebass', 'string bass',
      'kontrabass', 'kontrabasse', 'contrebasse', 'contrebasses', 'violone',
      'basso', 'bassi', 'basses', 'cb', 'ctb', 'db', 'dbs',
    ],
  },
  {
    canonical: 'Viola',
    section: 'Strings',
    aliases: [
      'viola', 'violas', 'viole', 'bratsche', 'bratschen', 'altos', 'vla', 'vlas', 'va', 'vle',
    ],
  },
  {
    canonical: 'Violin',
    section: 'Strings',
    aliases: [
      'violin', 'violins', 'violino', 'violini', 'violine', 'violinen', 'violon', 'violons',
      'geige', 'geigen', 'fiddle', 'vln', 'vlns', 'vl', 'vn', 'vni', 'vns',
    ],
  },
  {
    canonical: 'Guitar',
    section: 'Strings',
    aliases: [
      'guitar', 'guitars', 'chitarra', 'chitarre', 'gitarre', 'gitarren', 'guitare', 'guitares',
      'lute', 'liuto', 'laute', 'gtr', 'git',
    ],
  },
  {
    canonical: 'Chorus',
    section: 'Voices',
    aliases: ['chorus', 'choir', 'chor', 'choeur', 'coro', 'cori', 'chorale'],
  },
  {
    canonical: 'Soprano',
    section: 'Voices',
    aliases: ['soprano', 'sopranos', 'soprani', 'sopran', 'canto', 'cantus', 'descant', 'sop'],
  },
  {
    canonical: 'Alto',
    section: 'Voices',
    aliases: ['alto voice', 'contralto', 'mezzo soprano', 'mezzo', 'altus'],
  },
  {
    canonical: 'Tenor',
    section: 'Voices',
    aliases: ['tenor', 'tenore', 'tenori', 'tenors'],
  },
  {
    canonical: 'Bass Voice',
    section: 'Voices',
    aliases: ['bass voice', 'baritone', 'bariton', 'baryton', 'basso profondo', 'bassus'],
  },
  {
    canonical: 'Voice',
    section: 'Voices',
    aliases: ['voice', 'voices', 'vocal', 'vocals', 'voce', 'voci', 'gesang', 'stimme', 'solo voice'],
  },
];

const MATCHERS: { entry: InstrumentEntry; pattern: RegExp }[] = INSTRUMENTS.map((entry) => ({
  entry,
  pattern: new RegExp(`\\b(?:${entry.aliases.join('|')})\\b`),
}));

const ALIASES = new Set(INSTRUMENTS.flatMap((entry) => entry.aliases));
/** Longest first, so "violinii" splits at "ii" rather than leaving "violini" + "i". */
const GLUED_ORDINALS = [...ORDINAL_WORDS.keys()]
  .filter((word) => /^[a-z]+$/.test(word))
  .sort((a, b) => b.length - a.length);

const parsed = new Map<string, PartName>();

/** Folds away the ways the same name is spelled: case, diacritics, punctuation, and the
 *  spacing sequencers insert around abbreviation dots. Word boundaries are restored where
 *  an engraver ran them together, as LilyPond does turning a context name into a track
 *  name: `SoloViolinI` and `violintwo` both name a desk a listener can pick out. */
export function normalizePartName(raw: string): string {
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00df/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return spaced
    .split(' ')
    .map(unglueOrdinal)
    .join(' ');
}

function unglueOrdinal(token: string): string {
  if (ALIASES.has(token)) return token;
  for (const ordinal of GLUED_ORDINALS) {
    if (token.length <= ordinal.length || !token.endsWith(ordinal)) continue;
    const stem = token.slice(0, -ordinal.length);
    if (ALIASES.has(stem)) return `${stem} ${ordinal}`;
  }
  return token;
}

function ordinalIn(text: string): number | null {
  for (const token of text.split(' ')) {
    const word = ORDINAL_WORDS.get(token);
    if (word !== undefined) return word;
    if (/^\d{1,2}$/.test(token)) {
      const value = Number(token);
      if (value >= 1 && value <= MAX_PART_ORDINAL) return value;
    }
  }
  return null;
}

/** The one place a desk number is spelled, so a name derived from a GM program reads the
 *  same as one derived from the track name. */
export function labelWithOrdinal(instrument: string, ordinal: number): string {
  return `${instrument} ${ROMAN_NUMERALS[ordinal - 1] ?? String(ordinal)}`;
}

function labelFor(instrument: string, ordinal: number | null): string {
  return ordinal === null ? instrument : labelWithOrdinal(instrument, ordinal);
}

/**
 * Reads one MIDI track name as an instrument identity.
 *
 * Returns a null instrument rather than a guess when the name resolves to nothing, so a
 * caller can fall back to the GM program without having to distrust a confident-looking
 * answer.
 */
export function parsePartName(raw: string): PartName {
  const cached = parsed.get(raw);
  if (cached) return cached;

  const normalized = normalizePartName(raw);
  const searchable = normalized.replace(TRANSPOSITION_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  const match = MATCHERS.find(({ pattern }) => pattern.test(searchable));

  const instrument = match ? match.entry.canonical : null;
  const remainder = match ? searchable.replace(match.pattern, ' ') : searchable;
  const ordinal = instrument === null ? null : ordinalIn(remainder);
  const placeholder = instrument === null && PLACEHOLDER_PATTERN.test(normalized);

  const result: PartName = {
    raw,
    instrument,
    section: match ? match.entry.section : null,
    ordinal,
    label: instrument === null ? raw.trim() || 'Unnamed' : labelFor(instrument, ordinal),
    placeholder,
  };
  parsed.set(raw, result);
  return result;
}
