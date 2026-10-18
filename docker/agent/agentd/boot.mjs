import { spawn } from "node:child_process";
import { readFile, writeFile, unlink, access, chown, cp, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: "ignore" });
    p.once("error", reject);
    p.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("Disk setup failed"))));
  });
if (process.env.NORTHBOT_ENCRYPTED_HOME === "1") {
  await mkdir("/run/agentd", { recursive: true, mode: 0o700 });
  await unlink("/run/agentd/disk-key").catch(() => {});
  await run("mkfifo", ["-m", "600", "/run/agentd/disk-key"]);
  const key = await readFile("/run/agentd/disk-key");
  await unlink("/run/agentd/disk-key");
  await writeFile("/run/agentd/disk-pass",key,{mode:0o600});
  key.fill(0);
  const crypt = (args) => {
    const child = spawn("gocryptfs", ["-q", "-passfile", "/run/agentd/disk-pass", ...args], {
      stdio: "ignore",
    });
    return child;
  };
  try {
    await access("/encrypted/gocryptfs.conf", constants.F_OK);
  } catch {
    const init = crypt(["-init", "/encrypted"]);
    await new Promise((resolve, reject) => {
      init.once("error", reject);
      init.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Encrypted volume initialization failed")),
      );
    });
  }
  await mkdir("/home/agent", { recursive: true });
  const mount = crypt(["-fg", "-allow_other", "-nonempty", "/encrypted", "/home/agent"]);
  let mounted = false;
  for (let i = 0; i < 100; i++) {
    if (mount.exitCode !== null) throw new Error("Encrypted volume mount failed");
    try {
      await run("mountpoint", ["-q", "/home/agent"]);
      mounted = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!mounted) throw new Error("Encrypted volume mount timed out");
  await unlink("/run/agentd/disk-pass");
  await chown("/home/agent", 1001, 1001);
  try {
    await access("/home/agent/.bashrc");
  } catch {
    await cp("/etc/skel", "/home/agent", { recursive: true });
    await run("chown", ["-R", "1001:1001", "/home/agent"]);
  }
}
const agent = spawn("node", ["/opt/agentd/agentd.mjs"], { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => agent.kill(signal));
agent.on("exit", (code) => process.exit(code ?? 1));

