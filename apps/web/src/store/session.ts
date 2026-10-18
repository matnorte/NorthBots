import { create } from "zustand";
import { api, ApiError } from "../api.js";

export interface Me {
  userId: string;
  workspaceId: string;
  email: string;
}

export type View =
  | { name: "schedules" | "security" }
  | { name: "agents" | "office" | "approvals" | "rooms" | "letters" | "talks" | "ideas" | "memory" | "skills" | "settings" | "hatch" | "hatch_short" | "quick" }
  | { name: "computer" | "chat"; agentId: string }
  | { name: "room"; roomId: string }
  | { name: "talk"; talkId: string };

interface SessionState {
  me: Me | null;
  loading: boolean;
  loadError: boolean;
  view: View;
  load(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  signup(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  go(view: View): void;
}

export const useSession = create<SessionState>((set) => ({
  me: null,
  loading: true,
  loadError: false,
  view: { name: "agents" },
  async load() {
    try {
      set({ me: await api<Me>("GET", "/auth/me"), loading: false, loadError: false });
    } catch (err) {
      set({ me: null, loading: false, loadError: !(err instanceof ApiError && err.status === 401) });
    }
  },
  async login(email, password) {
    set({ me: await api<Me>("POST", "/auth/login", { email, password }), loadError: false });
  },
  async signup(email, password) {
    set({ me: await api<Me>("POST", "/auth/signup", { email, password }), loadError: false });
  },
  async logout() {
    await api("POST", "/auth/logout");
    set({ me: null, view: { name: "agents" } });
  },
  go(view) {
    set({ view });
  },
}));

