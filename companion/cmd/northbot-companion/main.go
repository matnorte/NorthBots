// Command northbot-companion lets NorthBot agents use this computer, within limits the person
// sets here: pair once with a code, choose folders, apps and a power level, then run.
//
//	northbot-companion pair  --api https://northbot.example.com/api --code NB-ABCD-EFGH
//	northbot-companion share --power view+click --folder C:\Users\me\Shop --app notepad.exe
//	northbot-companion run
//
// While it runs: Ctrl+Alt+Shift+B takes back control, Ctrl+Alt+Shift+R resumes, Ctrl+Alt+Shift+K
// stops it (kill switch). A banner shows whenever an agent is acting.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/northbot/companion/internal/core"
	"github.com/northbot/companion/internal/driver"
	"github.com/northbot/companion/internal/protocol"
	"github.com/northbot/companion/internal/tunnel"
)

const version = "0.1.0"

type config struct {
	API      string         `json:"api"`
	DeviceID string         `json:"deviceId"`
	Token    string         `json:"token"`
	Power    protocol.Power `json:"power"`
	Folders  []string       `json:"folders"`
	Apps     []string       `json:"apps"`
}

func defaultConfigPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "NorthBot", "companion.json")
}

func load(path string) (config, error) {
	var c config
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(b, &c)
	return c, err
}

func save(path string, c config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	// The token is a credential: readable by this user only.
	return os.WriteFile(path, b, 0o600)
}

type list []string

func (l *list) String() string     { return strings.Join(*l, ",") }
func (l *list) Set(v string) error { *l = append(*l, v); return nil }

func firstMAC() string {
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		if i.Flags&net.FlagLoopback == 0 && len(i.HardwareAddr) == 6 {
			return i.HardwareAddr.String()
		}
	}
	return ""
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: northbot-companion pair|share|run|kill [flags]")
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfigPath(), "config file")
	var err error
	switch cmd {
	case "pair":
		api := fs.String("api", "", "NorthBot API base URL, e.g. https://host/api")
		code := fs.String("code", "", "one-time pairing code from Settings → Companion")
		name := fs.String("name", "", "device name (default: hostname)")
		_ = fs.Parse(args)
		err = pair(*cfgPath, *api, *code, *name)
	case "share":
		power := fs.String("power", "", "view | view+click | full")
		var folders, apps list
		fs.Var(&folders, "folder", "a folder to share (repeatable)")
		fs.Var(&apps, "app", "an app to share, by executable name (repeatable)")
		clear := fs.Bool("clear", false, "remove all shares first")
		_ = fs.Parse(args)
		err = share(*cfgPath, protocol.Power(*power), folders, apps, *clear)
	case "run":
		fake := fs.Bool("fake-driver", false, "use an in-memory desktop (for testing)")
		_ = fs.Parse(args)
		err = run(*cfgPath, *fake)
	case "kill":
		_ = fs.Parse(args)
		// Forgetting the token stops this computer from reconnecting until it is paired again.
		var c config
		if c, err = load(*cfgPath); err == nil {
			c.Token = ""
			err = save(*cfgPath, c)
		}
	default:
		err = fmt.Errorf("unknown command %q", cmd)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func pair(path, api, code, name string) error {
	if api == "" || code == "" {
		return errors.New("--api and --code are required")
	}
	if name == "" {
		name, _ = os.Hostname()
	}
	res, err := tunnel.Pair(context.Background(), api, protocol.PairRequest{Code: code, DeviceName: name, OS: runtime.GOOS, MAC: firstMAC()})
	if err != nil {
		return err
	}
	c, _ := load(path)
	c.API, c.DeviceID, c.Token = api, res.DeviceID, res.Token
	if c.Power == "" {
		c.Power = protocol.PowerView
	}
	if err := save(path, c); err != nil {
		return err
	}
	fmt.Println("Paired. Nothing is shared yet: use `share` to pick folders, apps and a power level.")
	return nil
}

func share(path string, power protocol.Power, folders, apps []string, clear bool) error {
	c, err := load(path)
	if err != nil {
		return fmt.Errorf("pair first: %w", err)
	}
	if clear {
		c.Folders, c.Apps = nil, nil
	}
	if power != "" {
		if !power.Valid() {
			return fmt.Errorf("power must be view, view+click or full")
		}
		c.Power = power
	}
	c.Folders = append(c.Folders, folders...)
	c.Apps = append(c.Apps, apps...)
	return save(path, c)
}

func run(path string, fake bool) error {
	c, err := load(path)
	if err != nil {
		return fmt.Errorf("pair first: %w", err)
	}
	if c.Token == "" {
		return errors.New("this computer is not paired (or was stopped with kill); pair again")
	}
	var d driver.Driver
	if fake {
		d = driver.NewFake(driver.Window{App: "notepad.exe", Title: "Untitled - Notepad", X: 20, Y: 30, W: 400, H: 300})
	} else if d, err = driver.Native(); err != nil {
		return err
	}
	defer d.Close()
	events := make(chan protocol.Message, 64)
	emit := func(m protocol.Message) {
		select {
		case events <- m:
		default: // A full queue drops trail frames rather than blocking the desktop.
		}
	}
	comp, err := core.New(d, core.Config{Power: c.Power, Folders: c.Folders, Apps: c.Apps}, emit)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	host, _ := os.Hostname()
	fmt.Printf("Connected as %s (%s). Shared: %d folder(s), %d app(s).\n", host, c.Power, len(c.Folders), len(c.Apps))
	err = tunnel.Run(ctx, c.API, c.Token, comp.Hello(host, runtime.GOOS, version), comp.Handle, events, comp.Kill)
	if tunnel.IsKill(err) || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
