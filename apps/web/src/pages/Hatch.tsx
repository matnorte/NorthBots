import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { freeLook, lookKey, type Avatar } from "@northbot/shared";
import { api, ApiError } from "../api.js";
import { AgentAvatar } from "../components/AgentAvatar.js";
import { LookPicker, type TakenLook } from "../components/LookPicker.js";
import { useSession } from "../store/session.js";

type Step = "egg" | "goal" | "look" | "snacks" | "warmup" | "hatching" | "names" | "first_task";
interface Candidate {
  name: string;
  reason: string;
}
interface Personality {
  tone: "warm" | "playful" | "calm" | "precise";
  pace: "careful" | "balanced" | "quick";
  checkins: "often" | "sometimes" | "rarely";
  extra: string[];
}

const GOALS = ["store", "research", "inbox", "content"] as const;
const TEAM_ROLES: Record<(typeof GOALS)[number], string[]> = {
  store: ["product scout", "listing writer", "customer helper"],
  research: ["source finder", "note taker", "summary writer"],
  inbox: ["sorter", "reply drafter"],
  content: ["idea finder", "writer", "editor"],
};
const SNACKS = [
  { key: "tone", options: ["warm", "playful", "calm", "precise"] },
  { key: "pace", options: ["careful", "balanced", "quick"] },
  { key: "checkins", options: ["often", "sometimes", "rarely"] },
  { key: "extra", options: ["puns", "tidy_notes", "early_bird"] },
] as const;

const button = "rounded-blob px-4 py-3 font-bold shadow-soft transition-transform ease-squish active:scale-95";

/** Hatching: the full first-run flow, or a short version (`short`) for later agents. */
export function Hatch({ short = false }: { short?: boolean }) {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [step, setStep] = useState<Step>(short ? "goal" : "egg");
  const [goal, setGoal] = useState("");
  const [goalCard, setGoalCard] = useState<(typeof GOALS)[number] | null>(null);
  const [avatar, setAvatar] = useState<Avatar>({ shape: "circle", color: "coral" });
  const [taken, setTaken] = useState<TakenLook[]>([]);
  const lookTaken = taken.some((x) => lookKey(x.avatar) === lookKey(avatar));

  // Start on a look nobody has yet.
  useEffect(() => {
    void api<{ agents: { name: string; avatar: Avatar }[] }>("GET", "/agents").then((r) => {
      const list = r.agents.map((a) => ({ name: a.name, avatar: a.avatar }));
      setTaken(list);
      setAvatar(freeLook(list.map((x) => x.avatar)));
    });
  }, []);
  const [personality, setPersonality] = useState<Personality>({ tone: "warm", pace: "balanced", checkins: "sometimes", extra: [] });
  const [snack, setSnack] = useState(0);
  const [taps, setTaps] = useState(0);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [own, setOwn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [hello, setHello] = useState<string | null>(null);
  const [team, setTeam] = useState(false);

  const current = SNACKS[snack];

  const fetchNames = async (avoid: string[] = []) => {
    setCandidates(null);
    const r = await api<{ candidates: Candidate[] }>("POST", "/hatch/names", { goal, personality, avatar, avoid });
    setCandidates(r.candidates);
  };

  useEffect(() => {
    if (step !== "hatching") return;
    const timer = setTimeout(() => setStep("names"), 900);
    void fetchNames();
    return () => clearTimeout(timer);
  }, [step]);

  const hatch = async (name: string, by: "agent" | "human") => {
    setError(null);
    try {
      const r = await api<{ agent: { name: string }; firstTaskId: string }>("POST", "/hatch", { goal, personality, avatar, name, nameChosenBy: by });
      setAgentName(r.agent.name);
      setStep("first_task");
      const end = Date.now() + 60_000;
      while (Date.now() < end) {
        const task = await api<{ status: string; report: { finalText?: string } | null; error: string | null }>("GET", `/tasks/${r.firstTaskId}`);
        if (task.status === "done") return setHello(task.report?.finalText ?? t("hatch.helloFallback"));
        if (["failed", "blocked", "killed"].includes(task.status)) return setHello(t("hatch.helloFallback"));
        await new Promise((res) => setTimeout(res, 800));
      }
      setHello(t("hatch.helloFallback"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hatch.failed"));
    }
  };

  const hatchTeam = async () => {
    if (!goalCard) return;
    await api("POST", "/hatch/team", { goal, roles: TEAM_ROLES[goalCard], avatar: {} });
    go({ name: "agents" });
  };

  const chooseGoal = (card: (typeof GOALS)[number]) => {
    setGoalCard(card);
    setGoal(t(`hatch.goals.${card}.goal`));
  };

  const submitOwn = (e: FormEvent) => {
    e.preventDefault();
    void hatch(own.trim(), "human");
  };

  const egg = (
    <div className={`mx-auto h-40 w-32 rounded-[50%_50%_46%_46%/60%_60%_40%_40%] shadow-soft rainbow-border ${taps > 0 ? "nb-wobble" : ""}`} key={taps} aria-hidden="true">
      <div className="mx-auto mt-10 h-6 w-16 rounded-full bg-peach/60" />
    </div>
  );

  return (
    <section className="mx-auto flex max-w-2xl flex-col items-center gap-5 text-center" aria-live="polite">
      {step === "egg" && (
        <>
          {egg}
          <h2 className="text-2xl font-extrabold">{t("hatch.eggTitle")}</h2>
          <p>{t("hatch.eggText")}</p>
          <button type="button" className={`${button} bg-rainbow`} onClick={() => setStep("goal")}>
            {t("hatch.start")}
          </button>
          <button type="button" className="underline" onClick={() => go({ name: "quick" })}>
            {t("hatch.quick")}
          </button>
        </>
      )}

      {step === "goal" && (
        <>
          <h2 className="text-2xl font-extrabold">{t("hatch.goalTitle")}</h2>
          <div className="grid w-full gap-3 sm:grid-cols-2">
            {GOALS.map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={goalCard === g}
                onClick={() => chooseGoal(g)}
                className={`${button} text-left ${goalCard === g ? "bg-rainbow" : "bg-mint"}`}
              >
                <span className="block text-lg">{t(`hatch.goals.${g}.title`)}</span>
                <span className="text-sm font-normal">{t(`hatch.goals.${g}.goal`)}</span>
              </button>
            ))}
          </div>
          <label className="flex w-full flex-col gap-1 text-left">
            {t("hatch.ownGoal")}
            <input className="rounded-blob border border-line px-3 py-2 text-ink" value={goal} onChange={(e) => (setGoal(e.target.value), setGoalCard(null))} />
          </label>
          {short && goalCard && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={team} onChange={(e) => setTeam(e.target.checked)} />
              {t("hatch.team", { roles: TEAM_ROLES[goalCard].join(", ") })}
            </label>
          )}
          <button
            type="button"
            disabled={goal.trim().length < 3}
            className={`${button} bg-rainbow disabled:opacity-50`}
            onClick={() => (team ? void hatchTeam() : setStep("look"))}
          >
            {team ? t("hatch.hatchTeam") : t("hatch.next")}
          </button>
        </>
      )}

      {step === "look" && (
        <>
          <h2 className="text-2xl font-extrabold">{t("hatch.lookTitle")}</h2>
          <AgentAvatar avatar={avatar} mood="proud" size={140} />
          <LookPicker value={avatar} onChange={setAvatar} taken={taken} />
          <button
            type="button"
            disabled={lookTaken}
            className={`${button} bg-rainbow disabled:opacity-50`}
            onClick={() => setStep(short ? "hatching" : "snacks")}
          >
            {t("hatch.next")}
          </button>
        </>
      )}

      {step === "snacks" && current && (
        <>
          <p className="text-sm">{t("hatch.snackCount", { n: snack + 1, total: SNACKS.length })}</p>
          <h2 className="text-2xl font-extrabold">{t(`hatch.snacks.${current.key}.q`)}</h2>
          <div className="grid w-full gap-3 sm:grid-cols-2">
            {current.options.map((o) => (
              <button
                key={o}
                type="button"
                className={`${button} bg-sky`}
                onClick={() => {
                  const key = current.key;
                  if (key === "extra") setPersonality({ ...personality, extra: [t(`hatch.snacks.extra.${o}`)] });
                  else if (key) setPersonality({ ...personality, [key]: o });
                  if (snack + 1 < SNACKS.length) setSnack(snack + 1);
                  else setStep("warmup");
                }}
              >
                {t(`hatch.snacks.${current.key}.${o}`)}
              </button>
            ))}
          </div>
        </>
      )}

      {step === "warmup" && (
        <>
          <h2 className="text-2xl font-extrabold">{t("hatch.warmTitle")}</h2>
          <button
            type="button"
            aria-label={t("hatch.tapEgg", { left: 3 - taps })}
            onClick={() => {
              const n = taps + 1;
              setTaps(n);
              if (n >= 3) setStep("hatching");
            }}
          >
            {egg}
          </button>
          <p>{t("hatch.tapEgg", { left: 3 - taps })}</p>
        </>
      )}

      {step === "hatching" && (
        <div className="nb-hatch" role="status">
          {egg}
          <p className="mt-3 font-bold">{t("hatch.hatching")}</p>
        </div>
      )}

      {step === "names" && (
        <>
          <div className="nb-pop">
            <AgentAvatar avatar={avatar} mood="proud" size={140} />
          </div>
          <h2 className="text-2xl font-extrabold">{t("hatch.namesTitle")}</h2>
          {!candidates && <p role="status">{t("hatch.thinking")}</p>}
          <div className="grid w-full gap-3">
            {candidates?.map((c) => (
              <button key={c.name} type="button" className={`${button} bg-mint text-left`} onClick={() => void hatch(c.name, "agent")}>
                <span className="block text-xl">{c.name}</span>
                <span className="text-sm font-normal">{c.reason}</span>
              </button>
            ))}
          </div>
          {candidates && (
            <button type="button" className="underline" onClick={() => void fetchNames(candidates.map((c) => c.name))}>
              {t("hatch.reroll")}
            </button>
          )}
          <form onSubmit={submitOwn} className="flex w-full gap-2">
            <input
              className="flex-1 rounded-blob border border-line px-3 py-2 text-ink"
              value={own}
              onChange={(e) => setOwn(e.target.value)}
              placeholder={t("hatch.ownName")}
              aria-label={t("hatch.ownName")}
              minLength={2}
              maxLength={12}
            />
            <button className={`${button} bg-peach`} disabled={own.trim().length < 2}>
              {t("hatch.useName")}
            </button>
          </form>
          {error && <p role="alert" className="text-accent">{error}</p>}
        </>
      )}

      {step === "first_task" && (
        <>
          <AgentAvatar avatar={avatar} mood={hello ? "proud" : "content"} name={agentName} size={140} />
          <h2 className="text-2xl font-extrabold">{t("hatch.meet", { name: agentName })}</h2>
          <p role="status" className="rounded-blob bg-panel p-4 shadow-soft" data-testid="first-task">
            {hello ?? t("hatch.sayingHello")}
          </p>
          {hello && (
            <button type="button" className={`${button} bg-rainbow`} onClick={() => go({ name: "agents" })}>
              {t("hatch.toDesk")}
            </button>
          )}
        </>
      )}
    </section>
  );
}
