import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api.js";
import { useSession } from "../store/session.js";
import { LoadingState } from "../components/PageState.js";
interface Overview {
  members: { id: string; email: string; role: string }[];
  resources: { id: string; type: string; name: string }[];
  secretNames: string[];
  score: number;
  checks: { key: string; ok: boolean }[];
  grants: {
    id: string;
    resource: string;
    subjectKind: string;
    subjectId: string;
    role: string;
    expiresAt: string | null;
    revokedAt: string | null;
  }[];
  passkeys: { id: string; agentId: string; rpId: string }[];
  labels: { resourceType: string; resourceId: string; label: string; destinations: string[] }[];
  handoffs: { id: string; agentId: string; reason: string }[];
  canaries: { id: string; name: string; triggeredAt: string | null }[];
  egress: { agent_id: string; host: string; connections: number }[];
  alerts: { id: number; payload: { summary: string } }[];
}
const download = (name: string, data: unknown) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export function Security() {
  const { t } = useTranslation(),
    c = (key: string) => t(`security.${key}`),
    go = useSession((s) => s.go);
  const [data, setData] = useState<Overview | null>(null),
    [agents, setAgents] = useState<{ id: string; name: string }[]>([]),
    [agent, setAgent] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [resource, setResource] = useState(""),
    [role, setRole] = useState("use-only"),
    [expiry, setExpiry] = useState(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
  const [subjectKind, setSubjectKind] = useState("agent"),
    [subjectId, setSubjectId] = useState("");
  const [labelType, setLabelType] = useState("file"),
    [labelId, setLabelId] = useState(""),
    [label, setLabel] = useState("private"),
    [destinations, setDestinations] = useState(""),
    [canary, setCanary] = useState(""),
    [name, setName] = useState(""),
    [person, setPerson] = useState(""),
    [confirm, setConfirm] = useState("");
  const load = async () => {
    const [d, a] = await Promise.all([
      api<Overview>("GET", "/security"),
      api<{ agents: { id: string; name: string }[] }>("GET", "/agents"),
    ]);
    setData(d);
    setAgents(a.agents);
    setAgent((x) => x || a.agents[0]?.id || "");
  };
  useEffect(() => {
    void load().catch(() => setError(c("failed")));
  }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      setNotice(c("saved"));
    } catch {
      setError(c("failed"));
    } finally {
      setBusy(false);
    }
  };
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const picker = (
    <label>
      {c("agent")}
      <select aria-label={c("agent")} value={agent} onChange={(e) => setAgent(e.target.value)}>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
  if (!data) return error ? <p role="alert">{error}</p> : <LoadingState />;
  return (
    <section className="flex max-w-5xl flex-col gap-5">
      <header>
        <p className="eyebrow">NorthBot</p>
        <h2 className="text-3xl font-extrabold">{c("title")}</h2>
        <p className="text-muted">{c("intro")}</p>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="settings-card">
        <h3 className="text-xl font-bold">
          {c("score")} · {data.score}%
        </h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.checks.map((x) => (
            <li
              key={x.key}
              className="flex items-center justify-between gap-3 rounded-lg border border-line p-3"
            >
              <span>{c(x.key)}</span>
              <span className={x.ok ? "text-mint" : "text-accent"}>
                {x.ok ? c("active") : c("attention")}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted">{c("diskHelp")}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="settings-card">
          <h3 className="text-xl font-bold">{c("passkeys")}</h3>
          {data.passkeys.length ? (
            data.passkeys.map((p) => (
              <div key={p.id} className="my-2 flex flex-wrap items-center justify-between gap-2">
                <span>
                  {agentName(p.agentId)} · {p.rpId}
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api("POST", `/security/passkeys/${p.id}/connect`, {
                        agentId: p.agentId,
                      });
                    })
                  }
                >
                  {c("connect")}
                </button>
              </div>
            ))
          ) : (
            <p className="text-muted">{c("none")}</p>
          )}
        </div>
        <div className="settings-card">
          <h3 className="text-xl font-bold">{c("handoffs")}</h3>
          {data.handoffs.length ? (
            data.handoffs.map((h) => (
              <div key={h.id} className="my-2 flex flex-col gap-2">
                <span>
                  {agentName(h.agentId)} · {h.reason}
                </span>
                <div className="flex gap-2">
                  <button onClick={() => go({ name: "computer", agentId: h.agentId })}>
                    {c("open")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api("POST", `/security/handoffs/${h.id}/finish`);
                      })
                    }
                  >
                    {c("finish")}
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="text-muted">{c("none")}</p>
          )}
        </div>
      </div>
      <div className="settings-card">
        <h3 className="text-xl font-bold">{c("access")}</h3>
        {data.grants.length ? (
          data.grants.map((g) => (
            <div
              key={g.id}
              className="my-2 flex flex-wrap items-center justify-between gap-2 border-b border-line py-2"
            >
              <div className="break-all text-sm">
                <strong>{g.resource}</strong>
                <p>
                  {agentName(g.subjectId)} · {g.role} ·{" "}
                  {g.expiresAt ? new Date(g.expiresAt).toLocaleString() : c("owner")}
                </p>
              </div>
              {g.revokedAt || (g.expiresAt && new Date(g.expiresAt) < new Date()) ? (
                <span>{c("expires")}</span>
              ) : (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api("DELETE", `/security/grants/${g.id}`);
                    })
                  }
                >
                  {c("revoke")}
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="text-muted">{c("noGrants")}</p>
        )}
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api("POST", "/security/grants", {
                resource,
                subjectKind,
                subjectId: subjectKind === "agent" ? agent : subjectId,
                role,
                expiresAt: role === "owner" ? null : new Date(expiry).toISOString(),
              });
            });
          }}
        >
          <label>
            {c("resource")}
            <select required aria-label={c("resource")} value={resource} onChange={(e) => setResource(e.target.value)}>
              <option value="" />
              {data.secretNames.map((name) => (
                <option key={name} value={`secret:${name}`}>
                  {name}
                </option>
              ))}
              {data.passkeys.map((p) => (
                <option key={p.id} value={`passkey:${p.id}`}>
                  {p.rpId} · {agentName(p.agentId)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {c("subject")}
            <select
              aria-label={c("subject")}
              value={subjectKind}
              onChange={(e) => {
                setSubjectKind(e.target.value);
                setRole("use-only");
              }}
            >
              <option value="agent">{c("agent")}</option>
              <option value="user">{c("user")}</option>
            </select>
          </label>
          {subjectKind === "agent" ? (
            picker
          ) : (
            <label>
              {c("user")}
              <select aria-label={c("user")} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="" />
                {data.members.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.email}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {c("role")}
            <select aria-label={c("role")} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="use-only">{c("use")}</option>
              {subjectKind === "user" && (
                <>
                  <option value="user">{c("user")}</option>
                  <option value="owner">{c("owner")}</option>
                </>
              )}
            </select>
          </label>
          <label>
            {c("expiry")}
            <input
              type="datetime-local"
              required
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </label>
          <button disabled={busy || !agent} type="submit">
            {c("grant")}
          </button>
        </form>
      </div>
      <div className="settings-card">
        <h3 className="text-xl font-bold">{c("labels")}</h3>
        <ul>
          {data.labels.map((l) => (
            <li
              key={`${l.resourceType}:${l.resourceId}`}
              className="break-all border-b border-line py-2 text-sm"
            >
              {l.resourceType} ·{" "}
              {data.resources.find((r) => r.id === l.resourceId)?.name ?? agentName(l.resourceId)} ·{" "}
              <strong>{c(l.label)}</strong> · {l.destinations.join(", ")}
            </li>
          ))}
        </ul>
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api("POST", "/security/labels", {
                resourceType: labelType,
                resourceId: labelId,
                label,
                destinations: destinations
                  .split(/\r?\n/)
                  .map((x) => x.trim())
                  .filter(Boolean),
              });
            });
          }}
        >
          <label>
            {c("type")}
            <select aria-label={c("type")} value={labelType} onChange={(e) => setLabelType(e.target.value)}>
              {["file", "memory", "agent"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            {c("id")}
            <select required aria-label={c("id")} value={labelId} onChange={(e) => setLabelId(e.target.value)}>
              <option value="" />
              {data.resources
                .filter((r) => r.type === labelType)
                .map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {c("label")}
            <select aria-label={c("label")} value={label} onChange={(e) => setLabel(e.target.value)}>
              {["public", "private", "secret"].map((x) => (
                <option key={x} value={x}>
                  {c(x)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {c("destinations")}
            <textarea value={destinations} onChange={(e) => setDestinations(e.target.value)} />
          </label>
          <button disabled={busy}>{c("save")}</button>
        </form>
      </div>
      <div className="settings-card">
        <h3 className="text-xl font-bold">{c("tripwires")}</h3>
        {data.canaries.map((x) => (
          <p key={x.id}>
            {x.name} · {x.triggeredAt ? c("triggered") : c("watching")}
          </p>
        ))}
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const r = await api<{ token: string }>("POST", "/security/canaries", { name });
              setCanary(r.token);
              setName("");
            });
          }}
        >
          <label>
            {c("name")}
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button disabled={busy}>{c("create")}</button>
        </form>
        {canary && (
          <div>
            <p className="text-sm">{c("copy")}</p>
            <output className="break-all">{canary}</output>
          </div>
        )}
      </div>
      <div className="settings-card overflow-x-auto">
        <h3 className="text-xl font-bold">{c("egress")}</h3>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>{c("agent")}</th>
              <th>{c("host")}</th>
              <th>{c("count")}</th>
            </tr>
          </thead>
          <tbody>
            {data.egress.map((x, i) => (
              <tr key={i}>
                <td>{agentName(x.agent_id)}</td>
                <td>{x.host}</td>
                <td>{x.connections}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="settings-card">
        <h3 className="text-xl font-bold">{c("alerts")}</h3>
        <ul>
          {data.alerts.map((x) => (
            <li key={x.id}>{x.payload.summary}</li>
          ))}
        </ul>
      </div>
      <div className="settings-card flex flex-col gap-3">
        <h3 className="text-xl font-bold">{c("audit")}</h3>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () =>
              download("northbot-audit.json", await api("GET", "/security/audit")),
            )
          }
        >
          {c("download")}
        </button>
        {picker}
        <p className="text-sm text-muted">{c("recordHelp")}</p>
        <button
          disabled={busy || !agent}
          onClick={() =>
            void act(async () =>
              download(
                "northbot-activity.json",
                await api("POST", "/security/recordings", { agentId: agent }),
              ),
            )
          }
        >
          {c("record")}
        </button>
        <label>
          {c("person")}
          <input value={person} onChange={(e) => setPerson(e.target.value)} />
        </label>
        <button
          disabled={busy || person.trim().length < 3}
          onClick={() =>
            void act(async () =>
              download(
                "northbot-person.json",
                await api("POST", "/security/person/export", { query: person }),
              ),
            )
          }
        >
          {c("export")}
        </button>
        <label>
          {c("confirm")}
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </label>
        <button
          disabled={busy || confirm !== "ERASE" || person.trim().length < 3}
          onClick={() =>
            void act(async () => {
              await api("POST", "/security/person/erase", { query: person, confirmation: confirm });
              setConfirm("");
            })
          }
        >
          {c("erase")}
        </button>
      </div>
    </section>
  );
}
