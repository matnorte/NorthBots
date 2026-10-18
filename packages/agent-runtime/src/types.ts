import { z } from "zod";

/** What an action does to the world. Reads are free; everything else goes through permissions. */
export const ACTION_KINDS = ["read", "write", "delete", "send", "spend", "login"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const AUTONOMY_LEVELS = ["suggest_only", "ask_first", "act_within_limits", "autonomous", "full_access"] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export type Decision = "allow" | "ask" | "block";

/** A tool call the model wants to make, after classification. */
export interface ProposedAction {
  tool: string;
  args: Record<string, unknown>;
  kind: ActionKind;
  /** One plain-language line for logs and the approval inbox. */
  summary: string;
  /** Hosts and email addresses the action reaches, used by rules and the shield. */
  targets: string[];
}

export const PermissionRule = z.object({
  id: z.string().optional(),
  effect: z.enum(["allow", "ask", "block"]),
  kinds: z.array(z.enum(ACTION_KINDS)).optional(),
  tools: z.array(z.string()).optional(),
  /** Matches if any target equals or is a subdomain / address at one of these. */
  targets: z.array(z.string()).optional(),
  /** Case-insensitive regex tested against the action summary. */
  pattern: z.string().optional(),
  /** The plain-language rule this was compiled from. */
  description: z.string().default(""),
});
export type PermissionRule = z.infer<typeof PermissionRule>;

export interface PermissionResult {
  decision: Decision;
  reason: string;
  ruleId?: string;
}
