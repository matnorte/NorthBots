import { z } from "zod";

/** Development-only master key. The server warns loudly when it is in use. */
export const DEV_MASTER_KEY = "ZGV2LW9ubHktbm9ydGhib3QtbWFzdGVyLWtleS0zMmI=";

const Env = z.object({
  DATABASE_URL: z.string().default("postgres://northbot:northbot@localhost:5432/northbot"),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** base64 of 32 random bytes: `openssl rand -base64 32`. */
  NORTHBOT_MASTER_KEY: z.string().default(DEV_MASTER_KEY),
  /** WebAuthn relying party id (the bare domain) and the origin the browser uses. */
  RP_ID: z.string().default("localhost"),
  WEB_ORIGIN: z.string().default("http://localhost:8080"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 14),
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  /** "docker" runs real agent computers; "fake" is an in-memory stand-in for tests and demos. */
  SANDBOX_DRIVER: z.enum(["docker", "fake"]).default("docker"),
  SANDBOX_IMAGE: z.string().default("northbot/agent:dev"),
  /** The egress proxy container (joins each agent network) and how agents reach it. */
  EGRESS_CONTAINER: z.string().default("northbot-egress-1"),
  EGRESS_HOST: z.string().default("egress"),
  EGRESS_PORT: z.coerce.number().int().default(3128),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}

export const VERSION = "0.0.0";
