//go:build windows && (amd64 || arm64)

package driver

import (
	"os"
	"testing"
)

// Read-only smoke test of the real desktop driver: it captures the screen and lists windows,
// and never clicks or types. Opt in with NORTHBOT_NATIVE_SMOKE=1 (needs an interactive desktop).
func TestNativeReadOnlySmoke(t *testing.T) {
	if os.Getenv("NORTHBOT_NATIVE_SMOKE") != "1" {
		t.Skip("set NORTHBOT_NATIVE_SMOKE=1 on an interactive Windows desktop")
	}
	d, err := Native()
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	img, err := d.Screenshot()
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() < 100 || b.Dy() < 100 {
		t.Fatalf("tiny capture %v", b)
	}
	ws, err := d.Windows()
	if err != nil || len(ws) == 0 {
		t.Fatalf("windows: %v %d", err, len(ws))
	}
	t.Logf("captured %v, %d windows, first app %q", img.Bounds(), len(ws), ws[len(ws)-1].App)
}
