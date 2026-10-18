import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Avatar } from "@northbot/shared";
import { api, ApiError } from "../api.js";
import { AgentAvatar } from "../components/AgentAvatar.js";
import { useSession } from "../store/session.js";
import type { Agent } from "./Agents.js";

export interface RoomSummary {
  id: string;
  name: string;
  goal: string;
  brief: string;
  kind: string;
  coordinatorAgentId: string | null;
  turnRule: string;
  costCapUsd: number;
  spentUsd: number;
  status: string;
}
interface Member {
  agentId: string;
  name: string;
  role: string;
  avatar: Partial<Avatar>;
  status: string;
}
export interface RoomMessage {
  id: string;
  authorKind: string;
  agentId: string | null;
  content: string;
  kind: string;
  meta: Record<string, unknown>;
  createdAt: string;
}
interface RoomView extends RoomSummary {
  members: Member[];
  messages: RoomMessage[];
  board: { id: string; agentId: string; goal: string; status: string }[];
}

/** Agent picker shared by the room and Talk forms: a row of toggle chips. */
export function AgentChips({ agents, selected, onChange, label }: { agents: Agent[]; selected: string[]; onChange: (ids: string[]) => void; label: string }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {agents.map((a) => {
          const on = selected.includes(a.id);
          return (
            <button
              key={a.id}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((x) => x !== a.id) : [...selected, a.id])}
              className={`flex items-center gap-1 rounded-blob px-2 py-1 text-sm shadow-soft ${on ? "rainbow-border bg-lilac" : "bg-peach"}`}
            >
              <AgentAvatar avatar={a.avatar} size={22} />
              {a.name}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The conversation in a room (or a Talk): who said what, with each agent's face. */
export function MessageList({ messages, members }: { messages: RoomMessage[]; members: Member[] }) {
  const { t } = useTranslation();
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);
  const who = (m: RoomMessage) => members.find((x) => x.agentId === m.agentId);
  return (
    <ol className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto rounded-blob bg-panel p-3" aria-live="polite">
      {messages.map((m) => {
        const agent = who(m);
        const mine = m.authorKind === "user";
        return (
          <li key={m.id} className={`flex gap-2 ${mine ? "flex-row-reverse text-right" : ""}`}>
            {agent ? <AgentAvatar avatar={agent.avatar} size={32} name={agent.name} /> : <span className="h-8 w-8 shrink-0" aria-hidden="true" />}
            <div className={`max-w-[80%] rounded-blob px-3 py-2 ${mine ? "bg-lilac" : m.authorKind === "system" ? "bg-cream text-muted" : "bg-peach"}`}>
              <p className="text-xs text-muted">
                {mine ? t("rooms.you") : (agent?.name ?? t("rooms.system"))}
                {m.kind !== "message" && <span className="text-rainbow ml-2 font-bold">{t(`rooms.kinds.${m.kind}`, { defaultValue: m.kind })}</span>}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">{m.content}</p>
            </div>
          </li>
        );
      })}
      <li ref={end} aria-hidden="true" />
    </ol>
  );
}

export function Room({ roomId }: { roomId: string }) {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [text, setText] = useState("");
  const [goal, setGoal] = useState("");
  const [assignee, setAssignee] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => setRoom(await api<RoomView>("GET", `/rooms/${roomId}`));
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [roomId]);
  if (!room) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("rooms.failed"));
    }
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api("POST", `/rooms/${roomId}/messages`, { content: text });
      setText("");
    });
  };
  const addTask = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api("POST", `/rooms/${roomId}/tasks`, { agentId: assignee || room.members[0]?.agentId, goal });
      setGoal("");
    });
  };
  const nameOf = (id: string) => room.members.find((m) => m.agentId === id)?.name ?? "?";

  return (
    <section className="flex flex-col gap-4">
      <button type="button" className="self-start underline" onClick={() => go({ name: "rooms" })}>
        {t("rooms.back")}
      </button>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-2xl font-extrabold">{room.name}</h2>
          {room.goal && <p className="text-sm">{room.goal}</p>}
        </div>
        <p className="text-sm text-muted">{t("rooms.spent", { spent: room.spentUsd.toFixed(2), cap: room.costCapUsd.toFixed(2) })}</p>
      </div>
      {room.brief && (
        <p className="rainbow-border whitespace-pre-wrap rounded-blob bg-panel p-3 text-sm">
          <strong>{t("rooms.brief")}: </strong>
          {room.brief}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {room.members.map((m) => (
          <span key={m.agentId} className="flex items-center gap-1 text-sm">
            <AgentAvatar avatar={m.avatar} size={36} name={m.name} status={m.status} />
            {m.name}
            {m.role !== "member" && <span className="text-xs text-muted">({m.role})</span>}
          </span>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="flex min-w-0 flex-col gap-2">
          <MessageList messages={room.messages} members={room.members} />
          {room.kind === "room" && (
            <form onSubmit={send} className="flex gap-2">
              <input
                className="flex-1 rounded-blob border border-line bg-peach px-3 py-2 text-ink"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("rooms.placeholder")}
                aria-label={t("rooms.placeholder")}
                required
              />
              <button className="rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft">{t("rooms.send")}</button>
              <button type="button" className="rounded-blob bg-peach px-3 py-2 font-bold shadow-soft" onClick={() => void run(() => api("POST", `/rooms/${roomId}/interrupt`))}>
                {t("rooms.interrupt")}
              </button>
            </form>
          )}
          {error && (
            <p role="alert" className="text-accent">
              {error}
            </p>
          )}
        </div>
        {room.kind === "room" && (
          <aside className="flex flex-col gap-2" aria-label={t("rooms.board")}>
            <h3 className="font-bold">{t("rooms.board")}</h3>
            {room.board.length === 0 && <p className="text-sm text-muted">{t("rooms.boardEmpty")}</p>}
            <ul className="flex flex-col gap-2">
              {room.board.map((b) => (
                <li key={b.id} className="rounded-blob bg-panel p-2 text-sm shadow-soft">
                  <p>{b.goal}</p>
                  <p className="text-xs text-muted">
                    {nameOf(b.agentId)} · {t(`tasks.status.${b.status}`, { defaultValue: b.status })}
                  </p>
                </li>
              ))}
            </ul>
            <form onSubmit={addTask} className="flex flex-col gap-2">
              <input
                className="rounded-blob border border-line bg-peach px-3 py-2 text-sm text-ink"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={t("rooms.taskGoal")}
                aria-label={t("rooms.taskGoal")}
                required
                minLength={3}
              />
              <label className="flex items-center gap-2 text-sm">
                {t("rooms.assignTo")}
                <select className="flex-1 rounded-blob border border-line bg-peach px-2 py-1 text-ink" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  {room.members.map((m) => (
                    <option key={m.agentId} value={m.agentId}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="rounded-blob bg-sky px-3 py-1 font-bold shadow-soft">{t("rooms.addTask")}</button>
            </form>
          </aside>
        )}
      </div>
    </section>
  );
}

/** Rooms: list and create. */
export function Rooms() {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [form, setForm] = useState({ name: "", goal: "", brief: "", agentIds: [] as string[], coordinatorAgentId: "", turnRule: "coordinator", costCapUsd: 1 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ rooms: RoomSummary[] }>("GET", "/rooms?kind=room").then((r) => setRooms(r.rooms));
    void api<{ agents: Agent[] }>("GET", "/agents").then((r) => setAgents(r.agents));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const room = await api<RoomSummary>("POST", "/rooms", { ...form, coordinatorAgentId: form.coordinatorAgentId || null });
      go({ name: "room", roomId: room.id });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("rooms.failed"));
    }
  };
  const field = "rounded-blob border border-line bg-peach px-3 py-2 text-ink";

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-2xl font-extrabold">{t("rooms.title")}</h2>
        <p className="text-sm text-muted">{t("rooms.intro")}</p>
      </div>
      {rooms.length === 0 && <p className="rounded-blob bg-mint p-4">{t("rooms.empty")}</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {rooms.map((r) => (
          <li key={r.id}>
            <button type="button" className="flex w-full flex-col gap-1 rounded-blob bg-panel p-4 text-left shadow-soft hover:bg-peach" onClick={() => go({ name: "room", roomId: r.id })}>
              <span className="font-extrabold">{r.name}</span>
              {r.goal && <span className="text-sm">{r.goal}</span>}
              <span className="text-xs text-muted">{t("rooms.spent", { spent: r.spentUsd.toFixed(2), cap: r.costCapUsd.toFixed(2) })}</span>
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="flex flex-col gap-3 rounded-blob bg-panel p-4 shadow-soft">
        <h3 className="font-bold">{t("rooms.new")}</h3>
        <input className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("rooms.name")} aria-label={t("rooms.name")} required />
        <input className={field} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} placeholder={t("rooms.goal")} aria-label={t("rooms.goal")} />
        <textarea className={field} value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} placeholder={t("rooms.brief")} aria-label={t("rooms.brief")} />
        <AgentChips agents={agents} selected={form.agentIds} onChange={(agentIds) => setForm({ ...form, agentIds })} label={t("rooms.members")} />
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {t("rooms.coordinator")}
            <select className={field} value={form.coordinatorAgentId} onChange={(e) => setForm({ ...form, coordinatorAgentId: e.target.value })}>
              <option value="">{t("rooms.none")}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("rooms.turnRule")}
            <select className={field} value={form.turnRule} onChange={(e) => setForm({ ...form, turnRule: e.target.value })}>
              <option value="coordinator">{t("rooms.turnRules.coordinator")}</option>
              <option value="mentions">{t("rooms.turnRules.mentions")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("rooms.costCap")}
            <input type="number" min={0} step={0.1} className={`${field} w-28`} value={form.costCapUsd} onChange={(e) => setForm({ ...form, costCapUsd: Number(e.target.value) })} />
          </label>
        </div>
        {error && (
          <p role="alert" className="text-accent">
            {error}
          </p>
        )}
        <button className="self-start rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft">{t("rooms.create")}</button>
      </form>
    </section>
  );
}
