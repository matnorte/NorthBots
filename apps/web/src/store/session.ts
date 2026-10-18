import { create } from "zustand";
import { api, ApiError } from "../api.js";

export interface Me {
  userId: string;
  workspaceId: string;
  email: string;
}

export type View =
  | { name: "agents" | "approvals" | "memory" | "skills" | "settings" | "hatch" | "hatch_short" | "quick" }
  | { name: "computer" | "chat"; agentId: string };

interface SessionState {
  me: Me | null;
  loading: boolean;
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
  view: { name: "agents" },
  async load() {
    try {
      set({ me: await api<Me>("GET", "/auth/me"), loading: false });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      set({ me: null, loading: false });
    }
  },
  async login(email, password) {
    set({ me: await api<Me>("POST", "/auth/login", { email, password }) });
  },
  async signup(email, password) {
    set({ me: await api<Me>("POST", "/auth/signup", { email, password }) });
  },
  async logout() {
    await api("POST", "/auth/logout");
    set({ me: null, view: { name: "agents" } });
  },
  go(view) {
    set({ view });
  },
}));
