package main

import (
	"context"
	"github.com/northbot/companion/internal/protocol"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalConfigurationChangesStopRunningSession(t *testing.T) {
	for _, kind := range []string{"kill", "unshare", "lower_power", "invalid", "removed"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "companion.json")
			initial := config{API: "https://northbot.test", Token: "fixture-token", Power: protocol.PowerFull,
				Apps: []string{"notepad.exe"}, Folders: []string{"shared"}}
			if err := save(path, initial); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stopped := make(chan struct{})
			go watchConfig(ctx, path, initial, func() { close(stopped) })
			changed := initial
			switch kind {
			case "kill":
				changed.Token = ""
			case "unshare":
				changed.Apps, changed.Folders = nil, nil
			case "lower_power":
				changed.Power = protocol.PowerView
			case "invalid":
				if err := os.WriteFile(path, []byte("invalid json"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "removed":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			}
			if kind != "invalid" && kind != "removed" {
				if err := save(path, changed); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-stopped:
			case <-time.After(2 * time.Second):
				t.Fatal("old session retained local sharing permissions")
			}
		})
	}
}
