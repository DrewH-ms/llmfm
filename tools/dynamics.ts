import type { ScoredNote } from '../src/types.ts';

/** How loud a score's notes are relative to each other, which is the property the gate
 *  depends on and the one engraving tools most often discard. Pure, so the curation
 *  script, the classifier and the test all reach the same verdict about a file. */
export type Dynamics = {
  notes: number;
  distinct: number;
  sd: number;
  low: number;
  high: number;
};

/** The signal this product sends is one part fading out while the others carry on. A
 *  score whose notes all share one velocity gives that fade nothing to move against, so
 *  it reads as the music breaking rather than as one voice leaving. LilyPond writes a
 *  flat velocity unless dynamics are engraved, and whether they were is a property of the
 *  individual edition, not of the source — so every file is measured, and none is
 *  trusted for where it came from. */
export const MIN_DISTINCT_VELOCITIES = 5;

export function measureDynamics(notes: readonly ScoredNote[]): Dynamics {
  if (notes.length === 0) return { notes: 0, distinct: 0, sd: 0, low: 0, high: 0 };
  const velocities = notes.map((note) => note.velocity);
  const mean = velocities.reduce((total, value) => total + value, 0) / velocities.length;
  const variance =
    velocities.reduce((total, value) => total + (value - mean) ** 2, 0) / velocities.length;
  return {
    notes: velocities.length,
    distinct: new Set(velocities).size,
    sd: Math.sqrt(variance),
    low: Math.min(...velocities),
    high: Math.max(...velocities),
  };
}

export function isDynamic(dynamics: Dynamics): boolean {
  return dynamics.distinct >= MIN_DISTINCT_VELOCITIES;
}
