import type { ScoredNote } from '../src/types.ts';

/** Pure, so the curation script, the classifier and the test reach the same verdict about a file. */
export type Dynamics = {
  notes: number;
  distinct: number;
  sd: number;
  low: number;
  high: number;
};

/** A flat score gives the fade nothing to move against; LilyPond writes flat velocities per edition, so every file is measured. */
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
