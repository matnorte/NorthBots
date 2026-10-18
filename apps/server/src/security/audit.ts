import { PersonRecords } from "./person.js";
import { Readable } from "node:stream";
import { jsonArray, matching, scanRows } from "./stream.js";
import {
  createHash,
  generateKeyPairSync,
  sign,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import { scrubSecrets } from "@northbot/shared";
import type { Services } from "../services.js";
import {
  events,
  files,
  messages,
  securityRecordings,
  tasks,
  threads,
  agents,
  sandboxes,
} from "../db/schema.js";
import type { AgentCipher } from "./cipher.js";
export class AuditService {
  constructor(
    private s: Pick<Services, "db" | "vault" | "events" | "memory" | "computers">,
    private cipher: AgentCipher,
  ) {}
  async signedExport(ws: string) {
    // A separate signing key lives encrypted in the vault. The exported public key verifies this artifact.
    const name = "AUDIT_SIGNING_KEY";
    if (!(await this.s.vault.listNames(ws)).some((x) => x.name === name)) {
      const key = generateKeyPairSync("ed25519");
      await this.s.vault.put(
        ws,
        name,
        key.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      );
    }
    const rows = await this.s.db.db
      .select()
      .from(events)
      .where(eq(events.workspaceId, ws))
      .orderBy(events.id);
    const data = Buffer.from(
      scrubSecrets(
        JSON.stringify({
          version: 1,
          workspaceId: ws,
          exportedAt: new Date().toISOString(),
          events: rows,
        }),
      ),
    );
    return this.s.vault.withSecret(
      ws,
      name,
      async (pem) => ({
        algorithm: "Ed25519",
        data: data.toString("base64"),
        signature: sign(null, data, createPrivateKey(pem)).toString("base64"),
        publicKey: createPublicKey(pem).export({ format: "pem", type: "spki" }).toString(),
      }),
      "signing",
    );
  }
  async record(
    ws: string,
    agentId: string,
    entries: { ts: string; kind: string; summary: string }[],
  ) {
    const frames = entries.slice(0, 1000).map((f) => ({
      ts: f.ts,
      kind: f.kind,
      summary: /login|password|fill|sign|secret|captcha|2fa/i.test(f.kind)
        ? "[Sensitive interaction redacted]"
        : scrubSecrets(f.summary)
            .replace(/nb_canary_[a-f0-9]{48}/g, "[Canary redacted]")
            .slice(0, 1000),
    }));
    const [row] = await this.s.db.db
      .insert(securityRecordings)
      .values({ workspaceId: ws, agentId, frames })
      .returning();
    return row;
  }
  private personSources(ws: string, query: string) {
    if (query.trim().length < 3)
      throw new Error("Use a specific person identifier (at least three characters)");
    const includes = (v: unknown) => JSON.stringify(v).toLowerCase().includes(query.toLowerCase());
    const memory = matching(this.s.memory.personalRows(ws), includes);
    const eventRows = matching(
      scanRows((after: number | undefined) =>
        this.s.db.db
          .select()
          .from(events)
          .where(
            and(eq(events.workspaceId, ws), after === undefined ? undefined : gt(events.id, after)),
          )
          .orderBy(events.id)
          .limit(100),
      ),
      includes,
    );
    const taskRows = matching(
      scanRows((after: string | undefined) =>
        this.s.db.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.workspaceId, ws), after ? gt(tasks.id, after) : undefined))
          .orderBy(tasks.id)
          .limit(100),
      ),
      includes,
    );
    const messageRows = matching(
      scanRows((after: string | undefined) =>
        this.s.db.db
          .select()
          .from(messages)
          .where(
            and(
              inArray(
                messages.threadId,
                this.s.db.db
                  .select({ id: threads.id })
                  .from(threads)
                  .where(eq(threads.workspaceId, ws)),
              ),
              after ? gt(messages.id, after) : undefined,
            ),
          )
          .orderBy(messages.id)
          .limit(100),
      ),
      includes,
    );
    // Files are fetched one at a time: bytea contents can be substantially larger than metadata.
    const fileRows = matching(
      scanRows((after: string | undefined) =>
        this.s.db.db
          .select()
          .from(files)
          .where(and(eq(files.workspaceId, ws), after ? gt(files.id, after) : undefined))
          .orderBy(files.id)
          .limit(1),
      ),
      (row) =>
        includes(row.name) || row.data.toString("utf8").toLowerCase().includes(query.toLowerCase()),
    );
    return {
      memory,
      events: eventRows,
      tasks: taskRows,
      messages: messageRows,
      files: fileRows,
    };
  }
  /** Backpressure-aware JSON with the existing response shape and bounded database pages. */
  personExport(ws: string, query: string): Readable {
    const sources = this.personSources(ws, query);
    const records = new PersonRecords(this.s);
    async function* json() {
      yield `{"version":1,"query":${JSON.stringify(query)},"records":`;
      yield* records.json(ws, query);
      for (const key of ["memory", "events", "tasks", "messages"] as const) {
        yield `,${JSON.stringify(key)}:`;
        yield* jsonArray(sources[key]);
      }
      yield ',"files":';
      async function* fileRows() {
        for await (const row of sources.files) yield { ...row, data: row.data.toString("base64") };
      }
      yield* jsonArray(fileRows());
      yield "}";
    }
    return Readable.from(json(), { objectMode: false, highWaterMark: 16 * 1024 });
  }
  async erase(ws: string, query: string) {
    const found = this.personSources(ws, query);
    const replace = (value: string) =>
      value.split(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")).join("[Erased]");
    // Replace inside string values only: object keys stay intact, so payloads keep their shape.
    const scrub = (v: unknown): unknown =>
      typeof v === "string"
        ? replace(v)
        : Array.isArray(v)
          ? v.map(scrub)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
            : v;
    const counts: Record<string, number> = {
      memory: 0,
      events: 0,
      tasks: 0,
      messages: 0,
      files: 0,
      ...(await new PersonRecords(this.s).erase(ws, query)),
    };
    for await (const row of found.memory) {
      await this.s.memory.forget(ws, row.id, null);
      counts.memory!++;
    }
    for await (const row of found.events) {
      await this.s.db.db
        .update(events)
        .set({
          payload: scrub(row.payload) as Record<string, unknown>,
        })
        .where(and(eq(events.workspaceId, ws), eq(events.id, row.id)));
      counts.events!++;
    }
    for await (const row of found.tasks) {
      await this.s.db.db
        .update(tasks)
        .set({ goal: replace(row.goal), state: null, report: null, error: null })
        .where(and(eq(tasks.workspaceId, ws), eq(tasks.id, row.id)));
      counts.tasks!++;
    }
    for await (const row of found.messages) {
      await this.s.db.db
        .update(messages)
        .set({ content: replace(row.content) })
        .where(eq(messages.id, row.id));
      counts.messages!++;
    }
    for await (const row of found.files) {
      await this.s.db.db.delete(files).where(and(eq(files.workspaceId, ws), eq(files.id, row.id)));
      counts.files!++;
    }
    await this.s.events.write(ws, {
      type: "security.erased",
      payload: { digest: createHash("sha256").update(query.toLowerCase()).digest("hex"), counts },
    });
    return counts;
  }
  async encryptedDisk(ws: string, agentId: string, path: string) {
    const [row] = await this.s.db.db
      .select({ id: sandboxes.id })
      .from(agents)
      .innerJoin(sandboxes, eq(agents.sandboxId, sandboxes.id))
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, ws)));
    if (!row) throw new Error("No agent computer");
    const raw = await this.s.computers.sandbox.exec(
      row.id,
      `tar -czf - --one-file-system -C /home/agent . | base64 -w0`,
      { timeoutMs: 120000, asRoot: true },
    );
    if (raw.exitCode !== 0 || raw.truncated)
      throw new Error("Disk archive too large or unavailable; use deployment volume backups");
    const encrypted = this.cipher.seal(ws, agentId, raw.stdout, "disk");
    return { path, encrypted };
  }
}
