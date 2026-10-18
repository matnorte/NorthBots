# Troubleshooting and FAQ

## The workspace will not open

Run `docker compose ps` and check that PostgreSQL and the server are healthy. Read `docker compose logs --tail=100 server web postgres`. The normal development workspace is `http://localhost:8080`; port 3000 serves the API. A failed database startup often indicates a port conflict, disk pressure or an unavailable Docker daemon.

On Windows, confirm Docker Desktop uses Linux containers and run shell scripts in Git Bash. Confirm `node --version`, `pnpm --version` (9.x) and `docker compose version` before investigating the app.

## Agents answer with no provider/model available

The UI can start without model credentials. Useful model work needs a configured provider, valid model ID and aliases. Provider keys belong in the encrypted vault, not a Compose variable named after the cloud API key. Router setup currently uses the authenticated API; see [Models and API](Models-and-API.md).

Bundled provider/model defaults are configuration examples. Confirm the models your account supports and update aliases. Do not increase retries to compensate for invalid credentials or a nonexistent model.

## A local model works on my host but not in NorthBot

The model request originates from the server container. Its `localhost` is different from your host's. Configure a reachable host address, endpoint listening policy and any required Docker host-gateway mapping. Verify the provider's OpenAI-compatible base URL. Do not classify a remote third-party service as local to get around sensitive-data restrictions.

## An agent waits indefinitely

Inspect the task's reason, **Approvals**, grants, budget, computer status and any human handoff. A sensitive task needs a local provider and permitted destinations. A schedule may be paused for first review or repeated failure. Read the state before retrying from Operations.

## Compose says Bake is enabled but Buildx is missing

This warning means Docker Compose found no working Buildx CLI plugin. Bake is provided by Buildx; the warning alone does not establish whether the build failed. NorthBot's installer now checks both Compose and Buildx before copying files or building images, installs missing plugins from the existing Docker package family and verifies that both commands work.

Update the checkout with `git pull --ff-only` and repeat your original installer command. An existing `.env` and its keys are preserved. To repair an Ubuntu `docker.io` installation directly:

```bash
sudo apt-get update
sudo apt-get install -y docker-buildx
docker buildx version
```

For Docker CE installed from Docker's official apt repository, the package is `docker-buildx-plugin` instead. Keep plugins in the same package family; do not install a second Docker engine just to resolve this warning. If installation reports success but `docker buildx version` still fails, check Docker's CLI plugin paths/configuration before retrying.

## A browser or computer fails to start

Build `northbot/agent:dev` with `docker compose --profile images build agent-image`. Check Docker storage/memory and whether `SANDBOX_SUBNET_POOL` overlaps your network. Agent egress uses a separate proxy joined to agent networks; an isolated computer without that attachment cannot contact allowed sites. Review lifecycle/update logs before changing network policy.

## Acceptance is slow or Docker reports resource errors

Full acceptance includes repeated package tests, real browser/agent computers, deployment recovery and Docker-in-Docker. Inspect resource use and old test computers. Stop/remove disposable test agents through their lifecycle controls as appropriate. If the development database is disposable, `docker compose down -v` intentionally resets it; preserve wanted data first. Re-run the failing milestone after fixing the cause, then the full sequence. Never remove assertions or silently skip a milestone.

## A routine did not run when expected

Check its timezone preview, pause/approval state, overlap/catch-up policy, budget and last errors. Editing a prompt or skill invalidates approval. Three failures pause a routine. Verify scheduler canaries and the occurrence/task history before creating a duplicate schedule.

## An MCP tool stopped working after an update

Description, schema or version changes require re-review. Check the selected agent's independent assignment and policy. Stdio runs inside the agent computer, so a host-installed executable alone is insufficient. HTTP credentials are vault names with appropriate grants. Fake OAuth routes are not real third-party authorization.

## The companion disconnected after I changed sharing

That is expected. Local share/power changes invalidate the live session. Review the new settings and run the companion again. Verify agent assignment and kill/take-back state. Use HTTPS for a non-loopback API, and validate real desktop behavior on a spare machine first.

## A backup restored, but secrets cannot be read

The original `NORTHBOT_MASTER_KEY` is required. Keep its protected recovery copy with the backup plan. Do not generate a replacement key and expect it to decrypt previous data. Agent home volumes also need their own export/backup and, when encrypted, their original identity/key context.

## Is it free, offline or production-ready?

The repository is MIT-licensed and self-hosted. You pay for your infrastructure and any model/external-service usage. Local models are supported, but not every feature is offline: cloud providers and store/MCP services need their own connectivity. All milestones pass recorded local acceptance; outstanding real-machine/account/deployment checks remain in [BLOCKERS.md](../../BLOCKERS.md). Assess those limits for your use case.

## Does the office change permissions?

Cosmetic interactions do not authorize spending or credential access. Lift/drop can affect task pause/resume, but actual work remains subject to the runtime controls. The accessible list is available when you prefer a plain view.

## Where should I ask for help?

Use the repository's issue templates for reproducible bugs or feature requests and Discussions for general questions if enabled. Include version/commit, OS, exact steps and redacted logs. Report vulnerabilities privately via [SECURITY.md](../../SECURITY.md), not in a public issue.
