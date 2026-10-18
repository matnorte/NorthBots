import type { preHandlerAsyncHookHandler } from "fastify";
import type { ApiKeyStore } from "./apikeys/store.js";
import type { SessionStore } from "./auth/sessions.js";
import type { ComputerManager } from "./computer/manager.js";
import type { Config } from "./config.js";
import type { DbHandle } from "./db/client.js";
import type { EventLog } from "./events/log.js";
import type { LlmService } from "./llm/service.js";
import type { Vault } from "./vault/vault.js";

/** Everything route plugins need, built once in buildApp. */
export interface Services {
  config: Config;
  db: DbHandle;
  events: EventLog;
  sessions: SessionStore;
  vault: Vault;
  apiKeys: ApiKeyStore;
  llm: LlmService;
  computers: ComputerManager;
  auth: preHandlerAsyncHookHandler;
}
