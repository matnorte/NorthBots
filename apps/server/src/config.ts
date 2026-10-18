import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().default("postgres://northbot:northbot@localhost:5432/northbot"),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}

export const VERSION = "0.0.0";
