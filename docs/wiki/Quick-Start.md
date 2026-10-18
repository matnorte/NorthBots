# Quick Start

Run NorthBot on your own machine, create an account and explore the workspace. Model calls require a configured provider; the interface and the store simulation can be explored without a paid model account.

## Requirements

| Component       | Requirement                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js         | 22 or newer                                                                                                                             |
| pnpm            | 9; the repository pins 9.15.0                                                                                                           |
| Docker          | Running Docker Engine/Desktop with Compose v2 and Linux containers                                                                      |
| Git             | To clone the source; Windows users also need Git Bash for shell scripts                                                                 |
| Go              | 1.23+ only when building/testing the Windows companion                                                                                  |
| Disk and memory | Enough free capacity for PostgreSQL, browser images and one computer per active agent; there is no published minimum hardware benchmark |

Start with a small team. Full acceptance builds images and runs Docker inside a privileged Ubuntu test container; it needs substantially more resources than browsing the workspace.

## Install locally

```bash
git clone https://github.com/matnorte/NorthBots.git
cd NorthBots
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile
docker compose --profile images build agent-image
docker compose up -d --build
```

On Windows, run these commands in **Git Bash**. Docker Desktop must be running in Linux-container mode. If pnpm 9 is already installed, the two Corepack setup commands are optional.

| Address                                  | Purpose                               |
| ---------------------------------------- | ------------------------------------- |
| `http://localhost:8080`                  | Workspace                             |
| `http://localhost:3000/health`           | API health                            |
| `http://localhost:8080/api/openapi.json` | API description through the web proxy |
| `http://localhost:8080/api/status`       | Public instance status                |

Open the workspace, choose **Create an account**, and set your own email/password (at least 10 characters). Local setup does not create a default admin password. Signup creates a workspace. The server applies database migrations on startup.

## Next steps

1. Set your language and timezone in **Settings**.
2. Follow [Your First Agent](Your-First-Agent.md) to hatch or quickly create an agent.
3. Configure a model with [Models and API](Models-and-API.md), or try the fake-data store simulation in **Operations**.
4. Inspect **Approvals**, **Security** and the agent's budget before starting work.
5. Open **Office** to follow the team, or keep using the plain list and chat views.

## Configuration and stopping

Compose provides development defaults. `.env.example` documents optional settings; copying it is not required for a local trial. The built-in development vault key and database password are unsuitable for a publicly reachable instance. Use the [server installer](Deployment-and-Backups.md) for HTTPS and generated credentials. Local Compose publishes the web, API and database ports by default; keep it on a trusted development machine or set `BIND_ADDR=127.0.0.1` and `WEB_BIND=127.0.0.1` in a private `.env`.

```bash
docker compose ps
docker compose logs --tail=100 server
docker compose stop
docker compose start
```

`stop` retains containers and database data. `docker compose down` removes Compose containers and networks while retaining the database volume. **`docker compose down -v` deletes the development database**; use it only when intentionally resetting disposable data. Agent computers have their own lifecycle, so inspect them separately before assuming the entire team has stopped.

For errors, see [Troubleshooting and FAQ](Troubleshooting-and-FAQ.md).
