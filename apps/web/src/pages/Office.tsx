import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { applyOfficeEvent, emptyOffice, officeView, reduceOffice, ZONES, type OfficeState, type OfficeView, type StoredEvent, type Zone } from "@northbot/shared";
import { api, wsUrl } from "../api.js";
import { AgentAvatar } from "../components/AgentAvatar.js";
import { OfficeScene, type BubbleDial } from "../office/scene.js";
import { useSession } from "../store/session.js";

declare global {
  interface Window {
    /** Test hook: the office's state and where things are on screen. */
    __northbotOffice?: {
      ready: boolean;
      state(): OfficeState;
      view(): OfficeView;
      events(): StoredEvent[];
      reduce(events: StoredEvent[]): OfficeState;
      screenOf(agentId: string): { x: number; y: number } | null;
      letterScreenOf(letterId: string): { x: number; y: number } | null;
      zoneScreenOf(zone: Zone): { x: number; y: number } | null;
      settled(): boolean;
    };
  }
}

interface Prefs {
  bubbles: BubbleDial;
  topicOnly: boolean;
  calm: boolean;
  reducedMotion: boolean;
  sound: boolean;
}

const PREFS_KEY = "northbot.office";
function loadPrefs(): Prefs {
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const base: Prefs = { bubbles: "all", topicOnly: false, calm: false, reducedMotion: Boolean(reduced), sound: false };
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return base;
  }
}

/** Live events: replay the whole log, then follow it. The office is a reduction of it. */
function useOfficeFeed() {
  const events = useRef<StoredEvent[]>([]);
  const live = useRef<OfficeState>(emptyOffice());
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let pending = false;
    const bump = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        setVersion((v) => v + 1);
      });
    };
    const seen = new Set<number>();
    const connect = () => {
      // After a reconnect, replay a little overlap: events that committed late may be in it.
      const from = Math.max(0, live.current.lastEventId - 200);
      ws = new WebSocket(wsUrl(`/events/stream?from=${from}`));
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as { kind: "event"; event: StoredEvent } | { kind: "replay_done" };
        if (msg.kind === "event") {
          const e = msg.event;
          if (seen.has(e.id)) return;
          seen.add(e.id);
          if (e.id > live.current.lastEventId) {
            events.current.push(e);
            applyOfficeEvent(live.current, e);
          } else {
            // A write that committed late: put it in its place and rebuild the office.
            const at = events.current.findIndex((x) => x.id > e.id);
            events.current.splice(at < 0 ? events.current.length : at, 0, e);
            live.current = reduceOffice(events.current);
          }
          bump();
        } else {
          setReady(true);
          bump();
        }
      };
      ws.onclose = () => {
        if (!stopped) window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stopped = true;
      ws?.close();
    };
  }, []);
  return { events, live, version, ready };
}

/** A tiny optional "boop" (muted unless sound is on). */
function boop(on: boolean, freq: number): void {
  if (!on) return;
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = "triangle";
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch {
    // No audio here; sounds are optional.
  }
}
const buzz = () => navigator.vibrate?.(12);

export function Office() {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const { events, live, version, ready } = useOfficeFeed();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [mode, setMode] = useState<"office" | "list">("office");
  const [focus, setFocus] = useState<Zone | "">(() => (typeof window !== "undefined" && window.innerWidth < 640 ? "desk" : ""));
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [timezone, setTimezone] = useState("UTC");
  const [now, setNow] = useState(() => new Date());
  const [poke, setPoke] = useState<{ id: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const scene = useRef<OfficeScene | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Preferences are a convenience; ignore storage errors.
    }
  }, [prefs]);
  useEffect(() => {
    void api<{ timezone: string }>("GET", "/settings").then((s) => setTimezone(s.timezone));
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // The office at the chosen moment: live, or replayed up to an event (time slider).
  const state = useMemo(() => (replayAt === null ? live.current : reduceOffice(events.current.filter((e) => e.id <= replayAt))), [version, replayAt]);
  const view = useMemo(() => officeView(state, replayAt === null ? now : new Date(events.current.find((e) => e.id >= replayAt)?.ts ?? now), timezone), [state, now, timezone, version]);
  const firstId = events.current[0]?.id ?? 0;
  const lastId = live.current.lastEventId;

  const act = (fn: () => Promise<unknown>) => void fn().catch(() => {});
  const callbacks = useMemo(
    () => ({
      lift: (id: string) => {
        boop(prefsRef.current.sound, 660);
        buzz();
        act(() => api("POST", `/agents/${id}/lift`));
      },
      drop: (id: string, zone: Zone) => {
        boop(prefsRef.current.sound, 440);
        buzz();
        act(async () => {
          await api("POST", `/agents/${id}/drop`, { zone });
          if (zone === "meeting_room") go({ name: "chat", agentId: id });
          if (zone === "stage") go({ name: "talks" });
        });
      },
      shake: (id: string) => {
        boop(prefsRef.current.sound, 880);
        act(() => api("POST", `/agents/${id}/shake`));
      },
      poke: (id: string, x: number, y: number) => {
        boop(prefsRef.current.sound, 520);
        setPoke({ id, x, y });
      },
      openChat: (id: string) => go({ name: "chat", agentId: id }),
      menu: (id: string, x: number, y: number) => setMenu({ id, x, y }),
      assignLetter: (letterId: string, agentId: string) => act(() => api("POST", `/letters/${letterId}/assign`, { agentId })),
    }),
    [],
  );

  // The canvas lives as long as the office view is open.
  useEffect(() => {
    if (mode !== "office" || !host.current) return;
    const s = new OfficeScene(callbacks);
    scene.current = s;
    void s.init(host.current);
    return () => {
      s.destroy();
      scene.current = null;
    };
  }, [mode]);

  useEffect(() => {
    scene.current?.update(state, view, { ...prefs, focus: focus || null, t: (k, v) => t(k, v) });
  }, [state, view, prefs, focus, version]);

  useEffect(() => {
    if (!poke) return;
    const timer = window.setTimeout(() => setPoke(null), 3500);
    return () => window.clearTimeout(timer);
  }, [poke]);

  useEffect(() => {
    window.__northbotOffice = {
      ready,
      state: () => state,
      view: () => view,
      events: () => events.current,
      reduce: reduceOffice,
      screenOf: (id) => scene.current?.screenOf(id) ?? null,
      letterScreenOf: (id) => scene.current?.letterScreenOf(id) ?? null,
      zoneScreenOf: (z) => scene.current?.zoneScreenOf(z) ?? null,
      settled: () => scene.current?.settled() ?? true,
    };
  }, [ready, state, view]);
  useEffect(() => {
    return () => {
      delete window.__northbotOffice;
    };
  }, []);

  const box = wrap.current?.getBoundingClientRect();
  const rel = (p: { x: number; y: number }) => ({ left: p.x - (box?.left ?? 0), top: p.y - (box?.top ?? 0) });
  const agentOf = (id: string) => view.agents.find((a) => a.id === id);
  const statusLine = (id: string) => {
    const a = agentOf(id);
    if (!a) return "";
    if (a.held) return `${a.name}: ${t("office.held")}`;
    return t("office.statusLine", {
      name: a.name,
      activity: t(`office.activities.${a.activity}`),
      zone: t(`office.zones.${a.zone}`),
      mood: t(`moods.${a.mood}`, { defaultValue: a.mood }),
    });
  };
  const menuAction = (id: string, what: string) => {
    setMenu(null);
    if (what === "chat") go({ name: "chat", agentId: id });
    else if (what === "computer") go({ name: "computer", agentId: id });
    else if (what === "pet") act(() => api("POST", `/agents/${id}/cheer`, { how: "pet" }));
    else if (what === "cookie") act(() => api("POST", `/agents/${id}/cookie`));
    else if (what === "shake") act(() => api("POST", `/agents/${id}/shake`));
    else if (what === "rest")
      act(async () => {
        await api("POST", `/agents/${id}/lift`);
        await api("POST", `/agents/${id}/drop`, { zone: "break_room" });
      });
  };
  const inbox = Object.values(state.letters).filter((l) => l.at === "inbox" && l.status === "needs_human").length;
  const toggle = (k: "topicOnly" | "calm" | "reducedMotion" | "sound") => (
    <label className="flex items-center gap-1 text-sm">
      <input type="checkbox" checked={prefs[k]} onChange={(e) => setPrefs({ ...prefs, [k]: e.target.checked })} />
      {t(`office.${k}`)}
    </label>
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-2xl font-extrabold">{t("office.title")}</h2>
          <p className="text-sm text-muted">{t("office.intro")}</p>
        </div>
        <div className="flex gap-1" role="tablist">
          {(["office", "list"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={`rounded-blob px-3 py-1 text-sm shadow-soft ${mode === m ? "bg-rainbow font-bold" : "bg-peach"}`} onClick={() => setMode(m)}>
              {t(m === "office" ? "office.viewOffice" : "office.viewList")}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-blob bg-panel px-3 py-2">
        <span className="text-xs text-muted">{view.clock}</span>
        <label className="flex items-center gap-1 text-sm">
          {t("office.bubbles")}
          <select className="rounded-blob border border-line bg-peach px-2 py-1 text-ink" value={prefs.bubbles} onChange={(e) => setPrefs({ ...prefs, bubbles: e.target.value as BubbleDial })}>
            {(["all", "important", "none"] as const).map((d) => (
              <option key={d} value={d}>
                {t(`office.dial.${d}`)}
              </option>
            ))}
          </select>
        </label>
        {toggle("topicOnly")}
        {toggle("calm")}
        {toggle("reducedMotion")}
        {toggle("sound")}
        <label className="flex items-center gap-1 text-sm">
          {t("office.room")}
          <select className="rounded-blob border border-line bg-peach px-2 py-1 text-ink" value={focus} onChange={(e) => setFocus(e.target.value as Zone | "")}>
            <option value="">{t("office.allRooms")}</option>
            {ZONES.map((z) => (
              <option key={z} value={z}>
                {t(`office.zones.${z}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {view.alert && (
        <p role="alert" className="rounded-blob bg-mint p-2 text-sm">
          💤 {view.alert}
        </p>
      )}
      {state.killSwitch && (
        <p role="alert" className="rounded-blob bg-accent p-2 text-sm font-bold text-cream">
          {t("office.killSwitch")}
        </p>
      )}
      {inbox > 0 && <p className="text-sm text-muted">✉ {t("office.inbox", { count: inbox })}</p>}
      {!ready && <p className="text-sm text-muted">{t("office.loading")}</p>}
      {mode === "office" ? (
        <div ref={wrap} className="relative">
          <div ref={host} data-testid="office-canvas" className="h-[68vh] min-h-[380px] w-full overflow-hidden rounded-blob border border-line" aria-label={t("office.title")} role="img" />
          <p className="mt-1 text-xs text-muted">{t("office.hints")}</p>
          {poke && agentOf(poke.id) && (
            <p role="status" className="pointer-events-none absolute max-w-xs rounded-blob bg-panel px-3 py-2 text-sm shadow-soft" style={rel({ x: poke.x + 12, y: poke.y - 40 })}>
              {statusLine(poke.id)}
            </p>
          )}
          {menu && (
            <div className="absolute" style={rel(menu)} role="menu" aria-label={agentOf(menu.id)?.name}>
              {(["chat", "computer", "pet", "cookie", "shake", "rest", "close"] as const).map((what, i, all) => {
                const a = (i / all.length) * 2 * Math.PI - Math.PI / 2;
                return (
                  <button
                    key={what}
                    type="button"
                    role="menuitem"
                    className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-blob bg-lilac px-2 py-1 text-xs font-bold shadow-soft hover:bg-butter"
                    style={{ left: Math.cos(a) * 64, top: Math.sin(a) * 64 }}
                    onClick={() => (what === "close" ? setMenu(null) : menuAction(menu.id, what))}
                  >
                    {t(`office.menu.${what}`)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-blob bg-panel p-3">
          {view.agents.length === 0 ? (
            <p>{t("office.empty")}</p>
          ) : (
            <table className="w-full text-left text-sm" data-testid="office-list">
              <thead className="text-muted">
                <tr>
                  <th className="p-2">{t("office.list.agent")}</th>
                  <th className="p-2">{t("office.list.where")}</th>
                  <th className="p-2">{t("office.list.doing")}</th>
                  <th className="p-2">{t("office.list.mood")}</th>
                  <th className="p-2">{t("office.list.says")}</th>
                </tr>
              </thead>
              <tbody>
                {view.agents.map((a) => (
                  <tr key={a.id} className="border-t border-line">
                    <td className="flex items-center gap-2 p-2 font-bold">
                      <AgentAvatar avatar={a.avatar} mood={a.mood} size={28} name={a.name} />
                      {a.name}
                    </td>
                    <td className="p-2">
                      {t(`office.zones.${a.zone}`)}
                      {a.rest && <span className="block text-xs text-muted">{a.rest.why}</span>}
                    </td>
                    <td className="p-2">{a.held ? t("office.held") : t(`office.activities.${a.activity}`)}</td>
                    <td className="p-2">{t(`moods.${a.mood}`, { defaultValue: a.mood })}</td>
                    <td className="p-2 text-xs">{a.bubble ? (prefs.topicOnly ? t("office.about", { topic: a.bubble.topic }) : a.bubble.text) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {state.papers.length > 0 && <p className="mt-2 text-xs text-muted">{t("office.papers", { count: state.papers.length })}</p>}
        </div>
      )}
      <div className="flex items-center gap-2">
        <label className="flex flex-1 items-center gap-2 text-sm">
          {t("office.time")}
          <input
            type="range"
            className="flex-1"
            min={firstId}
            max={Math.max(firstId, lastId)}
            value={replayAt ?? lastId}
            onChange={(e) => setReplayAt(Number(e.target.value) >= lastId ? null : Number(e.target.value))}
            aria-label={t("office.time")}
          />
        </label>
        <button type="button" className={`rounded-blob px-3 py-1 text-sm font-bold shadow-soft ${replayAt === null ? "bg-rainbow" : "bg-peach"}`} onClick={() => setReplayAt(null)}>
          {t("office.live")}
        </button>
      </div>
      {replayAt !== null && <p className="text-xs text-muted">{t("office.replayAt", { id: replayAt, last: lastId })}</p>}
    </section>
  );
}
