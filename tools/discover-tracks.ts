/** Dev-time only — `node tools/discover-tracks.ts [--refresh]`: crawls Mutopia for redistributable ensemble scores into tools/mutopia-candidates.json; the daemon makes no network requests. */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MUTOPIA_FTP = 'https://www.mutopiaproject.org/ftp/';
const TOOLS_DIR = join(fileURLToPath(import.meta.url), '..');
const CANDIDATES_FILE = join(TOOLS_DIR, 'mutopia-candidates.json');

/** Matches the allow-list in curate-tracks.ts and fails closed: an unrecognised licence is not one we may redistribute under. */
const REDISTRIBUTABLE = [
  'Public Domain',
  'Creative Commons Attribution 3.0',
  'Creative Commons Attribution 4.0',
  'Creative Commons Attribution-ShareAlike 2.0',
  'Creative Commons Attribution-ShareAlike 2.5',
  'Creative Commons Attribution-ShareAlike 3.0',
  'Creative Commons Attribution-ShareAlike 4.0',
];

/** Scoring that gives the voice tree enough independent lines to tell sessions apart. */
const ENSEMBLE_PATTERNS = [
  /orchestra/i,
  /\bstrings?\b/i,
  /quartet|quintet|sextet|septet|octet/i,
  /\bensemble\b/i,
  /symphon/i,
  /concerto/i,
  /\bband\b/i,
  /\bchoir\b|\bchorus\b|SATB/i,
];

/** Checked first: "Organ" pieces often list "strings" as a stop, and a piano reduction of a concerto is still one instrument. */
const SOLO_PATTERNS = [
  /^\s*(solo\s+)?(piano|organ|harpsichord|guitar|lute|harp|clavichord|keyboard)\s*$/i,
  /^\s*piano\s+solo\s*$/i,
  /^\s*(voice|soprano|tenor|bass|alto)\s*(and|,|\+)?\s*piano\s*$/i,
];

const MAX_CONCURRENT = 8;
const HTTP_TIMEOUT_MS = 20000;
const DIRECTORY_PATTERN = /<a href="([^"?/][^"]*)\/">/g;
const RDF_PATTERN = /<a href="([^"?]+\.rdf)">/g;

type Candidate = {
  piece: string;
  leaf: string;
  title: string;
  composer: string;
  for: string;
  licence: string;
  source: string;
};

async function text(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return '';
    return await response.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

const matchAll = (document: string, pattern: RegExp): string[] => {
  pattern.lastIndex = 0;
  return [...document.matchAll(pattern)].map((match) => match[1] ?? '').filter(Boolean);
};

const field = (document: string, name: string): string => {
  const match = new RegExp(`<mp:${name}[^>]*>([^<]*)</mp:${name}>`).exec(document);
  return (match?.[1] ?? '').trim();
};

/** Bounded fan-out: hammering a volunteer server to save a minute is not a trade worth making. */
async function mapLimited<In, Out>(
  items: In[],
  worker: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const results: Out[] = [];
  let next = 0;
  const runners = Array.from({ length: Math.min(MAX_CONCURRENT, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  });
  await Promise.all(runners);
  return results;
}

const isEnsemble = (scoring: string): boolean => {
  if (!scoring) return false;
  if (SOLO_PATTERNS.some((pattern) => pattern.test(scoring))) return false;
  return ENSEMBLE_PATTERNS.some((pattern) => pattern.test(scoring));
};

/** Pieces sit three levels down (<Composer>/<Work>/<Piece>/), so the walk is depth limited rather than recursive. */
async function pieceDirectories(): Promise<string[]> {
  const composers = matchAll(await text(MUTOPIA_FTP), DIRECTORY_PATTERN);
  console.log(`composers: ${composers.length}`);

  const works = await mapLimited(composers, async (composer) => {
    const listing = await text(`${MUTOPIA_FTP}${composer}/`);
    return matchAll(listing, DIRECTORY_PATTERN).map((work) => `${composer}/${work}`);
  });
  const flatWorks = works.flat();
  console.log(`works: ${flatWorks.length}`);

  const pieces = await mapLimited(flatWorks, async (work) => {
    const listing = await text(`${MUTOPIA_FTP}${work}/`);
    return matchAll(listing, DIRECTORY_PATTERN).map((piece) => `${work}/${piece}`);
  });
  const flatPieces = pieces.flat();
  console.log(`pieces: ${flatPieces.length}`);
  return flatPieces;
}

async function describe(piece: string): Promise<Candidate | null> {
  const source = `${MUTOPIA_FTP}${piece}/`;
  const listing = await text(source);
  const leaf = matchAll(listing, RDF_PATTERN)[0];
  if (!leaf) return null;
  const rdf = await text(`${source}${leaf}`);
  if (!rdf) return null;
  return {
    piece,
    leaf: leaf.replace(/\.rdf$/, ''),
    title: field(rdf, 'title'),
    composer: field(rdf, 'composer'),
    for: field(rdf, 'for'),
    licence: field(rdf, 'licence'),
    source,
  };
}

const cached = (): Candidate[] | null => {
  if (!existsSync(CANDIDATES_FILE)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(CANDIDATES_FILE, 'utf8'));
    const entries = (parsed as { candidates?: unknown })?.candidates;
    return Array.isArray(entries) ? (entries as Candidate[]) : null;
  } catch {
    return null;
  }
};

const refresh = process.argv.includes('--refresh');
const existing = refresh ? null : cached();

let candidates: Candidate[];
if (existing) {
  console.log(`reusing ${CANDIDATES_FILE} (${existing.length} candidates); --refresh to recrawl`);
  candidates = existing;
} else {
  const described = await mapLimited(await pieceDirectories(), describe);
  const found = described.filter((entry): entry is Candidate => entry !== null);
  console.log(`read ${found.length} RDF records`);
  candidates = found
    .filter((entry) => REDISTRIBUTABLE.includes(entry.licence) && isEnsemble(entry.for))
    .sort((a, b) => `${a.composer}${a.title}`.localeCompare(`${b.composer}${b.title}`));
  writeFileSync(CANDIDATES_FILE, `${JSON.stringify({ candidates }, null, 2)}\n`);
  console.log(`wrote ${candidates.length} ensemble candidates to ${CANDIDATES_FILE}`);
}

const byComposer = new Map<string, number>();
for (const entry of candidates) {
  byComposer.set(entry.composer, (byComposer.get(entry.composer) ?? 0) + 1);
}
console.log('\ncandidates by composer:');
for (const [composer, count] of [...byComposer].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(count).padStart(4)}  ${composer}`);
}
