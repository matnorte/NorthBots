# Operations

Open **Operations** to see task health, failure rate, model calls/cost, computers and routines. It also exposes canary results, recovery queues, searchable run history, incident reporting and the store-pack demo.

## Health checks

Canaries normally run every ten minutes. They check database access, vault encryption, scheduler lag, stuck tasks and a task that exercises the real runtime with a scripted model at no model-provider cost. A passing scripted canary does not confirm real cloud-provider connectivity.

Use the public status page at `/api/status` or its JSON at `/api/status.json` through the web server. Direct API paths are `/status` and `/status.json`. They expose instance health only, not workspace contents. `/health` is also available on the API and through `/api/health`.

## Recover a failure

1. Find the task or scheduled run and read its event trail/error.
2. Fix the cause: credentials, grants, budget, destination policy, unavailable computer or provider.
3. Retry from the dead-letter queue when the same work should run again, or dismiss it when it is no longer appropriate.
4. Inspect the resulting task/run and external effects before considering recovery complete.

Retry/dismiss operations use cross-process locks. Stable retry keys prevent duplicate work after interrupted requests. Task retries retain their context, budget, deadline and untrusted-input markers. Scheduled retries retain the occurrence identity. These protections do not remove the need for idempotency in external services.

## Incident review

Search run history by the relevant task, agent or time window. Generate an incident report from the event log, then review it before sharing. Use the security audit/export tools when integrity verification is required. Do not attach raw environment files, private backups, cookies, tokens or first-login credentials to a support request.

Canary tokens deliberately alert once. A lack of repeated alerts is not proof a token is unused. Review dashboard state, logs and the specific control involved.

## Useful host checks

```bash
docker compose ps
docker compose logs --tail=100 server egress
docker stats --no-stream
```

Check resource pressure before repeatedly restarting containers. Long-lived agent computers and old test agents consume resources outside the main Compose services. Use each computer's lifecycle controls and preserve data you need; avoid blanket container/network deletion.

Source: [operations service](../../apps/server/src/ops/service.ts), [public status routes](../../apps/server/src/ops/routes.ts).
