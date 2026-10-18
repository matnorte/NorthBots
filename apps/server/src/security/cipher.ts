import type { SecretBox } from "../vault/crypto.js";
/** Separate derived subkeys for each workspace/agent; authenticated ciphertext carries no key. */
export class AgentCipher {
  constructor(private box: SecretBox) {}
  seal(workspaceId: string, agentId: string | null, text: string, purpose = "memory") {
    const sealed = this.box.seal(`${workspaceId}:agent:${agentId ?? "shared"}:${purpose}`, text);
    return `nbenc1:${sealed.nonce.toString("base64url")}:${sealed.ciphertext.toString("base64url")}`;
  }
  open(workspaceId: string, agentId: string | null, text: string, purpose = "memory") {
    if (!text.startsWith("nbenc1:")) return text;
    const [, nonce, ciphertext] = text.split(":");
    if (!nonce || !ciphertext) throw new Error("Invalid encrypted record");
    return this.box.open(`${workspaceId}:agent:${agentId ?? "shared"}:${purpose}`, {
      nonce: Buffer.from(nonce, "base64url"),
      ciphertext: Buffer.from(ciphertext, "base64url"),
    });
  }
}
