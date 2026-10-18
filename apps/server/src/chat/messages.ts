import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.js";
import { messages, threads } from "../db/schema.js";
import type { EventLog } from "../events/log.js";
import type { FileInfo } from "./files.js";

/** Adds a message to a thread and logs it (speech bubbles in the office come from this event). */
export async function postMessage(
  db: DbHandle,
  log: EventLog,
  t: { id: string; workspaceId: string; agentId: string },
  m: { role: "user" | "agent" | "system"; content: string; attachments?: FileInfo[]; taskId?: string | null; userId?: string | null },
) {
  const [row] = await db.db
    .insert(messages)
    .values({ threadId: t.id, role: m.role, content: m.content, attachments: m.attachments ?? [], taskId: m.taskId ?? null, userId: m.userId ?? null })
    .returning();
  if (!row) throw new Error("message insert failed");
  await db.db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, t.id));
  await log.write(t.workspaceId, {
    type: "chat.message",
    agentId: t.agentId,
    payload: { threadId: t.id, messageId: row.id, role: m.role, preview: m.content.slice(0, 140), taskId: m.taskId ?? null },
  });
  return row;
}
