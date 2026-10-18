import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { wsUrl } from "../api.js";

/** Live browser screencast. "Take over" lets a human click and type in the agent's browser. */
export function Screen({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [frame, setFrame] = useState<string | null>(null);
  const [control, setControl] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const size = useRef({ width: 1280, height: 800 });

  useEffect(() => {
    const socket = new WebSocket(wsUrl(`/agents/${agentId}/screen`));
    ws.current = socket;
    socket.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { type: string; data?: string; metadata?: { deviceWidth?: number; deviceHeight?: number } };
      if (msg.type !== "frame" || !msg.data) return;
      setFrame(`data:image/jpeg;base64,${msg.data}`);
      if (msg.metadata?.deviceWidth) size.current = { width: msg.metadata.deviceWidth, height: msg.metadata.deviceHeight ?? 800 };
    };
    return () => socket.close();
  }, [agentId]);

  const send = (msg: object) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(msg));

  const toggle = () => {
    send({ type: control ? "release" : "takeover" });
    setControl(!control);
  };

  const click = (e: MouseEvent<HTMLImageElement>) => {
    if (!control) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * size.current.width;
    const y = ((e.clientY - r.top) / r.height) * size.current.height;
    send({ type: "mouse", event: "mousePressed", x, y });
    send({ type: "mouse", event: "mouseReleased", x, y });
  };

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={t("computer.browser")}>
      <div className="flex items-center justify-between">
        <h3 className="font-bold">{t("computer.browser")}</h3>
        <button
          type="button"
          onClick={toggle}
          className={`rounded-blob px-4 py-2 font-bold shadow-soft transition-transform ease-squish active:scale-95 ${control ? "bg-rainbow" : "bg-peach"}`}
        >
          {control ? t("computer.giveBack") : t("computer.takeOver")}
        </button>
      </div>
      {control && (
        <input
          className="rounded-blob border border-line px-3 py-2"
          placeholder={t("computer.typeHere")}
          aria-label={t("computer.typeHere")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              send({ type: "key", text: e.currentTarget.value });
              e.currentTarget.value = "";
            }
          }}
        />
      )}
      {frame ? (
        <img
          src={frame}
          alt={t("computer.screenAlt")}
          onClick={click}
          className={`w-full rounded-blob shadow-soft ${control ? "cursor-crosshair ring-4 ring-accent" : ""}`}
        />
      ) : (
        <p className="rounded-blob bg-sky p-6 text-center">{t("computer.waitingForScreen")}</p>
      )}
    </section>
  );
}
