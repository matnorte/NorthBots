import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";
import { PageState } from "../components/PageState.js";
import type { Agent } from "./Agents.js";

interface Finding {
  file: string;
  line: number;
  kind: string;
  detail: string;
}

interface DryRun {
  skipped?: boolean;
  reason?: string;
  ok?: boolean;
  exitCode?: number;
  output?: string;
}

interface Version {
  version: number;
  status: string;
  trigger: string;
  rights: string;
  files: Record<string, string>;
  scan: { ok?: boolean; findings?: Finding[] };
  dryRun: DryRun | null;
  diff: string;
  createdBy: string;
  createdAt: string;
}

interface Skill {
  id: string;
  agentId: string | null;
  name: string;
  description: string;
  activeVersion: number | null;
  versions: Version[];
}

function Findings({ scan }: { scan: Version["scan"] }) {
  const { t } = useTranslation();
  const findings = scan.findings ?? [];
  return (
    <div>
      <h4 className="text-sm font-bold">{t("skills.scan")}</h4>
      {findings.length === 0 ? (
        <p className="text-sm text-emerald-300">{t("skills.scanOk")}</p>
      ) : (
        <ul className="text-sm text-accent">
          {findings.map((f, i) => (
            <li key={i}>
              {t(`skills.findings.${f.kind}`, { defaultValue: f.kind })}: {f.file}:{f.line} {f.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DryRunResult({ dry }: { dry: DryRun | null }) {
  const { t } = useTranslation();
  if (!dry) return null;
  return (
    <div>
      <h4 className="text-sm font-bold">{t("skills.dryRun")}</h4>
      {dry.skipped ? (
        <p className="text-sm text-muted">{t("skills.drySkipped", { reason: dry.reason })}</p>
      ) : (
        <>
          <p className={`text-sm ${dry.ok ? "text-emerald-300" : "text-accent"}`}>{t(dry.ok ? "skills.dryOk" : "skills.dryFailed", { code: dry.exitCode })}</p>
          {dry.output && <pre className="max-h-40 overflow-auto rounded-blob bg-cream p-3 text-xs">{dry.output}</pre>}
        </>
      )}
    </div>
  );
}

/** One draft waiting for review: files, diff, scan, test run, rights; approve, edit, or reject. */
function ReviewCard({ skill, draft, agentName, reload, fail }: { skill: Skill; draft: Version; agentName: string | null; reload: () => Promise<void>; fail: (msg: string) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [files, setFiles] = useState(draft.files);

  const decide = async (decision: "approve" | "reject", edited?: Record<string, string>) => {
    try {
      await api("POST", `/skills/${skill.id}/versions/${draft.version}/decide`, { decision, ...(edited ? { files: edited } : {}) });
      setEditing(false);
      await reload();
    } catch (err) {
      fail(err instanceof ApiError ? err.message : t("skills.failed"));
    }
  };

  return (
    <li className="rainbow-border flex flex-col gap-3 rounded-blob bg-panel p-4 shadow-soft" aria-label={skill.name}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-extrabold">
            {skill.name} <span className="text-sm text-muted">{t("skills.version", { n: draft.version })}</span>
          </h3>
          <p className="text-sm">{skill.description}</p>
        </div>
        <div className="flex flex-wrap gap-1 text-xs">
          {agentName && <span className="rounded-blob bg-peach px-2 py-0.5">{agentName}</span>}
          <span className="rounded-blob bg-sky px-2 py-0.5">{t(`skills.triggers.${draft.trigger}`, { defaultValue: draft.trigger })}</span>
          <span className="rounded-blob bg-lilac px-2 py-0.5">{t("skills.rights", { kind: t(`kinds.${draft.rights}`, { defaultValue: draft.rights }) })}</span>
        </div>
      </div>
      <div>
        <h4 className="text-sm font-bold">{t("skills.files")}</h4>
        {Object.entries(files).map(([path, content]) => (
          <div key={path} className="mt-1">
            <p className="font-mono text-xs text-muted">{path}</p>
            {editing ? (
              <textarea
                className="min-h-32 w-full rounded-blob border border-line bg-cream p-3 font-mono text-xs text-ink"
                value={content}
                aria-label={path}
                onChange={(e) => setFiles({ ...files, [path]: e.target.value })}
              />
            ) : (
              <pre className="max-h-60 overflow-auto rounded-blob bg-cream p-3 text-xs">{content}</pre>
            )}
          </div>
        ))}
      </div>
      {draft.diff && (
        <div>
          <h4 className="text-sm font-bold">{t("skills.diff")}</h4>
          <pre className="max-h-40 overflow-auto rounded-blob bg-cream p-3 text-xs">
            {draft.diff.split(String.fromCharCode(10)).map((line, i) => (
              <span key={i} className={line.startsWith("+") ? "text-emerald-300" : line.startsWith("-") ? "text-accent" : ""}>
                {line}
                {String.fromCharCode(10)}
              </span>
            ))}
          </pre>
        </div>
      )}
      <Findings scan={draft.scan} />
      <DryRunResult dry={draft.dryRun} />
      <div className="flex flex-wrap gap-2">
        {editing ? (
          <button type="button" onClick={() => void decide("approve", files)} className="rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft">
            {t("skills.saveApprove")}
          </button>
        ) : (
          <>
            <button type="button" onClick={() => void decide("approve")} className="rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft">
              {t("skills.approve")}
            </button>
            <button type="button" onClick={() => setEditing(true)} className="rounded-blob bg-sky px-4 py-2 font-bold shadow-soft">
              {t("skills.editApprove")}
            </button>
          </>
        )}
        <button type="button" onClick={() => void decide("reject")} className="rounded-blob bg-lilac px-4 py-2 font-bold shadow-soft">
          {t("skills.reject")}
        </button>
      </div>
    </li>
  );
}

/** An approved skill: what it does, its active version, and every version with rollback. */
function SkillCard({ skill, agentName, reload }: { skill: Skill; agentName: string | null; reload: () => Promise<void> }) {
  const { t } = useTranslation();
  const active = skill.versions.find((v) => v.version === skill.activeVersion);
  const rollback = async (version: number) => {
    await api("POST", `/skills/${skill.id}/rollback`, { version });
    await reload();
  };
  return (
    <li className="flex flex-col gap-2 rounded-blob bg-panel p-4 shadow-soft">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-extrabold">
          {skill.name} <span className="text-sm text-muted">{t("skills.version", { n: skill.activeVersion })}</span>
        </h3>
        <div className="flex gap-1 text-xs">
          {agentName && <span className="rounded-blob bg-peach px-2 py-0.5">{agentName}</span>}
          {active && <span className="rounded-blob bg-lilac px-2 py-0.5">{t("skills.rights", { kind: t(`kinds.${active.rights}`, { defaultValue: active.rights }) })}</span>}
        </div>
      </div>
      <p className="text-sm">{skill.description}</p>
      <details>
        <summary className="cursor-pointer text-sm underline">{t("skills.history")}</summary>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {skill.versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{t("skills.version", { n: v.version })}</span>
              <span className="text-muted">{t(`skills.statuses.${v.status}`, { defaultValue: v.status })}</span>
              <span className="text-muted">{new Date(v.createdAt).toLocaleString()}</span>
              {v.version === skill.activeVersion ? (
                <span className="text-rainbow font-bold">{t("skills.active")}</span>
              ) : (
                v.status === "approved" && (
                  <button type="button" className="underline" onClick={() => void rollback(v.version)}>
                    {t("skills.rollback")}
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

/** Skills: review cards for drafts, and the library of approved skills with versions. */
export function Skills() {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => setSkills((await api<{ skills: Skill[] }>("GET", "/skills")).skills);
  useEffect(() => {
    void api<{ agents: Agent[] }>("GET", "/agents").then((r) => setAgents(r.agents));
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  const names = new Map(agents.map((a) => [a.id, a.name]));
  const nameOf = (s: Skill) => (s.agentId ? (names.get(s.agentId) ?? null) : null);
  const drafts = skills.flatMap((s) => s.versions.filter((v) => v.status === "draft").map((v) => ({ skill: s, draft: v })));
  const library = skills.filter((s) => s.activeVersion !== null);

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-2xl font-extrabold">{t("skills.title")}</h2>
        <p className="text-sm text-muted">{t("skills.intro")}</p>
      </div>
      {error && (
        <p role="alert" className="text-accent">
          {error}
        </p>
      )}
      {skills.length === 0 && <PageState title={t("skills.empty")} description={t("ui.skillsEmptyHelp")} icon="skills" />}
      {drafts.length > 0 && (
        <>
          <h3 className="text-lg font-bold">{t("skills.drafts")}</h3>
          <ul className="flex flex-col gap-3">
            {drafts.map(({ skill, draft }) => (
              <ReviewCard key={`${skill.id}:${draft.version}`} skill={skill} draft={draft} agentName={nameOf(skill)} reload={load} fail={setError} />
            ))}
          </ul>
        </>
      )}
      {library.length > 0 && (
        <>
          <h3 className="text-lg font-bold">{t("skills.library")}</h3>
          <ul className="flex flex-col gap-3">
            {library.map((s) => (
              <SkillCard key={s.id} skill={s} agentName={nameOf(s)} reload={load} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
