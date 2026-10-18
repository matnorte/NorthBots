import Docker from "dockerode";
import { PassThrough, type Duplex } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
/** SDK transport over Docker exec: the MCP process runs as the unprivileged agent, never on the host. */
export class DockerStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private stream: Duplex | null = null;
  private buffer = new ReadBuffer({ maxBufferSize: 2 * 1024 * 1024 });
  constructor(
    private containerId: string,
    private command: string,
    private args: string[],
    private docker = new Docker(),
  ) {}
  async start() {
    if (this.stream) throw new Error("Already connected");
    const exec = await this.docker
      .getContainer(this.containerId)
      .exec({
        Cmd: [this.command, ...this.args],
        User: "agent",
        WorkingDir: "/home/agent",
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
    const stream = await exec.start({ hijack: true, stdin: true });
    this.stream = stream;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.resume(); // Never forward potentially secret diagnostics into events or model context.
    stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        let message;
        while ((message = this.buffer.readMessage())) this.onmessage?.(message);
      } catch {
        this.onerror?.(new Error("Invalid MCP stdio response"));
      }
    });
    stream.on("error", () => this.onerror?.(new Error("MCP computer connection failed")));
    stream.on("end", () => this.onclose?.());
    this.docker.modem.demuxStream(stream, stdout, stderr);
  }
  async send(message: JSONRPCMessage) {
    if (!this.stream) throw new Error("Not connected");
    const stream = this.stream;
    await new Promise<void>((resolve, reject) =>
      stream.write(serializeMessage(message), (error) => (error ? reject(error) : resolve())),
    );
  }
  async close() {
    this.stream?.end();
    this.stream?.destroy();
    this.stream = null;
    this.buffer.clear();
    this.onclose?.();
  }
}
