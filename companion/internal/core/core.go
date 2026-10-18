// Package core is the companion's policy: what the server may ask for, given the power level and
// the folders and apps the person shared. Everything is checked here, on the person's computer;
// the server cannot widen it.
package core

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/northbot/companion/internal/driver"
	"github.com/northbot/companion/internal/protocol"
)

// MaxFileBytes caps reads and writes of shared files.
const MaxFileBytes = 5 << 20

// ErrKilled is returned once the person used the kill switch.
var ErrKilled = errors.New("the companion was stopped with the kill switch")

// Config is what the person chose to share.
type Config struct {
	Power   protocol.Power
	Folders []string
	Apps    []string
	// BannerIdle hides the banner this long after the last command.
	BannerIdle time.Duration
}

// Companion runs commands from the tunnel against a driver.
type Companion struct {
	d       driver.Driver
	cfg     Config
	folders []string
	emit    func(protocol.Message)

	mu        sync.Mutex
	paused    bool
	killed    bool
	bannerTmr *time.Timer
	// Kill is closed when the kill switch is used.
	Kill chan struct{}
}

// New builds a companion. emit sends events (screenshots, hotkeys) to the server.
func New(d driver.Driver, cfg Config, emit func(protocol.Message)) (*Companion, error) {
	if !cfg.Power.Valid() {
		return nil, fmt.Errorf("unknown power level %q", cfg.Power)
	}
	if cfg.BannerIdle == 0 {
		cfg.BannerIdle = 15 * time.Second
	}
	c := &Companion{d: d, cfg: cfg, emit: emit, Kill: make(chan struct{})}
	for _, f := range cfg.Folders {
		abs, err := realPath(f)
		if err != nil {
			return nil, fmt.Errorf("shared folder %s: %w", f, err)
		}
		c.folders = append(c.folders, abs)
	}
	go c.watchHotkeys()
	return c, nil
}

// Hello describes what this computer shares.
func (c *Companion) Hello(name, os, version string) protocol.Hello {
	return protocol.Hello{DeviceName: name, OS: os, Version: version, Power: c.cfg.Power, Folders: c.folders, Apps: c.cfg.Apps}
}

func (c *Companion) watchHotkeys() {
	for key := range c.d.Hotkeys() {
		switch key {
		case driver.HotkeyTakeBack:
			c.mu.Lock()
			c.paused = true
			c.mu.Unlock()
			_ = c.d.ShowBanner("You took back control. NorthBot agents are paused here.")
			c.emit(protocol.Event("control_taken_back", map[string]any{"at": time.Now().UTC()}))
		case driver.HotkeyResume:
			c.mu.Lock()
			c.paused = false
			c.mu.Unlock()
			_ = c.d.HideBanner()
			c.emit(protocol.Event("control_resumed", map[string]any{"at": time.Now().UTC()}))
		case driver.HotkeyKill:
			c.Stop()
			return
		}
	}
}

// Stop is the local kill switch: refuse everything from now on and tell the server once.
func (c *Companion) Stop() {
	c.mu.Lock()
	if c.killed {
		c.mu.Unlock()
		return
	}
	c.killed = true
	c.mu.Unlock()
	_ = c.d.HideBanner()
	c.emit(protocol.Event("killed", map[string]any{"at": time.Now().UTC()}))
	close(c.Kill)
}

// Handle runs one command and returns the result frame.
func (c *Companion) Handle(m protocol.Message) protocol.Message {
	data, err := c.run(m.Action, m.Args)
	return protocol.Result(m.ID, data, err)
}

func (c *Companion) run(action string, raw json.RawMessage) (any, error) {
	c.mu.Lock()
	paused, killed := c.paused, c.killed
	c.mu.Unlock()
	if killed {
		return nil, ErrKilled
	}
	if paused {
		return nil, errors.New("the person at this computer took back control")
	}
	if !c.cfg.Power.Allows(action) {
		return nil, fmt.Errorf("%s is not allowed at power level %q", action, c.cfg.Power)
	}
	if protocol.Acting(action) {
		c.banner()
	}
	var args struct {
		X, Y int
		Text string
		Key  string
		App  string
		Path string
		Data string
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, fmt.Errorf("bad arguments: %w", err)
		}
	}
	var out any
	var err error
	switch action {
	case "screenshot":
		out, err = c.screenshot()
	case "list_windows":
		out, err = c.sharedWindows()
	case "click":
		err = c.click(args.X, args.Y)
	case "type":
		if err = c.inSharedApp(); err == nil {
			err = c.d.Type(args.Text)
		}
	case "key":
		if err = c.inSharedApp(); err == nil {
			err = c.d.Key(args.Key)
		}
	case "launch_app":
		if !c.appShared(args.App) {
			err = fmt.Errorf("%s is not a shared app", args.App)
		} else {
			err = c.d.Launch(args.App)
		}
	case "list_folder":
		out, err = c.listFolder(args.Path)
	case "read_file":
		out, err = c.readFile(args.Path)
	case "write_file":
		err = c.writeFile(args.Path, args.Data)
	default:
		err = fmt.Errorf("unknown action %q", action)
	}
	if err == nil && protocol.Acting(action) {
		c.trail(action)
	}
	return out, err
}

// banner shows the notice and hides it once commands stop for a while.
func (c *Companion) banner() {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.d.ShowBanner("A NorthBot agent is using this computer. Press Ctrl+Alt+Shift+B to take back control.")
	if c.bannerTmr != nil {
		c.bannerTmr.Stop()
	}
	c.bannerTmr = time.AfterFunc(c.cfg.BannerIdle, func() {
		c.mu.Lock()
		paused := c.paused
		c.mu.Unlock()
		if !paused {
			_ = c.d.HideBanner()
		}
	})
}

// trail sends a screenshot after every acting command, for the audit log.
func (c *Companion) trail(action string) {
	shot, err := c.screenshot()
	if err != nil {
		return
	}
	c.emit(protocol.Event("screenshot", map[string]any{"action": action, "png": shot["png"], "at": time.Now().UTC()}))
}

func (c *Companion) screenshot() (map[string]any, error) {
	windows, err := c.d.Windows()
	if err != nil {
		return nil, err
	}
	img, err := c.d.Screenshot()
	if err != nil {
		return nil, err
	}
	// The desktop and unshared windows stay opaque, including windows covering shared apps.
	masked := image.NewRGBA(img.Bounds())
	draw.Draw(masked, masked.Bounds(), image.NewUniform(color.Black), image.Point{}, draw.Src)
	for _, w := range windows {
		r := image.Rect(w.X, w.Y, w.X+w.W, w.Y+w.H).Intersect(img.Bounds())
		if c.appShared(w.App) {
			draw.Draw(masked, r, img, r.Min, draw.Src)
		} else {
			draw.Draw(masked, r, image.NewUniform(color.Black), image.Point{}, draw.Src)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, masked); err != nil {
		return nil, err
	}
	b := img.Bounds()
	return map[string]any{"png": base64.StdEncoding.EncodeToString(buf.Bytes()), "width": b.Dx(), "height": b.Dy()}, nil
}

func (c *Companion) appShared(app string) bool {
	for _, a := range c.cfg.Apps {
		if strings.EqualFold(a, app) {
			return true
		}
	}
	return false
}

func (c *Companion) sharedWindows() ([]driver.Window, error) {
	all, err := c.d.Windows()
	if err != nil {
		return nil, err
	}
	out := []driver.Window{}
	for _, w := range all {
		if c.appShared(w.App) {
			out = append(out, w)
		}
	}
	return out, nil
}

// click only lands inside a shared app's window, and only if no other window covers that point.
func (c *Companion) click(x, y int) error {
	all, err := c.d.Windows()
	if err != nil {
		return err
	}
	for i := len(all) - 1; i >= 0; i-- {
		if all[i].Contains(x, y) {
			if !c.appShared(all[i].App) {
				return fmt.Errorf("that point is in %s, which is not shared", all[i].App)
			}
			return c.d.Click(x, y)
		}
	}
	return errors.New("that point is not inside a shared app")
}

func (c *Companion) inSharedApp() error {
	w, err := c.d.Focused()
	if err != nil {
		return err
	}
	if w == nil || !c.appShared(w.App) {
		return errors.New("the focused window is not a shared app; click into one first")
	}
	return nil
}

func realPath(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// inShared resolves a path (following links) and checks it stays inside a shared folder.
func (c *Companion) inShared(p string, mustExist bool) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		if mustExist || !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		// A new file: its folder must exist and be shared.
		dir, derr := filepath.EvalSymlinks(filepath.Dir(abs))
		if derr != nil {
			return "", derr
		}
		resolved = filepath.Join(dir, filepath.Base(abs))
	}
	for _, f := range c.folders {
		rel, err := filepath.Rel(f, resolved)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			return resolved, nil
		}
	}
	return "", fmt.Errorf("%s is not inside a shared folder", p)
}

func (c *Companion) listFolder(p string) ([]map[string]any, error) {
	dir, err := c.inShared(p, true)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, map[string]any{"name": e.Name(), "dir": e.IsDir(), "size": info.Size()})
	}
	return out, nil
}

func (c *Companion) readFile(p string) (map[string]any, error) {
	path, err := c.inShared(p, true)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("only regular shared files can be read")
	}
	if info.Size() > MaxFileBytes {
		return nil, fmt.Errorf("%s is larger than %d bytes", p, MaxFileBytes)
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxFileBytes {
		return nil, fmt.Errorf("file larger than %d bytes", MaxFileBytes)
	}
	return map[string]any{"data": base64.StdEncoding.EncodeToString(b), "size": len(b)}, nil
}

func (c *Companion) writeFile(p, data string) error {
	path, err := c.inShared(p, false)
	if err != nil {
		return err
	}
	b, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return fmt.Errorf("data must be base64: %w", err)
	}
	if len(b) > MaxFileBytes {
		return fmt.Errorf("file larger than %d bytes", MaxFileBytes)
	}
	return os.WriteFile(path, b, 0o644)
}
