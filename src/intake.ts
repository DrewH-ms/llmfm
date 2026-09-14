import { AWAITING_INPUT_NOTIFICATIONS, HOOK_EVENTS } from './constants.ts';
import type { HookEventName } from './constants.ts';
import type { HookEvent } from './types.ts';

export const SESSION_OUTCOMES = ['working', 'awaiting-input', 'ended'] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Narrows an untrusted hook payload. Returns null when the event is unusable. */
export function parseHookEvent(options: { name: string; body: string }): HookEvent | null {
  const name = HOOK_EVENTS.find((candidate): candidate is HookEventName => candidate === options.name);
  if (!name) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(options.body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const payload = parsed as Record<string, unknown>;
  const sessionId = readString(payload, 'sessionId');
  if (!sessionId) return null;

  // `notification` payloads use snake_case; other events omit the field entirely.
  return {
    name,
    sessionId,
    cwd: readString(payload, 'cwd'),
    notificationType: name === 'notification' ? readString(payload, 'notification_type') : null,
  };
}

/** Whether an event means the agent is now working, awaiting input, or has ended.
 *  Null means the event carries no state change. */
export function outcomeOf(event: HookEvent): SessionOutcome | null {
  switch (event.name) {
    case 'sessionStart':
    case 'userPromptSubmitted':
    case 'preToolUse':
    // A tool finishing means work resumed after a permission or elicitation dialog.
    // The failure case matters just as much: a denied permission or a crashed tool must
    // still release the part, or the session stays silent until the turn ends.
    case 'postToolUse':
    case 'postToolUseFailure':
      return 'working';
    case 'agentStop':
      return 'awaiting-input';
    case 'sessionEnd':
      return 'ended';
    case 'notification':
      return AWAITING_INPUT_NOTIFICATIONS.some((type) => type === event.notificationType)
        ? 'awaiting-input'
        : null;
  }
}
