import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";

interface Provider {
  name: string;
  type: "openai" | "anthropic" | "google" | "openai-compatible" | "fake";
  kind: "cloud" | "local";
  baseUrl?: string;
  keySecret?: string;
  models: string[];
  [extra: string]: unknown;
}
interface LlmSettings {
  providers: Provider[];
  aliases: Record<string, string[]>;
  [extra: string]: unknown;
}

const PRESETS = {
  "9router": { name: "9router", baseUrl: "http://host.docker.internal:20128/v1", secret: "NINEROUTER_API_KEY" },
  custom: { name: "my-router", baseUrl: "", secret: "ROUTER_API_KEY" },
} as const;
type Preset = keyof typeof PRESETS;
const ALIASES = ["northbot-smart", "northbot-fast"];

/** Configures an OpenAI-compatible router (9router by default) as the first choice for both aliases. */
export function ModelProvider() {
  const { t } = useTranslation();
  const c = (key: string) => t(`provider.${key}`);
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [preset, setPreset] = useState<Preset>("9router");
  const [name, setName] = useState<string>(PRESETS["9router"].name);
  const [baseUrl, setBaseUrl] = useState<string>(PRESETS["9router"].baseUrl);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [local, setLocal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api<LlmSettings>("GET", "/settings/llm")
      .then((s) => {
        setSettings(s);
        // Show the router already in use, if there is one.
        const first = s.aliases["northbot-smart"]?.[0]?.split("/")[0];
        const p = s.providers.find((x) => x.name === first && x.type === "openai-compatible");
        if (p) {
          setPreset(p.name === "9router" ? "9router" : "custom");
          setName(p.name);
          setBaseUrl(p.baseUrl ?? "");
          setModel(p.models[0] ?? "");
          setLocal(p.kind === "local");
        }
      })
      .catch(() => setError(c("failed")));
  }, []);

  const pick = (p: Preset) => {
    setPreset(p);
    setName(PRESETS[p].name);
    setBaseUrl(PRESETS[p].baseUrl);
  };

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const secret = preset === "9router" ? PRESETS["9router"].secret : `${name.toUpperCase().replace(/-/g, "_")}_API_KEY`;
      const old = settings.providers.find((p) => p.name === name);
      if (key) await api("PUT", "/vault/secrets", { name: secret, value: key });
      const provider: Provider = {
        ...(old ?? {}),
        name,
        type: "openai-compatible",
        kind: local ? "local" : "cloud",
        baseUrl: baseUrl.trim(),
        models: [model.trim()],
        ...(key || old?.keySecret ? { keySecret: key ? secret : old?.keySecret } : {}),
      };
      const target = `${name}/${model.trim()}`;
      const aliases = { ...settings.aliases };
      for (const alias of ALIASES) {
        // The router first; whatever was configured before stays behind it as a fallback.
        aliases[alias] = [target, ...(aliases[alias] ?? []).filter((x) => !x.startsWith(`${name}/`))];
      }
      const next = await api<LlmSettings>("PUT", "/settings/llm", {
        ...settings,
        providers: [...settings.providers.filter((p) => p.name !== name), provider],
        aliases,
      });
      setSettings(next);
      setKey("");
      setNotice(c("saved"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : c("failed"));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return error ? <p role="alert">{error}</p> : null;
  const inUse = settings.aliases["northbot-smart"]?.[0];
  const valid = /^[a-z0-9][a-z0-9-]{0,31}$/.test(name) && /^https?:\/\/.+/.test(baseUrl.trim()) && model.trim().length > 0;

  return (
    <section className="settings-card" aria-labelledby="provider-title">
      <div>
        <h3 id="provider-title" className="text-xl font-bold">
          {c("title")}
        </h3>
        <p className="text-sm text-muted">{c("help")}</p>
        <p className="mt-2 text-sm">
          {c("current")}: <strong>{inUse ?? c("none")}</strong>
        </p>
      </div>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          {c("preset")}
          <select value={preset} onChange={(e) => pick(e.target.value as Preset)}>
            <option value="9router">9router</option>
            <option value="custom">{c("custom")}</option>
          </select>
        </label>
        <label>
          {c("name")}
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} disabled={preset === "9router"} />
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-[#b6b8c2] sm:col-span-2">
          {c("baseUrl")}
          <input className="w-full rounded-lg border border-line bg-[#121318] px-3 py-2 text-sm text-ink" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} inputMode="url" />
          <span className="text-muted">{c("baseUrlHelp")}</span>
        </label>
        <label>
          {c("key")}
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
          <span className="text-muted">{c("keyHelp")}</span>
        </label>
        <label>
          {c("model")}
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="cc/claude-sonnet-4-5" />
          <span className="text-muted">{c("modelHelp")}</span>
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
          {c("local")}
        </label>
        <button type="submit" className="primary-button self-start" disabled={busy || !valid}>
          {c("save")}
        </button>
      </form>
      {notice && <p role="status" className="text-sm text-mint">{notice}</p>}
      {error && <p role="alert" className="text-sm text-accent">{error}</p>}
    </section>
  );
}
