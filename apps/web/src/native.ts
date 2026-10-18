/**
 * Glue for the NorthBot Android app (apps/android), which opens this web app from your server.
 * In a normal browser window.Capacitor is missing and nothing here runs.
 */
import { useSession, type View } from "./store/session.js";

interface CapacitorBridge {
  getPlatform(): string;
  addListener(plugin: string, event: string, callback: (data: Record<string, unknown>) => void): unknown;
  nativePromise<T>(plugin: string, method: string, options?: object): Promise<T>;
}

const OPENABLE = ["approvals", "letters", "agents", "office"] as const;

export function installNativeShell(): void {
  const cap = (window as { Capacitor?: CapacitorBridge }).Capacitor;
  if (!cap || cap.getPlatform() !== "android") return;
  document.documentElement.classList.add("native-app");

  // Pages live in app state, not the URL, so the hardware back button walks this history instead.
  const history: View[] = [];
  let goingBack = false;
  useSession.subscribe((state, prev) => {
    if (state.view === prev.view) return;
    if (goingBack) goingBack = false;
    else history.push(prev.view);
    if (history.length > 50) history.shift();
    if (!state.me) history.length = 0;
  });
  cap.addListener("App", "backButton", () => {
    const { view, go } = useSession.getState();
    const prev = history.pop();
    if (prev) {
      goingBack = true;
      go(prev);
    } else if (view.name !== "agents") {
      goingBack = true;
      go({ name: "agents" });
    } else {
      void cap.nativePromise("App", "minimizeApp");
    }
  });

  // A tapped phone notification opens its page (approvals, letters).
  const open = (name: unknown) => {
    if (OPENABLE.includes(name as (typeof OPENABLE)[number])) useSession.getState().go({ name } as View);
  };
  cap.addListener("NorthBotShell", "openView", (data) => open(data.view));
  void cap
    .nativePromise<{ view?: string }>("NorthBotShell", "takeLaunchView")
    .then((r) => open(r.view))
    .catch(() => {});
}
