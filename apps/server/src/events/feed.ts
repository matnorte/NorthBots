import type { EventFeedMessage, StoredEvent } from "@northbot/shared";
import type { EventLog } from "./log.js";

const PAGE = 500;

/**
 * Streams a workspace's events to `send`: first a replay from `fromId` (inclusive), then live.
 * Live events that arrive during the replay are buffered and de-duplicated by id, so the
 * client sees every event exactly once and in order.
 */
export async function streamEvents(
  log: EventLog,
  workspaceId: string,
  fromId: number,
  send: (msg: EventFeedMessage) => void,
): Promise<() => void> {
  let lastId = fromId - 1;
  let replaying = true;
  const buffer: StoredEvent[] = [];

  const emit = (event: StoredEvent): void => {
    if (event.id <= lastId) return;
    lastId = event.id;
    send({ kind: "event", event });
  };

  const unsubscribe = log.subscribe(workspaceId, (event) => {
    if (replaying) buffer.push(event);
    else emit(event);
  });

  for (;;) {
    const page = await log.list(workspaceId, lastId + 1, PAGE);
    page.forEach(emit);
    if (page.length < PAGE) break;
  }
  buffer.sort((a, b) => a.id - b.id).forEach(emit);
  replaying = false;
  send({ kind: "replay_done", lastId: lastId >= fromId ? lastId : null });

  return unsubscribe;
}
