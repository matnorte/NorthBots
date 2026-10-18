import type { ActionKind, ProposedAction } from "./types.js";

/** When a command does several things, the riskiest kind wins. */
const PRIORITY: ActionKind[] = ["read", "write", "delete", "login", "send", "spend"];
const worst = (kinds: ActionKind[]): ActionKind =>
  kinds.reduce<ActionKind>((a, b) => (PRIORITY.indexOf(b) > PRIORITY.indexOf(a) ? b : a), "read");

const PAYMENT_HOSTS = /(^|\.)(stripe\.com|mercadopago\.com(\.br)?|paypal\.com|pagseguro\.uol\.com\.br|adyen\.com|braintreegateway\.com|squareup\.com)$/i;
const PAYMENT_PATH = /\/(charges?|payments?|checkouts?|orders?|purchases?|subscriptions?|invoices\/\w+\/pay|transfers?|payouts?)\b/i;

const READ_CMDS = new Set([
  "ls", "cat", "head", "tail", "grep", "egrep", "rg", "find", "pwd", "echo", "printf", "wc", "du", "df", "ps", "which",
  "date", "whoami", "id", "uname", "file", "stat", "sort", "uniq", "cut", "tr", "jq", "less", "more", "tree", "env",
  "printenv", "hostname", "sleep", "true", "false", "test", "[", "diff", "cmp", "md5sum", "sha256sum", "base64", "basename",
  "dirname", "realpath", "readlink", "nproc", "free", "uptime", "type", "seq", "yes", "column",
]);
/** Programs that run another command, with their options that take a value: classified by the command they run. */
const WRAPPERS: Record<string, string[]> = {
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
  command: [],
  builtin: [],
  exec: ["-a"],
  nice: ["-n", "--adjustment"],
  nohup: [],
  time: ["-f", "--format", "-o", "--output"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  xargs: ["-I", "-n", "-L", "-P", "-d", "-s", "-a", "-E", "--max-args", "--max-lines", "--max-procs", "--delimiter", "--arg-file", "--replace"],
  stdbuf: ["-i", "-o", "-e"],
  ionice: ["-c", "-n", "-p", "--class", "--classdata"],
  setsid: [],
  chronic: [],
  watch: ["-n", "--interval"],
};

/** Where the wrapped command starts: after options (and their values), VAR=value and durations. */
function wrappedStart(cmd: string, words: string[]): number {
  const withValue = WRAPPERS[cmd] ?? [];
  let i = 1;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (withValue.includes(w)) i += 2;
    else if (w.startsWith("-") || w.includes("=") || /^[0-9.]+[smhd]?$/.test(w)) i += 1;
    else break;
  }
  return i;
}
const AWKS = new Set(["awk", "gawk", "mawk", "nawk"]);
const WRITE_CMDS = new Set([
  "mkdir", "touch", "cp", "mv", "ln", "chmod", "chown", "tee", "tar", "unzip", "zip", "gzip", "gunzip", "npm", "npx",
  "pnpm", "yarn", "pip", "pip3", "python", "python3", "node", "bash", "sh", "make", "apt", "apt-get", "git", "wget", "sed",
  "patch", "nano", "vi", "vim", "cd", "export", "source", ".", "kill", "pkill", "crontab",
]);
const DELETE_CMDS = new Set(["rm", "rmdir", "shred", "unlink", "truncate", "dropdb"]);
const SEND_CMDS = new Set(["sendmail", "mail", "mailx", "mutt", "msmtp", "swaks", "ssmtp", "scp", "rsync", "nc", "ncat", "telnet"]);
const LOGIN_CMDS = new Set(["ssh", "sftp", "ftp", "su", "sudo", "passwd"]);

export function extractTargets(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bhttps?:\/\/([^/\s"'`:?#]+)/gi)) if (m[1]) out.add(m[1].toLowerCase());
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.add(m[0].toLowerCase());
  return [...out];
}

function httpKind(segment: string, words: string[]): ActionKind {
  const hasData = /\s(-d|--data\S*|-F|--form|--upload-file|-T)\b/.test(` ${segment}`) || /\s(--json)\b/.test(` ${segment}`);
  const method = segment.match(/(?:-X|--request)\s*['"]?([A-Za-z]+)/)?.[1]?.toUpperCase();
  const credentials = /\s(-u|--user)\s|authorization:\s*(basic|bearer)/i.test(` ${segment}`);
  const urls = [...segment.matchAll(/https?:\/\/[^\s"'`]+/gi)].map((m) => {
    try {
      return new URL(m[0]);
    } catch {
      return null;
    }
  });
  const writes = hasData || (method !== undefined && method !== "GET" && method !== "HEAD");
  if (method === "DELETE") return "delete";
  if (writes && urls.some((u) => u && (PAYMENT_HOSTS.test(u.hostname) || PAYMENT_PATH.test(u.pathname)))) return "spend";
  if (writes) return "send";
  if (credentials) return "login";
  if (words[0] === "wget" || /\s(-o|-O|--output)\b/.test(` ${segment}`)) return "write";
  return "read";
}

function segmentKind(segment: string): ActionKind {
  const s = segment.trim();
  if (!s) return "read";
  const words = s.split(/\s+/);
  const cmd = (words[0] ?? "").replace(/^.*\//, "");
  const kinds: ActionKind[] = [];
  // Output redirection to a real file is a write (2>/dev/null and >/dev/null are not).
  if (/(^|[^0-9&])>{1,2}\s*(?!\/dev\/null)[^\s&|]/.test(s.replace(/[0-9&]?>\s*&?\s*\/dev\/null/g, ""))) kinds.push("write");
  if (Object.hasOwn(WRAPPERS, cmd)) {
    // A bare wrapper (`env`, `time`) only reads.
    kinds.push(segmentKind(words.slice(wrappedStart(cmd, words)).join(" ")));
  } else if (AWKS.has(cmd)) {
    // awk reads unless its program shells out; system("...") is classified by what it runs.
    const call = s.match(/\bsystem\s*\(\s*["']?(.*)$/);
    kinds.push(call ? worst(["write", classifyCommand((call[1] ?? "").replace(/["')}\s]+$/, ""))]) : "read");
  } else if (DELETE_CMDS.has(cmd)) kinds.push("delete");
  else if (SEND_CMDS.has(cmd)) kinds.push("send");
  else if (LOGIN_CMDS.has(cmd)) kinds.push("login");
  else if (cmd === "curl" || cmd === "wget" || cmd === "http" || cmd === "https") kinds.push(httpKind(s, words));
  else if (cmd === "git") {
    const sub = words[1] ?? "";
    if (sub === "push") kinds.push(/--force|-f\b/.test(s) ? "delete" : "send");
    else if (["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame"].includes(sub)) kinds.push("read");
    else if (sub === "clean" || (sub === "reset" && /--hard/.test(s))) kinds.push("delete");
    else kinds.push("write");
  } else if (cmd === "find") kinds.push(/\s-(delete|exec|execdir|ok|okdir)\b/.test(s) ? "delete" : /\s-(fprint0?|fprintf|fls)\b/.test(s) ? "write" : "read");
  // sed writes with -i, or with its w (write file) and e (execute) commands.
  else if (cmd === "sed") kinds.push(/\s-[a-zA-Z]*i|--in-place|['";/\s]\d*[weW]\s+\S/.test(` ${words.slice(1).join(" ")}`) ? "write" : "read");
  else if (cmd === "sort") kinds.push(/\s(-[a-zA-Z]*o|--output)/.test(s) ? "write" : "read");
  // uniq INPUT OUTPUT writes OUTPUT.
  else if (cmd === "uniq") kinds.push(words.slice(1).filter((w) => !w.startsWith("-")).length >= 2 ? "write" : "read");
  else if (READ_CMDS.has(cmd)) kinds.push("read");
  else if (WRITE_CMDS.has(cmd)) kinds.push("write");
  else kinds.push("write"); // Unknown programs could do anything: treat them as writes.
  if (/\b(DROP\s+(TABLE|DATABASE)|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/i.test(s)) kinds.push("delete");
  return worst(kinds);
}

/** Classifies a shell command. Compound commands (&&, ||, ;, |, $(...)) take their riskiest part. */
export function classifyCommand(command: string): ActionKind {
  const parts = command.split(/&&|\|\||;|\||\n|\$\(|`/);
  return worst(parts.map(segmentKind));
}

const SPEND_WORDS = /\b(pay|buy|purchase|checkout|check out|place order|order now|subscribe|donate|confirm payment|comprar|pagar|finalizar compra|assinar|suscribirse)\b/i;
const SEND_WORDS = /\b(send|post|publish|submit|reply|tweet|share|comment|enviar|publicar|responder|compartilhar|compartir)\b/i;
const DELETE_WORDS = /\b(delete|remove|trash|discard|destroy|excluir|apagar|remover|eliminar|borrar)\b/i;
const LOGIN_WORDS = /\b(log ?in|sign ?in|authorize|allow access|continue with|entrar|acessar|iniciar sesi[oó]n)\b/i;

/** Classifies a browser action. For clicks, `elementText` is the visible text of the target. */
export function classifyBrowser(args: Record<string, unknown>, elementText = ""): ActionKind {
  const action = String(args.action ?? "");
  const selector = String(args.selector ?? "");
  const label = `${elementText} ${selector}`;
  switch (action) {
    case "goto":
    case "read":
    case "screenshot":
    case "back":
    case "forward":
    case "reload":
    case "scroll":
    case "tabs":
    case "new_tab":
      return "read";
    case "fill":
      return /pass(word)?|passwd|senha|contrase|otp|2fa|totp|cvv|cvc|card/i.test(selector) ? "login" : "write";
    case "click":
      if (SPEND_WORDS.test(label)) return "spend";
      if (SEND_WORDS.test(label)) return "send";
      if (DELETE_WORDS.test(label)) return "delete";
      if (LOGIN_WORDS.test(label)) return "login";
      return "write";
    default:
      return "write";
  }
}

export function describe(tool: string, args: Record<string, unknown>): string {
  if (tool === "terminal") return `run \`${String(args.command ?? "").slice(0, 300)}\``;
  if (tool === "browser") {
    const a = String(args.action ?? "");
    const what = args.url ?? args.selector ?? args.key ?? "";
    return `browser ${a}${what ? ` ${String(what).slice(0, 200)}` : ""}${args.text ? ` with "${String(args.text).slice(0, 80)}"` : ""}`;
  }
  return `${tool} ${JSON.stringify(args).slice(0, 300)}`;
}

export function classify(tool: string, args: Record<string, unknown>, elementText = ""): ProposedAction {
  let kind: ActionKind;
  let targets: string[];
  if (tool === "terminal") {
    const command = String(args.command ?? "");
    kind = classifyCommand(command);
    targets = extractTargets(command);
  } else if (tool === "browser") {
    kind = classifyBrowser(args, elementText);
    targets = extractTargets(String(args.url ?? ""));
  } else {
    // MCP and other tools: the server supplies a kind from the tool's configured policy.
    kind = (args.__kind as ActionKind | undefined) ?? "write";
    targets = extractTargets(JSON.stringify(args));
  }
  return { tool, args, kind, summary: describe(tool, args), targets };
}
