import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";
import { AgentAvatar } from "../components/AgentAvatar.js";
import { Icon } from "../components/Icon.js";
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

async function readSse(res: Response, on: (event: string, data: unknown) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Missing response stream");
  const decoder = new TextDecoder();
  let buf = "";
  try {
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
  } finally {
    reader.releaseLock();
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
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLLIElement>(null);
  const messageViewport = useRef<HTMLOListElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    let mounted = true;
    const loadAgent = () =>
      void api<Agent>("GET", `/agents/${agentId}`)
        .then((r) => {
          if (mounted) setAgent(r);
        })
        .catch(() => {});
    loadAgent();
    const timer = setInterval(loadAgent, 3000);
    void api<{ threads: Thread[] }>("GET", `/agents/${agentId}/threads`)
      .then(async (r) => {
        const list = r.threads.length
          ? r.threads
          : [
              await api<Thread>("POST", `/agents/${agentId}/threads`, {
                title: t("chat.firstThread"),
              }),
            ];
        if (mounted) {
          setThreads(list);
          setThreadId(list[0]?.id ?? null);
        }
      })
      .catch(() => {
        if (mounted) setError(t("ui.loadFailed"));
      });
    return () => {
      mounted = false;
      clearInterval(timer);
      controller.current?.abort();
    };
  }, [agentId, t]);

  useEffect(() => {
    if (!threadId) return;
    let mounted = true;
    setMessages([]);
    follow.current = true;
    const load = () => {
      if (busy.current) return;
      void api<{ messages: Message[] }>("GET", `/threads/${threadId}/messages`)
        .then((r) => {
          if (mounted && !busy.current) setMessages(r.messages);
        })
        .catch(() => {
          if (mounted) setError(t("ui.refreshFailed"));
        });
    };
    load();
    const timer = setInterval(load, 3000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [threadId, t]);
  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages, streaming]);

  const newThread = async () => {
    if (busy.current) return;
    try {
      const created = await api<Thread>("POST", `/agents/${agentId}/threads`, {
        title: t("chat.newThread"),
      });
      setThreads((old) => [created, ...old]);
      setThreadId(created.id);
      setError(null);
    } catch {
      setError(t("ui.failed"));
    }
  };
  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/files", {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error("Upload failed");
      const attachment = (await res.json()) as Attachment;
      setFiles((old) => [...old, attachment]);
    } catch {
      setError(t("chat.uploadFailed"));
    } finally {
      setUploading(false);
    }
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!threadId || !draft.trim() || busy.current || uploading) return;
    busy.current = true;
    setSending(true);
    setError(null);
    follow.current = true;
    const text = draft,
      attachments = files;
    const body = { content: text, mode, attachmentIds: attachments.map((f) => f.id) };
    let accepted = false;
    try {
      if (mode === "do") {
        await api("POST", `/threads/${threadId}/messages`, body);
        accepted = true;
        setDraft("");
        setFiles([]);
      } else {
        controller.current = new AbortController();
        const res = await fetch(`/api/threads/${threadId}/messages`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.current.signal,
        });
        if (!res.ok) throw new Error(t("chat.sendFailed"));
        setStreaming("");
        await readSse(res, (event, data) => {
          if (event === "user") {
            accepted = true;
            setDraft("");
            setFiles([]);
            setMessages((m) => [...m, data as Message]);
          }
          if (event === "delta") setStreaming((s) => (s ?? "") + (data as { text: string }).text);
          if (event === "error") setError((data as { message: string }).message);
          if (event === "done") {
            setMessages((m) => [...m, data as Message]);
            setStreaming(null);
          }
        });
      }
      setMessages(
        (await api<{ messages: Message[] }>("GET", `/threads/${threadId}/messages`)).messages,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof ApiError ? err.message : t("chat.sendFailed"));
      if (!accepted) {
        setDraft(text);
        setFiles(attachments);
      }
    } finally {
      busy.current = false;
      setSending(false);
      setStreaming(null);
      controller.current = null;
    }
  };

  return (
    <section className="chat-layout">
      <aside className="chat-sidebar">
        <button type="button" className="chat-back" onClick={() => go({ name: "agents" })}>
          ← {t("computer.back")}
        </button>
        {agent && (
          <div className="chat-profile">
            <AgentAvatar
              avatar={agent.avatar}
              mood={agent.mood}
              name={agent.name}
              size={46}
              status={agent.status}
            />
            <div>
              <strong>{agent.name}</strong>
              <small>{t(`status.${agent.status}`, { defaultValue: agent.status })}</small>
            </div>
          </div>
        )}
        <button
          type="button"
          className="primary-button"
          disabled={sending}
          onClick={() => void newThread()}
        >
          <Icon name="plus" size={15} />
          {t("chat.newThread")}
        </button>
        <p className="eyebrow mt-4">{t("chat.threads")}</p>
        <ul className="flex flex-col gap-1" aria-label={t("chat.threads")}>
          {threads.map((th) => (
            <li key={th.id}>
              <button
                type="button"
                disabled={sending}
                onClick={() => setThreadId(th.id)}
                aria-current={th.id === threadId ? "true" : undefined}
                className="w-full rounded-blob text-left"
              >
                {th.title}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="chat-main">
        <div className="chat-heading">
          <div>
            <h2>{t("chat.title", { name: agent?.name ?? "…" })}</h2>
            <p>{t("ui.chatIntro")}</p>
          </div>
          <button
            type="button"
            className="agent-computer"
            onClick={() => go({ name: "computer", agentId })}
          >
            <Icon name="computer" size={16} />
            {t("agents.computer")}
          </button>
        </div>
        <ol
          ref={messageViewport}
          className="chat-messages"
          aria-live="polite"
          aria-label={t("chat.messages")}
          onScroll={() => {
            const el = messageViewport.current;
            if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
          }}
        >
          {messages.length === 0 && streaming === null && (
            <li className="page-state chat-empty">
              <span className="page-state-icon">
                <Icon name="spark" size={27} />
              </span>
              <h3>{t("ui.chatEmpty")}</h3>
              <p>{t("ui.chatEmptyHelp")}</p>
            </li>
          )}
          {messages.map((m) => (
            <li key={m.id} className={`chat-message chat-message-${m.role}`}>
              <span className="chat-message-label">
                {m.role === "user" ? t("rooms.you") : (agent?.name ?? t("rooms.system"))}
              </span>
              <p className="whitespace-pre-wrap break-words">{m.content}</p>
              {m.attachments.map((a) => (
                <a
                  key={a.id}
                  href={`/api/files/${a.id}`}
                  className="block text-xs underline"
                  download
                >
                  {a.name}
                </a>
              ))}
              {m.taskId && <p className="text-xs text-muted">{t("chat.fromTask")}</p>}
            </li>
          ))}
          {streaming !== null && (
            <li className="chat-message chat-message-agent">
              <span className="chat-message-label">{agent?.name}</span>
              <p className="whitespace-pre-wrap break-words">{streaming || "…"}</p>
            </li>
          )}
          <li ref={bottom} aria-hidden="true" />
        </ol>
        <form onSubmit={send} className="chat-composer">
          <div className="chat-composer-top">
            <div className="filter-tabs" role="radiogroup" aria-label={t("chat.mode")}>
              {(["ask", "do"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  aria-pressed={mode === m}
                  disabled={sending}
                  onClick={() => setMode(m)}
                >
                  {t(`chat.modes.${m}`)}
                </button>
              ))}
            </div>
            <small>{t(mode === "ask" ? "ui.askHelp" : "ui.doHelp")}</small>
          </div>
          <div className="chat-composer-row">
            <textarea
              rows={2}
              value={draft}
              disabled={sending}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={mode === "ask" ? t("chat.askPlaceholder") : t("chat.doPlaceholder")}
              aria-label={t("chat.message")}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <label className="chat-attach">
              <Icon name="plus" size={17} />
              {t("chat.attach")}
              <input
                type="file"
                className="sr-only"
                disabled={sending || uploading}
                aria-label={t("ui.attach")}
                onChange={(e) => {
                  if (e.target.files?.[0]) void upload(e.target.files[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              type="submit"
              className="primary-button"
              disabled={sending || uploading || !threadId || !draft.trim()}
            >
              {sending ? t("ui.sending") : t("chat.send")}
              <Icon name="arrow" size={16} />
            </button>
          </div>
          {files.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {files.map((f) => (
                <li key={f.id} className="chat-attachment">
                  {f.name}
                  <button
                    type="button"
                    disabled={sending}
                    aria-label={t("ui.removeAttachment", { name: f.name })}
                    onClick={() => setFiles((old) => old.filter((x) => x.id !== f.id))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
        {error && (
          <p role="alert" className="text-sm text-accent">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
