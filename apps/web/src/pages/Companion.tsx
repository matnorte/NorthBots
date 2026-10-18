import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";

interface Device {
  id: string;
  name: string;
  os: string;
  mac: string | null;
  power: "view" | "view+click" | "full";
  folders: string[];
  apps: string[];
  agentId: string | null;
  enabled: boolean;
  online: boolean;
  lastSeenAt: string | null;
}

/** The Windows companion: pair computers, choose which agent may use each, stop or unpair them. */
export function Companion() {
  const { t } = useTranslation();
  const c = (k: string, v?: Record<string, unknown>) => t(`companion.${k}`, v);
  const [devices, setDevices] = useState<Device[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [shot, setShot] = useState<{ id: string; png: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () =>
    setDevices((await api<{ devices: Device[] }>("GET", "/companion/devices")).devices);
  useEffect(() => {
    void api<{ agents: { id: string; name: string }[] }>("GET", "/agents").then((r) =>
      setAgents(r.agents),
    );
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setNote(null);
    try {
      await fn();
      await load();
      if (done) setNote(done);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : c("failed"));
    }
  };
  const origin = typeof location === "undefined" ? "" : `${location.origin}/api`;

  return (
    <section className="flex max-w-5xl flex-col gap-5">
      <header>
        <p className="eyebrow">NorthBot</p>
        <h2 className="text-3xl font-extrabold">{c("title")}</h2>
        <p className="text-muted">{c("intro")}</p>
      </header>
      {error && (
        <p role="alert" className="text-accent">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      <div className="settings-card flex flex-col gap-3">
        <h3 className="text-xl font-bold">{c("pairTitle")}</h3>
        <button
          type="button"
          className="self-start rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft"
          onClick={() => void act(async () => setCode(await api("POST", "/companion/pairings")))}
        >
          {c("newCode")}
        </button>
        {code && (
          <div className="flex flex-col gap-1">
            <p className="text-sm">{c("pairHelp")}</p>
            <code className="break-all rounded-lg bg-cream p-3 text-sm" data-testid="pair-command">
              northbot-companion pair --api {origin} --code {code.code}
            </code>
            <p className="text-xs text-muted">
              {c("codeExpires", { time: new Date(code.expiresAt).toLocaleTimeString() })}
            </p>
          </div>
        )}
      </div>
      <div className="settings-card flex flex-col gap-3">
        <h3 className="text-xl font-bold">{c("devices")}</h3>
        {devices.length === 0 && <p className="text-muted">{c("none")}</p>}
        <ul className="flex flex-col gap-3">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>
                  {d.name} <span className="text-sm font-normal text-muted">{d.os}</span>
                </strong>
                <span className={d.online ? "text-mint" : "text-muted"}>
                  {d.online ? c("online") : c("offline")}
                </span>
              </div>
              <p className="text-sm">
                {c("power")}: {c(`powers.${d.power}`)} ·{" "}
                {c("shares", { folders: d.folders.length, apps: d.apps.length })}
                {d.apps.length > 0 && <span className="text-muted"> ({d.apps.join(", ")})</span>}
              </p>
              {d.lastSeenAt && (
                <p className="text-xs text-muted">
                  {c("lastSeen", { time: new Date(d.lastSeenAt).toLocaleString() })}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  {c("agent")}
                  <select
                    aria-label={c("agent")}
                    value={d.agentId ?? ""}
                    onChange={(e) =>
                      void act(
                        () =>
                          api("PATCH", `/companion/devices/${d.id}`, {
                            agentId: e.target.value || null,
                            enabled: e.target.value ? d.enabled : false,
                          }),
                        c("saved"),
                      )
                    }
                  >
                    <option value="">{c("nobody")}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    disabled={!d.agentId}
                    onChange={(e) =>
                      void act(
                        () =>
                          api("PATCH", `/companion/devices/${d.id}`, { enabled: e.target.checked }),
                        c("saved"),
                      )
                    }
                  />
                  {c("enabled")}
                </label>
              </div>
              <div className="flex flex-wrap gap-2 text-sm">
                <button
                  type="button"
                  disabled={!d.online}
                  className="rounded-blob bg-sky px-3 py-1 font-bold shadow-soft disabled:opacity-50"
                  onClick={() =>
                    void act(async () => {
                      const r = await api<{ data: { png: string } }>(
                        "POST",
                        `/companion/devices/${d.id}/command`,
                        { action: "screenshot", args: {} },
                      );
                      setShot({ id: d.id, png: r.data.png });
                    })
                  }
                >
                  {c("screenshot")}
                </button>
                {d.mac && !d.online && (
                  <button
                    type="button"
                    className="rounded-blob bg-peach px-3 py-1 font-bold shadow-soft"
                    onClick={() => void act(() => api("POST", `/companion/devices/${d.id}/wake`))}
                  >
                    {c("wake")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={!d.online}
                  className="rounded-blob bg-lilac px-3 py-1 font-bold shadow-soft disabled:opacity-50"
                  onClick={() => void act(() => api("POST", `/companion/devices/${d.id}/kill`))}
                >
                  {c("kill")}
                </button>
                <button
                  type="button"
                  className="rounded-blob bg-peach px-3 py-1 text-accent shadow-soft"
                  onClick={() =>
                    window.confirm(c("unpairConfirm")) &&
                    void act(() => api("DELETE", `/companion/devices/${d.id}`))
                  }
                >
                  {c("unpair")}
                </button>
              </div>
              {shot?.id === d.id && shot.png && (
                <img
                  className="max-h-80 self-start rounded-lg border border-line"
                  alt={c("screenshot")}
                  src={`data:image/png;base64,${shot.png}`}
                />
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
