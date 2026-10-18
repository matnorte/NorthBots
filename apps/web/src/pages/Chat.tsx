import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";
import { AgentAvatar } from "../components/AgentAvatar.js";
import { useSession } from "../store/session.js";
import type { Agent } from "./Agents.js";

interface Thread {
  id: string;
  title: string;
}
interface Attachment {
  id: string;
  name: string;
  size: number;
}
interface Message {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  attachments: Attachment[];
  taskId: string | null;
}

/** Reads a Server-Sent Events response body, calling `on` for each event. */
async function readSse(res: Response, on: (event: string, data: unknown) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = block.match(/^event: (.*)$/m)?.[1] ?? "message";
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (data) on(event, JSON.parse(data));
    }
  }
}

export function Chat({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"ask" | "do">("ask");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadAgent = () => void api<Agent>("GET", `/agents/${agentId}`).then(setAgent);
    loadAgent();
    const agentTimer = setInterval(loadAgent, 3000);
    void api<{ threads: Thread[] }>("GET", `/agents/${agentId}/threads`).then(async (r) => {
      if (r.threads.length) {
        setThreads(r.threads);
        setThreadId(r.threads[0]?.id ?? null);
      } else {
        const created = await api<Thread>("POST", `/agents/${agentId}/threads`, { title: t("chat.firstThread") });
        setThreads([created]);
        setThreadId(created.id);
      }
    });
    return () => clearInterval(agentTimer);
  }, [agentId, t]);

  const loadMessages = async (id: string) => setMessages((await api<{ messages: Message[] }>("GET", `/threads/${id}/messages`)).messages);
  useEffect(() => {
    if (!threadId) return;
    void loadMessages(threadId);
    // Task reports arrive later; check for them every few seconds.
    const timer = setInterval(() => void loadMessages(threadId), 3000);
    return () => clearInterval(timer);
  }, [threadId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  const newThread = async () => {
    const created = await api<Thread>("POST", `/agents/${agentId}/threads`, { title: t("chat.newThread") });
    setThreads([created, ...threads]);
    setThreadId(created.id);
  };

  const upload = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/files", { method: "POST", body: form, credentials: "same-origin" });
    if (!res.ok) return setError(t("chat.uploadFailed"));
    setFiles([...files, (await res.json()) as Attachment]);
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!threadId || !draft.trim()) return;
    setError(null);
    const body = { content: draft, mode, attachmentIds: files.map((f) => f.id) };
    setDraft("");
    setFiles([]);
    if (mode === "do") {
      try {
        await api("POST", `/threads/${threadId}/messages`, body);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t("chat.sendFailed"));
      }
      return loadMessages(threadId);
    }
    const res = await fetch(`/api/threads/${threadId}/messages`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setStreaming("");
    await readSse(res, (event, data) => {
      if (event === "user") setMessages((m) => [...m, data as Message]);
      if (event === "delta") setStreaming((s) => (s ?? "") + (data as { text: string }).text);
      if (event === "error") setError((data as { message: string }).message);
      if (event === "done") setMessages((m) => [...m, data as Message]);
    });
    setStreaming(null);
  };

  return (
    <section className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <aside className="flex flex-col gap-2">
        <button type="button" className="underline" onClick={() => go({ name: "agents" })}>
          {t("computer.back")}
        </button>
        {agent && <AgentAvatar avatar={agent.avatar} mood={agent.mood} name={agent.name} size={64} status={agent.status} />}
        <button type="button" className="rounded-blob bg-mint px-3 py-2 font-bold shadow-soft" onClick={() => void newThread()}>
          {t("chat.newThread")}
        </button>
        <ul className="flex flex-col gap-1" aria-label={t("chat.threads")}>
          {threads.map((th) => (
            <li key={th.id}>
              <button type="button" onClick={() => setThreadId(th.id)} className={`w-full rounded-blob px-3 py-1 text-left ${th.id === threadId ? "bg-peach" : ""}`}>
                {th.title}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="flex min-w-0 flex-col gap-3">
        <h2 className="text-2xl font-extrabold">{t("chat.title", { name: agent?.name ?? "…" })}</h2>
        <ol className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto rounded-blob bg-panel p-3" aria-live="polite" aria-label={t("chat.messages")}>
          {messages.map((m) => (
            <li key={m.id} className={`max-w-[85%] rounded-blob px-3 py-2 ${m.role === "user" ? "self-end bg-sky text-ink" : "self-start bg-mint text-ink"}`}>
              <p className="whitespace-pre-wrap break-words">{m.content}</p>
              {m.attachments.map((a) => (
                <a key={a.id} href={`/api/files/${a.id}`} className="block text-xs underline">
                  {a.name}
                </a>
              ))}
              {m.taskId && <p className="text-xs opacity-70">{t("chat.fromTask")}</p>}
            </li>
          ))}
          {streaming !== null && <li className="max-w-[85%] self-start rounded-blob bg-mint px-3 py-2 text-ink">{streaming || "…"}</li>}
          <div ref={bottom} />
        </ol>
        <form onSubmit={send} className="flex flex-col gap-2">
          <div className="flex gap-2" role="radiogroup" aria-label={t("chat.mode")}>
            {(["ask", "do"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`rounded-blob px-3 py-1 text-sm font-bold ${mode === m ? "bg-rainbow" : "bg-panel text-ink"}`}>
                {t(`chat.modes.${m}`)}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-blob border border-line px-3 py-2 text-ink"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={mode === "ask" ? t("chat.askPlaceholder") : t("chat.doPlaceholder")}
              aria-label={t("chat.message")}
            />
            <label className="cursor-pointer rounded-blob bg-lilac px-3 py-2 font-bold">
              {t("chat.attach")}
              <input type="file" className="sr-only" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            </label>
            <button className="rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft" disabled={streaming !== null}>
              {t("chat.send")}
            </button>
          </div>
          {files.length > 0 && <p className="text-sm">{t("chat.attached", { names: files.map((f) => f.name).join(", ") })}</p>}
          {error && <p role="alert" className="text-accent">{error}</p>}
        </form>
      </div>
    </section>
  );
}
