package core

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/northbot/companion/internal/driver"
	"github.com/northbot/companion/internal/protocol"
)

type sink struct {
	mu     sync.Mutex
	events []protocol.Message
}

func (s *sink) emit(m protocol.Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, m)
}

func (s *sink) kinds() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, e := range s.events {
		out = append(out, e.Kind)
	}
	return out
}

func cmd(action string, args any) protocol.Message {
	b, _ := json.Marshal(args)
	return protocol.Message{Type: "command", ID: action, Action: action, Args: b}
}

func desktop() *driver.Fake {
	return driver.NewFake(
		driver.Window{App: "notepad.exe", Title: "Notes", X: 0, Y: 0, W: 200, H: 200},
		driver.Window{App: "bank.exe", Title: "My bank", X: 300, Y: 0, W: 200, H: 200},
	)
}

func ok(t *testing.T, r protocol.Message) {
	t.Helper()
	if r.OK == nil || !*r.OK {
		t.Fatalf("%s failed: %s", r.ID, r.Error)
	}
}

func refused(t *testing.T, r protocol.Message, want string) {
	t.Helper()
	if r.OK == nil || *r.OK || !strings.Contains(r.Error, want) {
		t.Fatalf("%s: want refusal containing %q, got ok=%v err=%q", r.ID, want, r.OK != nil && *r.OK, r.Error)
	}
}

func TestClickAndTypeInSharedAppWithScreenshotTrail(t *testing.T) {
	d := desktop()
	s := &sink{}
	c, err := New(d, Config{Power: protocol.PowerClick, Apps: []string{"Notepad.exe"}}, s.emit)
	if err != nil {
		t.Fatal(err)
	}
	ok(t, c.Handle(cmd("click", map[string]int{"x": 50, "y": 50})))
	ok(t, c.Handle(cmd("type", map[string]string{"text": "hello"})))
	ok(t, c.Handle(cmd("key", map[string]string{"key": "enter"})))
	if got := d.TextOf("notepad.exe"); got != "hello\n" {
		t.Fatalf("typed %q", got)
	}
	if !strings.Contains(d.Banner(), "NorthBot agent") {
		t.Fatalf("no banner while acting: %q", d.Banner())
	}
	if k := s.kinds(); len(k) != 3 || k[0] != "screenshot" {
		t.Fatalf("want one screenshot per action, got %v", k)
	}
	// Windows outside the shared apps are invisible and untouchable.
	r := c.Handle(cmd("list_windows", nil))
	ok(t, r)
	if strings.Contains(string(r.Data), "bank.exe") {
		t.Fatalf("listed an unshared app: %s", r.Data)
	}
	refused(t, c.Handle(cmd("click", map[string]int{"x": 350, "y": 50})), "not shared")
	refused(t, c.Handle(cmd("click", map[string]int{"x": 600, "y": 300})), "not inside a shared app")
}

func TestPowerLevels(t *testing.T) {
	view, _ := New(desktop(), Config{Power: protocol.PowerView, Apps: []string{"notepad.exe"}}, func(protocol.Message) {})
	ok(t, view.Handle(cmd("screenshot", nil)))
	refused(t, view.Handle(cmd("click", map[string]int{"x": 5, "y": 5})), "not allowed at power level")
	click, _ := New(desktop(), Config{Power: protocol.PowerClick, Apps: []string{"notepad.exe"}}, func(protocol.Message) {})
	refused(t, click.Handle(cmd("launch_app", map[string]string{"app": "notepad.exe"})), "not allowed")
	full, _ := New(desktop(), Config{Power: protocol.PowerFull, Apps: []string{"notepad.exe"}}, func(protocol.Message) {})
	ok(t, full.Handle(cmd("launch_app", map[string]string{"app": "notepad.exe"})))
	refused(t, full.Handle(cmd("launch_app", map[string]string{"app": "cmd.exe"})), "not a shared app")
	if _, err := New(desktop(), Config{Power: "root"}, nil); err == nil {
		t.Fatal("accepted an unknown power level")
	}
}

func TestSharedFoldersOnly(t *testing.T) {
	root := t.TempDir()
	shared := filepath.Join(root, "shop")
	_ = os.MkdirAll(shared, 0o755)
	_ = os.WriteFile(filepath.Join(shared, "orders.csv"), []byte("id,total\n1,30\n"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "secret.txt"), []byte("nope"), 0o644)
	c, err := New(desktop(), Config{Power: protocol.PowerFull, Folders: []string{shared}}, func(protocol.Message) {})
	if err != nil {
		t.Fatal(err)
	}
	r := c.Handle(cmd("read_file", map[string]string{"path": filepath.Join(shared, "orders.csv")}))
	ok(t, r)
	if !strings.Contains(string(r.Data), base64.StdEncoding.EncodeToString([]byte("id,total\n1,30\n"))) {
		t.Fatalf("wrong content: %s", r.Data)
	}
	ok(t, c.Handle(cmd("list_folder", map[string]string{"path": shared})))
	refused(t, c.Handle(cmd("read_file", map[string]string{"path": filepath.Join(root, "secret.txt")})), "not inside a shared folder")
	refused(t, c.Handle(cmd("read_file", map[string]string{"path": filepath.Join(shared, "..", "secret.txt")})), "not inside a shared folder")
	refused(t, c.Handle(cmd("write_file", map[string]string{"path": filepath.Join(root, "x.txt"), "data": "aGk="})), "not inside a shared folder")
	ok(t, c.Handle(cmd("write_file", map[string]string{"path": filepath.Join(shared, "note.txt"), "data": "aGk="})))
	if b, _ := os.ReadFile(filepath.Join(shared, "note.txt")); string(b) != "hi" {
		t.Fatalf("write landed wrong: %q", b)
	}
	// A link inside the shared folder that points outside it does not escape.
	if err := os.Symlink(filepath.Join(root, "secret.txt"), filepath.Join(shared, "link.txt")); err == nil {
		refused(t, c.Handle(cmd("read_file", map[string]string{"path": filepath.Join(shared, "link.txt")})), "not inside a shared folder")
	}
}

func TestTakeBackResumeAndKill(t *testing.T) {
	d := desktop()
	s := &sink{}
	c, _ := New(d, Config{Power: protocol.PowerClick, Apps: []string{"notepad.exe"}}, s.emit)
	d.Press(driver.HotkeyTakeBack)
	waitFor(t, func() bool { return len(s.kinds()) == 1 })
	refused(t, c.Handle(cmd("click", map[string]int{"x": 10, "y": 10})), "took back control")
	if !strings.Contains(d.Banner(), "took back control") {
		t.Fatalf("banner: %q", d.Banner())
	}
	d.Press(driver.HotkeyResume)
	waitFor(t, func() bool { return len(s.kinds()) == 2 })
	ok(t, c.Handle(cmd("click", map[string]int{"x": 10, "y": 10})))
	d.Press(driver.HotkeyKill)
	select {
	case <-c.Kill:
	case <-time.After(2 * time.Second):
		t.Fatal("kill switch did not fire")
	}
	refused(t, c.Handle(cmd("screenshot", nil)), "kill switch")
	if k := s.kinds(); k[0] != "control_taken_back" || k[1] != "control_resumed" || k[len(k)-1] != "killed" {
		t.Fatalf("events: %v", k)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition never became true")
}
