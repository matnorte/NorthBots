/** LLM settings with scripted fake models, so e2e runs are deterministic and free. */
export function fakeModels(agentName: string) {
  return {
    providers: [
      {
        name: "fast",
        type: "fake",
        kind: "local",
        models: ["m"],
        fake: {
          reply: "{}",
          match: [
            {
              contains: "choosing your own name",
              text: JSON.stringify({
                candidates: [
                  { name: agentName, reason: "It sounds warm, like fresh bread." },
                  { name: "Nimbus", reason: "I like clouds." },
                  { name: "Juniper", reason: "Calm and green." },
                ],
              }),
            },
            { contains: "You plan work", text: JSON.stringify({ steps: ["look around", "say hello"] }) },
            {
              contains: "You check an agent",
              text: JSON.stringify({ summary: "ok", claims: [{ text: "said hello", status: "verified", evidence: "uname output" }] }),
            },
          ],
        },
      },
      {
        name: "smart",
        type: "fake",
        kind: "local",
        models: ["m"],
        fake: {
          script: [
            { toolCalls: [{ name: "terminal", arguments: { command: "uname -a" } }] },
            { text: "draft" },
            { text: `Hi! I'm ${agentName}. I'll keep your shop tidy and friendly.` },
          ],
          match: [{ contains: "chatting with the person", text: "Hello from chat!" }],
        },
      },
    ],
    aliases: { "northbot-fast": ["fast/m"], "northbot-smart": ["smart/m"] },
    redactPii: false,
    pricing: {},
    dailyBudgetUsd: null,
  };
}
