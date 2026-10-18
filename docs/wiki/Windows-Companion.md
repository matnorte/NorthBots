# Windows Companion

The Go companion lets a selected agent use the parts of a Windows computer its owner explicitly shares. It makes an outbound WebSocket connection; you do not open an inbound desktop-control port.

## Build and pair

Build on Windows with Go 1.23+:

```powershell
cd companion
go build -o northbot-companion.exe ./cmd/northbot-companion
```

In the workspace, open **Companion** and create a one-time pairing code. Then run from the companion folder:

```powershell
.\northbot-companion.exe pair --api https://bots.example.com/api --code NB-XXXX-XXXX
.\northbot-companion.exe share --power view --folder "C:\Users\me\Shop" --app notepad.exe
.\northbot-companion.exe run
```

Select the paired computer for the intended agent and enable access in the workspace. It is disabled for every agent until explicitly enabled. Pair/tunnel URLs require HTTPS remotely; HTTP is accepted only for loopback development.

## Local sharing and power

| Power        | Intended access                                          |
| ------------ | -------------------------------------------------------- |
| `view`       | Observe allowed content                                  |
| `view+click` | Add permitted pointer interaction                        |
| `full`       | Broader supported input/file actions within local shares |

Share only the required applications/folders. The local computer's configuration bounds remote permissions. Screenshots mask unshared desktop/app regions, including overlapping windows. A banner indicates active agent control, and actions have screenshot audit records.

Local share/power changes, the local kill command or an unreadable configuration stop the running session. Restart `run` to adopt changes. The server also checks device assignment and workspace kill state when dispatching work. Credential-bearing redirects are refused.

## Take control

| Hotkey             | Effect            |
| ------------------ | ----------------- |
| `Ctrl+Alt+Shift+B` | Take back control |
| `Ctrl+Alt+Shift+R` | Resume            |
| `Ctrl+Alt+Shift+K` | Kill switch       |

The workspace kill switch stops companion work too. Test local controls before enabling an agent on an important desktop.

## What has been verified

Go tests cover protocol, fake desktop, queue shutdown, masking, bounds, TLS/redirect behavior and configuration revocation. M12 runs the real companion binary with its fake driver against the server. A real Windows 11 read-only smoke check covered capture, windows, banner and hotkeys.

**Live clicks/typing on a real desktop, moving/overlapping-window masking and live native revocation still need manual validation.** Start on a spare machine. This guide does not clear that [blocker](../../BLOCKERS.md).

Source: [companion command](../../companion/cmd/northbot-companion/main.go), [desktop driver](../../companion/internal/driver/driver.go), [server companion hub](../../apps/server/src/companion/service.ts).
