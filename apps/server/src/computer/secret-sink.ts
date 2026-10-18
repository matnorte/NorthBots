import { and, eq, ne } from "drizzle-orm";
import type { Sandbox } from "@northbot/sandbox";
import type { DbHandle } from "../db/client.js";
import { sandboxes } from "../db/schema.js";
import type { SecretSink } from "../vault/sink.js";

/**
 * Delivers vault secrets into an agent computer. The value travels in the Docker exec
 * environment, never on a command line, so it never reaches `terminal.exec` events.
 * `file` writes it to a path in the agent's home; `env` also exports it from ~/.bashrc.
 */
export class SandboxSecretSink implements SecretSink {
  constructor(
    private readonly db: DbHandle,
    private readonly sandbox: Sandbox,
  ) {}

  async inject(req: Parameters<SecretSink["inject"]>[0]): Promise<void> {
    const [row] = await this.db.db
      .select({ id: sandboxes.id })
      .from(sandboxes)
      .where(and(eq(sandboxes.id, req.sandboxId), eq(sandboxes.workspaceId, req.workspaceId), ne(sandboxes.state, "destroyed")));
    if (!row) throw new Error("no such computer in this workspace");
    const file = req.as === "file" ? req.target : `.northbot/secrets/${req.name}`;
    if (!/^[\w./-]+$/.test(file) || file.includes("..")) throw new Error("bad target path");
    const script = [
      'umask 077; mkdir -p "$(dirname "$NB_FILE")"; printf %s "$NB_VALUE" > "$NB_FILE"',
      req.as === "env"
        ? `grep -q "NB_SECRET:$NB_VAR" ~/.bashrc || echo "export $NB_VAR=\\"\\$(cat ~/$NB_FILE)\\" # NB_SECRET:$NB_VAR" >> ~/.bashrc`
        : "true",
    ].join(" && ");
    const r = await this.sandbox.exec(row.id, script, {
      env: { NB_VALUE: req.value, NB_FILE: file, NB_VAR: req.target },
      timeoutMs: 10_000,
    });
    if (r.exitCode !== 0) throw new Error("could not write the secret into the computer");
  }
}
