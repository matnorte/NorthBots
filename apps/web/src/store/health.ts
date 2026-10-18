import { create } from "zustand";

type HealthStatus = "checking" | "ok" | "down";

interface HealthState {
  status: HealthStatus;
  check(): Promise<void>;
}

export const useHealth = create<HealthState>((set) => ({
  status: "checking",
  async check() {
    try {
      const res = await fetch("/api/health");
      set({ status: res.ok ? "ok" : "down" });
    } catch {
      set({ status: "down" });
    }
  },
}));
