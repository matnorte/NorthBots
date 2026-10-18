import { createHash } from "node:crypto";
import multipart from "@fastify/multipart";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import type { DbHandle } from "../db/client.js";
import { files } from "../db/schema.js";
import type { Services } from "../services.js";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const FileInfo = z.object({ id: z.string().uuid(), name: z.string(), size: z.number().int(), mime: z.string() });
export type FileInfo = z.infer<typeof FileInfo>;

/** Keeps names safe to use as a file name inside an agent computer. */
export const safeName = (name: string) => name.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file";

export async function loadFiles(db: DbHandle, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db.db.select().from(files).where(and(eq(files.workspaceId, workspaceId), inArray(files.id, ids)));
}

export const fileRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["files"];
  app.addHook("preHandler", s.auth);
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

  app.post("/files", { schema: { tags, description: "Upload one file (multipart, field `file`, 10 MB max).", response: { 201: FileInfo, 400: ErrorBody, 413: ErrorBody } } }, async (req, reply) => {
    const m = me(req);
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: "no_file", message: "Send a multipart field named `file`." });
    const data = await part.toBuffer().catch(() => null);
    if (!data || part.file.truncated) return reply.code(413).send({ error: "too_large", message: "Files can be at most 10 MB." });
    const [row] = await s.db.db
      .insert(files)
      .values({
        workspaceId: m.workspaceId,
        name: safeName(part.filename),
        mime: part.mimetype || "application/octet-stream",
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        data,
        uploadedBy: m.userId,
      })
      .returning({ id: files.id, name: files.name, size: files.size, mime: files.mime });
    if (!row) throw new Error("file insert failed");
    return reply.code(201).send(row);
  });

  app.get("/files/:id", { schema: { tags, params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    const [row] = await loadFiles(s.db, me(req).workspaceId, [req.params.id]);
    if (!row) return reply.code(404).send({ error: "not_found", message: "No such file." });
    // Always a download, never rendered on our origin.
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${row.name}"`)
      .header("x-content-type-options", "nosniff")
      .send(row.data);
  });
};
