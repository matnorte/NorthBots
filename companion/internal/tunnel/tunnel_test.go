package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/northbot/companion/internal/core"
	"github.com/northbot/companion/internal/driver"
	"github.com/northbot/companion/internal/protocol"
)

// mockServer stands in for the NorthBot server: one-time pairing codes, a bearer-token tunnel,
// and a script of commands to send once the companion says hello.
type mockServer struct {
	mu      sync.Mutex
	codes   map[string]bool
	token   string
	hello   protocol.Hello
	results []protocol.Message
	events  []protocol.Message
	script  []protocol.Message
	kill    bool
	done    chan struct{}
}

func (m *mockServer) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/companion/pair", func(w http.ResponseWriter, r *http.Request) {
		var req protocol.PairRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		m.mu.Lock()
		valid := m.codes[req.Code]
		delete(m.codes, req.Code) // one time only
		m.mu.Unlock()
		if !valid {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "unknown or used code"})
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(protocol.PairResponse{DeviceID: "dev-1", Token: m.token})
	})
	mux.HandleFunc("/companion/tunnel", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+m.token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(8 << 20)
		ctx := r.Context()
		var hello protocol.Message
		if err := wsjson.Read(ctx, conn, &hello); err != nil || hello.Type != "hello" {
			conn.Close(websocket.StatusPolicyViolation, "hello first")
			return
		}
		m.mu.Lock()
		_ = json.Unmarshal(hello.Data, &m.hello)
		script := m.script
		m.mu.Unlock()
		for _, c := range script {
			_ = wsjson.Write(ctx, conn, c)
		}
		for {
			var msg protocol.Message
			if err := wsjson.Read(ctx, conn, &msg); err != nil {
				return
			}
			m.mu.Lock()
			if msg.Type == "result" {
				m.results = append(m.results, msg)
			} else if msg.Type == "event" {
				m.events = append(m.events, msg)
			}
			finished := len(m.results) == len(script)
			m.mu.Unlock()
			if finished {
				if m.kill {
					_ = wsjson.Write(ctx, conn, protocol.Message{Type: "kill"})
				}
				select {
				case <-m.done:
				default:
					close(m.done)
				}
			}
		}
	})
	return mux
}

func command(id, action string, args any) protocol.Message {
	b, _ := json.Marshal(args)
	return protocol.Message{Type: "command", ID: id, Action: action, Args: b}
}

func TestCancelledSessionDiscardsQueuedDesktopInput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	commands := make(chan protocol.Message, 2)
	commands <- command("1", "type", map[string]string{"text": "private"})
	commands <- command("2", "click", map[string]int{"x": 30, "y": 40})
	close(commands)
	cancel()
	called := 0
	err := (&Session{}).answerCommands(ctx, func(m protocol.Message) protocol.Message {
		called++
		return protocol.Result(m.ID, nil, nil)
	}, commands)
	if !errors.Is(err, context.Canceled) || called != 0 {
		t.Fatalf("queued input ran after cancellation: calls=%d err=%v", called, err)
	}
}

func TestDrainStopsWhenEventChannelCloses(t *testing.T) {
	events := make(chan protocol.Message)
	close(events)
	// A closed channel must not manufacture empty events or attempt to use this nil connection.
	drain(context.Background(), &Session{}, events)
}

func TestRemotePairingRequiresTLSAndDoesNotFollowRedirects(t *testing.T) {
	for _, api := range []string{"http://remote.test", "https://user:password@remote.test", "https://remote.test?token=secret", "file:///tmp/config"} {
		if _, err := Pair(context.Background(), api, protocol.PairRequest{}); !errors.Is(err, ErrInvalidAPI) {
			t.Fatalf("unsafe API URL was accepted: %v", err)
		}
	}
	var forwarded bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/companion/pair" {
			http.Redirect(w, r, "/steal", http.StatusTemporaryRedirect)
			return
		}
		forwarded = true
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	if _, err := Pair(context.Background(), srv.URL, protocol.PairRequest{Code: "fixture-code"}); err == nil {
		t.Fatal("pairing followed a redirect")
	}
	if forwarded {
		t.Fatal("pairing code was forwarded")
	}
}

func TestPairThenRunClickAndTypeScript(t *testing.T) {
	m := &mockServer{codes: map[string]bool{"NB-TEST-CODE": true}, token: "tok-123", done: make(chan struct{}), kill: true}
	m.script = []protocol.Message{
		command("1", "click", map[string]int{"x": 60, "y": 60}),
		command("2", "type", map[string]string{"text": "Order #42 shipped"}),
		command("3", "key", map[string]string{"key": "enter"}),
		command("4", "click", map[string]int{"x": 450, "y": 60}),
	}
	srv := httptest.NewServer(m.handler())
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pair, err := Pair(ctx, srv.URL, protocol.PairRequest{Code: "NB-TEST-CODE", DeviceName: "shop-pc", OS: "windows"})
	if err != nil || pair.Token != "tok-123" {
		t.Fatalf("pair: %v %+v", err, pair)
	}
	if _, err := Pair(ctx, srv.URL, protocol.PairRequest{Code: "NB-TEST-CODE"}); err == nil {
		t.Fatal("a pairing code worked twice")
	}

	desk := driver.NewFake(
		driver.Window{App: "notepad.exe", Title: "Orders", X: 0, Y: 0, W: 300, H: 200},
		driver.Window{App: "bank.exe", Title: "Bank", X: 400, Y: 0, W: 200, H: 200},
	)
	events := make(chan protocol.Message, 32)
	comp, err := core.New(desk, core.Config{Power: protocol.PowerClick, Apps: []string{"notepad.exe"}}, func(e protocol.Message) { events <- e })
	if err != nil {
		t.Fatal(err)
	}
	err = Run(ctx, srv.URL, pair.Token, comp.Hello("shop-pc", "windows", "test"), comp.Handle, events, comp.Kill)
	if !IsKill(err) {
		t.Fatalf("run ended with %v, want the server's kill", err)
	}
	<-m.done

	if got := desk.TextOf("notepad.exe"); got != "Order #42 shipped\n" {
		t.Fatalf("typed %q", got)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.hello.DeviceName != "shop-pc" || m.hello.Power != protocol.PowerClick || len(m.hello.Apps) != 1 {
		t.Fatalf("hello: %+v", m.hello)
	}
	byID := map[string]protocol.Message{}
	for _, r := range m.results {
		byID[r.ID] = r
	}
	for _, id := range []string{"1", "2", "3"} {
		if r := byID[id]; r.OK == nil || !*r.OK {
			t.Fatalf("command %s failed: %+v", id, r)
		}
	}
	if r := byID["4"]; r.OK == nil || *r.OK {
		t.Fatalf("clicking an unshared app was allowed: %+v", r)
	}
	shots := 0
	for _, e := range m.events {
		if e.Kind == "screenshot" {
			shots++
		}
	}
	if shots < 3 {
		t.Fatalf("want a screenshot after each action, got %d", shots)
	}
}

func TestRevokedTokenStopsReconnecting(t *testing.T) {
	m := &mockServer{codes: map[string]bool{}, token: "good", done: make(chan struct{})}
	srv := httptest.NewServer(m.handler())
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := Run(ctx, srv.URL, "revoked", protocol.Hello{}, nil, make(chan protocol.Message), make(chan struct{}))
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized, got %v", err)
	}
}
