import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { wsUrl } from "../api.js";

/** The agent's real shell, live. Typing here goes into the same shell the agent uses. */
export function Terminal({ agentId, label }: { agentId: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const term = new XTerm({
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#2b2640", foreground: "#fff8ef", cursor: "#ff7a59" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    const ws = new WebSocket(wsUrl(`/agents/${agentId}/terminal`));
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { type: string; data?: string };
      if (msg.type === "data" && msg.data) term.write(msg.data);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    const sub = term.onData((data) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: "input", data })));
    const onResize = () => {
      fit.fit();
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      sub.dispose();
      ws.close();
      term.dispose();
    };
  }, [agentId]);

  return <div ref={host} role="region" aria-label={label} className="h-80 w-full overflow-hidden rounded-blob bg-[#2b2640] p-2 shadow-soft" />;
}
