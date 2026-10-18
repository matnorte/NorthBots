import type { EventFeedMessage, StoredEvent } from "@northbot/shared";
import type { EventLog } from "./log.js";

const PAGE = 500;
/** How many delivered ids to remember for de-duplication. */
const SEEN = 20_000;

/**
 * Streams a workspace's events to `send`: first a replay from `fromId` (inclusive, in id order),
 * then live. Every event is sent exactly once. Live events can arrive with a lower id than one
 * already sent (two writes that commit in the other order), so clients must not drop an event
 * just because its id is lower than the last one they saw: they place it by id.
 */
export async function streamEvents(
  log: EventLog,
  workspaceId: string,
  fromId: number,
  send: (msg: EventFeedMessage) => void,
): Promise<() => void> {
  let replaying = true;
  const buffer: StoredEvent[] = [];
  const seen = new Set<number>();
  let lastId = fromId - 1;

  const emit = (event: StoredEvent): void => {
    if (event.id < fromId || seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > SEEN) {
      // Forget the oldest ids (a Set iterates in insertion order).
      let drop = seen.size - SEEN / 2;
      for (const id of seen) {
        if (drop-- <= 0) break;
        seen.delete(id);
      }
    }
    lastId = Math.max(lastId, event.id);
    send({ kind: "event", event });
  };

  const unsubscribe = log.subscribe(workspaceId, (event) => {
    if (replaying) buffer.push(event);
    else emit(event);
  });

  let cursor = fromId;
  for (;;) {
    const page = await log.list(workspaceId, cursor, PAGE);
    page.forEach(emit);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1]!.id + 1;
  }
  buffer.sort((a, b) => a.id - b.id).forEach(emit);
  replaying = false;
  send({ kind: "replay_done", lastId: lastId >= fromId ? lastId : null });

  return unsubscribe;
}
