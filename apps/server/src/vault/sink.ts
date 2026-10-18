/** Where a decrypted secret is delivered. The value goes straight into a sandbox, never to a client. */
export interface SecretSink {
  inject(req: {
    workspaceId: string;
    sandboxId: string;
    name: string;
    value: string;
    as: "env" | "file";
    target: string;
  }): Promise<void>;
}

/** Test/dev sink: records deliveries in memory. The real sandbox sink is wired in M3. */
export class MemorySecretSink implements SecretSink {
  readonly deliveries: { workspaceId: string; sandboxId: string; name: string; as: string; target: string; value: string }[] = [];

  async inject(req: Parameters<SecretSink["inject"]>[0]): Promise<void> {
    this.deliveries.push({ ...req });
  }
}
