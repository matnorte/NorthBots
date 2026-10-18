import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api.js";
interface Policy {
  effect: string;
  kind: string;
  costUsd: number;
}
interface Review {
  policies: Record<string, Policy>;
  hash: string;
  version: string;
  tools: { name: string; description?: string; inputSchema: object }[];
  scan: { ok: boolean; findings: { detail: string }[] };
  approved: boolean;
}
interface Connection {
  id: string;
  name: string;
  config: { transport: string; url?: string; command?: string };
}
const scopes = [
  "mcp:tasks:read",
  "mcp:tasks:write",
  "mcp:letters:write",
  "mcp:memory:read",
  "mcp:schedules:read",
  "mcp:schedules:write",
];
export function Connections() {
  const { t } = useTranslation();
  const c = (k: string) => t(`connections.${k}`);
  const [servers, setServers] = useState<Connection[]>([]),
    [agents, setAgents] = useState<{ id: string; name: string }[]>([]),
    [agentId, setAgentId] = useState("");
  const [name, setName] = useState(""),
    [transport, setTransport] = useState("http"),
    [url, setUrl] = useState(""),
    [command, setCommand] = useState("node"),
    [args, setArgs] = useState("[]"),
    [secret, setSecret] = useState("");
  const [review, setReview] = useState<{ id: string; data: Review } | null>(null),
    [policies, setPolicies] = useState<Record<string, Policy>>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [tokenName, setTokenName] = useState("MCP client"),
    [token, setToken] = useState(""),
    [selected, setSelected] = useState([scopes[0]!]),
    [keys, setKeys] = useState<{ id: string; name: string; prefix: string }[]>([]);
  const load = async () => {
    const [s, a, k] = await Promise.all([
      api<{ servers: Connection[] }>("GET", "/mcp/servers"),
      api<{ agents: { id: string; name: string }[] }>("GET", "/agents"),
      api<{ keys: { id: string; name: string; prefix: string }[] }>("GET", "/settings/api-keys"),
    ]);
    setServers(s.servers);
    setAgents(a.agents);
    setAgentId((id) => id || a.agents[0]?.id || "");
    setKeys(k.keys);
  };
  useEffect(() => {
    void load().catch(() => setError(c("failed")));
  }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch {
      setError(c("failed"));
    } finally {
      setBusy(false);
    }
  };
  const inspect = async (id: string, approve = false) => {
    const data = await api<Review>("POST", `/mcp/servers/${id}/review`, {
      agentId,
      ...(approve ? { approveHash: review?.data.hash, policies } : {}),
    });
    setReview({ id, data });
    if (!approve)
      setPolicies(
        Object.fromEntries(
          data.tools.map((x) => [
            x.name,
            data.policies[x.name] ?? { effect: "ask", kind: "write", costUsd: 0 },
          ]),
        ),
      );
  };
  return (
    <section className="settings-card flex flex-col gap-4" aria-labelledby="connections-title">
      <h3 id="connections-title" className="text-xl font-bold">
        {c("title")}
      </h3>
      <p className="text-sm text-muted">{c("help")}</p>
      {error && <p role="alert">{error}</p>}
      <label>
        {c("agent")}
        <select
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setReview(null);
          }}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {servers.length === 0 && <p className="text-muted">{c("empty")}</p>}
      {servers.map((s) => (
        <article key={s.id} className="rounded-xl border border-line p-3">
          <strong>{s.name}</strong>
          <p className="break-all text-xs text-muted">{s.config.url ?? s.config.command}</p>
          <div className="mt-2 flex gap-2">
            <button disabled={busy || !agentId} onClick={() => void act(() => inspect(s.id))}>
              {c("review")}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api("DELETE", `/mcp/servers/${s.id}`);
                  setReview(null);
                  await load();
                })
              }
            >
              {c("remove")}
            </button>
          </div>
          {review?.id === s.id && (
            <div className="mt-3 flex flex-col gap-3">
              <p role="status">
                {review.data.approved ? c("approved") : c("changed")} · {review.data.version}
              </p>
              <p>
                {c("scan")}:{" "}
                {review.data.scan.ok
                  ? c("clear")
                  : review.data.scan.findings.map((f) => f.detail).join("; ")}
              </p>
              {review.data.tools.map((tool) => (
                <fieldset key={tool.name} className="rounded-lg border border-line p-2">
                  <legend className="font-bold">{tool.name}</legend>
                  <p className="text-sm">{tool.description}</p>
                  <details>
                    <summary>{c("review")}</summary>
                    <pre className="overflow-auto text-xs">
                      {JSON.stringify(tool.inputSchema, null, 2)}
                    </pre>
                  </details>
                  <div className="flex flex-wrap gap-2">
                    <label>
                      {c("scopes")}
                      <select
                        value={policies[tool.name]?.effect}
                        onChange={(e) =>
                          setPolicies({
                            ...policies,
                            [tool.name]: { ...policies[tool.name]!, effect: e.target.value },
                          })
                        }
                      >
                        {["allow", "ask", "block"].map((v) => (
                          <option key={v} value={v}>
                            {c(v)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {c("kind")}
                      <select
                        value={policies[tool.name]?.kind}
                        onChange={(e) =>
                          setPolicies({
                            ...policies,
                            [tool.name]: { ...policies[tool.name]!, kind: e.target.value },
                          })
                        }
                      >
                        {["read", "write", "send", "spend", "delete", "login"].map((v) => (
                          <option key={v} value={v}>
                            {c(v)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {c("cost")}
                      <input
                        type="number"
                        min="0"
                        step="0.001"
                        value={policies[tool.name]?.costUsd ?? 0}
                        onChange={(e) =>
                          setPolicies({
                            ...policies,
                            [tool.name]: {
                              ...policies[tool.name]!,
                              costUsd: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                </fieldset>
              ))}
              <button
                className="btn-primary"
                disabled={busy || !review.data.scan.ok}
                onClick={() => void act(() => inspect(s.id, true))}
              >
                {c("approve")}
              </button>
            </div>
          )}
        </article>
      ))}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api("POST", "/mcp/servers", {
              name,
              config:
                transport === "http"
                  ? { transport, url, tokenSecret: secret || null }
                  : { transport, command, args: JSON.parse(args) },
            });
            setName("");
            await load();
          });
        }}
      >
        <label>
          {c("name")}
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {c("transport")}
          <select value={transport} onChange={(e) => setTransport(e.target.value)}>
            <option value="http">HTTP</option>
            <option value="stdio">stdio</option>
          </select>
        </label>
        {transport === "http" ? (
          <>
            <label>
              {c("url")}
              <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label>
              {c("secret")}
              <input value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <label>
              {c("command")}
              <input required value={command} onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label>
              {c("args")}
              <input required value={args} onChange={(e) => setArgs(e.target.value)} />
            </label>
          </>
        )}
        <button disabled={busy} type="submit">
          {c("add")}
        </button>
      </form>
      <hr className="border-line" />
      <h3 className="font-bold">{c("token")}</h3>
      <p className="text-sm text-muted">{c("tokenHelp")}</p>
      <label>
        {c("tokenName")}
        <input value={tokenName} onChange={(e) => setTokenName(e.target.value)} />
      </label>
      <fieldset>
        <legend>{c("scopes")}</legend>
        {scopes.map((scope) => (
          <label key={scope} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.includes(scope)}
              onChange={(e) =>
                setSelected(
                  e.target.checked ? [...selected, scope] : selected.filter((x) => x !== scope),
                )
              }
            />
            {scope}
          </label>
        ))}
      </fieldset>
      <button
        disabled={busy || !selected.length || !tokenName.trim()}
        onClick={() =>
          void act(async () => {
            const r = await api<{ key: string }>("POST", "/settings/api-keys", {
              name: tokenName,
              scopes: selected,
            });
            setToken(r.key);
            await load();
          })
        }
      >
        {c("tokenCreate")}
      </button>
      {token && <output className="break-all rounded-lg border border-line p-3">{token}</output>}
      {keys.map((k) => (
        <div key={k.id} className="flex items-center justify-between gap-3">
          <span>
            {k.name} · {k.prefix}…
          </span>
          <button
            onClick={() =>
              void act(async () => {
                await api("DELETE", `/settings/api-keys/${k.id}`);
                setToken("");
                await load();
              })
            }
          >
            {c("tokenRevoke")}
          </button>
        </div>
      ))}
    </section>
  );
}
