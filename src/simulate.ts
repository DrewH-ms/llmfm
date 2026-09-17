import { SIMULATION_LABELS, SIMULATION_STEP_MS } from './constants.ts';
import type { SessionRegistry } from './sessions.ts';

export type Simulation = {
  start(): void;
  stop(): void;
  running(): boolean;
};

/** Drives synthetic session activity so audio can be tuned without real agents. */
export function createSimulation(registry: SessionRegistry): Simulation {
  let timer: NodeJS.Timeout | null = null;

  const step = (): void => {
    for (const [index, label] of SIMULATION_LABELS.entries()) {
      registry.applySimulated({
        sessionId: `simulated-${index}`,
        working: Math.random() > 0.4,
        label,
      });
    }
  };

  return {
    start(): void {
      if (timer) return;
      step();
      timer = setInterval(step, SIMULATION_STEP_MS);
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      registry.removeSimulated();
    },
    running: (): boolean => timer !== null,
  };
}
