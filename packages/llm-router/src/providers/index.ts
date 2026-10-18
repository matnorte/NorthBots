import { FakeConfig, type ProviderConfig } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { FakeProvider } from "./fake.js";
import { GoogleProvider } from "./google.js";
import { OpenAIProvider } from "./openai.js";
import type { Provider } from "./provider.js";

export function createProvider(c: ProviderConfig): Provider {
  switch (c.type) {
    case "openai":
      return new OpenAIProvider(c.name, c.kind, c.baseUrl, true);
    case "openai-compatible":
      return new OpenAIProvider(c.name, c.kind, c.baseUrl, false);
    case "anthropic":
      return new AnthropicProvider(c.name, c.kind, c.baseUrl, c.serverFallbacks);
    case "google":
      return new GoogleProvider(c.name, c.kind, c.baseUrl);
    case "fake":
      return new FakeProvider(c.name, c.kind, c.fake ?? FakeConfig.parse({}));
  }
}

export { AnthropicProvider, FakeProvider, GoogleProvider, OpenAIProvider };
export type { CallOptions, Provider } from "./provider.js";
