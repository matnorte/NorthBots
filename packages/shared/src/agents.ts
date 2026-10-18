import { z } from "zod";
import { Avatar } from "./avatar.js";

export const AUTONOMY_LEVELS = ["suggest_only", "ask_first", "act_within_limits", "autonomous"] as const;
export const AGENT_STATUSES = ["working", "waiting", "resting", "blocked", "idle"] as const;

export const AgentName = z
  .string()
  .trim()
  .min(2)
  .max(12)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u, "letters, numbers, spaces, ' and - only");

export const CreateAgentBody = z.object({
  name: AgentName,
  /** Optional: without it the agent gets a free look (shape + colour) automatically. */
  avatar: Avatar.optional(),
  persona: z.record(z.unknown()).default({}),
  modelPolicy: z.record(z.unknown()).default({ model: "northbot-smart", planner: "northbot-fast", verifier: "northbot-fast" }),
  autonomyLevel: z.enum(AUTONOMY_LEVELS).default("ask_first"),
  budgetDailyUsd: z.number().positive().max(10_000).default(1),
});

export const AgentInfo = z.object({
  id: z.string().uuid(),
  name: z.string(),
  nameLocked: z.boolean(),
  avatar: z.object({ shape: z.string(), color: z.string() }),
  persona: z.record(z.unknown()),
  modelPolicy: z.record(z.unknown()),
  autonomyLevel: z.enum(AUTONOMY_LEVELS),
  budgetDailyUsd: z.number(),
  status: z.enum(AGENT_STATUSES),
  mood: z.string(),
  sandboxId: z.string().nullable(),
  createdAt: z.string(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const ExecBody = z.object({
  command: z.string().min(1).max(10_000),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
});

export const ExecReply = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  durationMs: z.number().int(),
  truncated: z.boolean(),
});

const PageId = z.string().optional();
export const BrowserActionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: z.string().min(1).max(4096), pageId: PageId }),
  z.object({ action: z.literal("click"), selector: z.string().min(1), pageId: PageId }),
  z.object({ action: z.literal("fill"), selector: z.string().min(1), text: z.string(), pageId: PageId }),
  z.object({ action: z.literal("press"), key: z.string().min(1), pageId: PageId }),
  z.object({ action: z.literal("read"), selector: z.string().optional(), pageId: PageId }),
  z.object({ action: z.literal("screenshot"), pageId: PageId }),
  z.object({ action: z.enum(["back", "forward", "reload"]), pageId: PageId }),
  z.object({ action: z.literal("scroll"), dy: z.number().optional(), pageId: PageId }),
]);

export const BrowserReply = z.object({
  pageId: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  status: z.number().nullable().optional(),
  text: z.string().optional(),
  truncated: z.boolean().optional(),
  png: z.string().optional(),
});

export const TabsReply = z.object({
  pages: z.array(z.object({ pageId: z.string(), url: z.string(), title: z.string() })),
  activePageId: z.string().nullable(),
});
