// Package tunnel connects the companion to the NorthBot server. The companion always dials out
// (no open ports on the person's computer): a one-time pairing over HTTPS, then one WebSocket.
package tunnel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/northbot/companion/internal/protocol"
)

// Pair trades a one-time code for a device token. api is the server's API base URL.
func Pair(ctx context.Context, api string, req protocol.PairRequest) (protocol.PairResponse, error) {
	var out protocol.PairResponse
	body, _ := json.Marshal(req)
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(api, "/")+"/companion/pair", bytes.NewReader(body))
	if err != nil {
		return out, err
	}
	r.Header.Set("content-type", "application/json")
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		return out, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		var e struct{ Message string }
		_ = json.NewDecoder(res.Body).Decode(&e)
		return out, fmt.Errorf("pairing refused (%d): %s", res.StatusCode, e.Message)
	}
	err = json.NewDecoder(res.Body).Decode(&out)
	return out, err
}

// Handler answers one command.
type Handler func(protocol.Message) protocol.Message

// Session is one connected tunnel.
type Session struct {
	conn *websocket.Conn
}

// Send writes one frame.
func (s *Session) Send(ctx context.Context, m protocol.Message) error {
	return wsjson.Write(ctx, s.conn, m)
}

// ErrUnauthorized means the device token was revoked; reconnecting will not help.
var ErrUnauthorized = errors.New("the server no longer accepts this device (unpaired or revoked)")

// Dial opens the tunnel and says hello.
func Dial(ctx context.Context, api, token string, hello protocol.Hello) (*Session, error) {
	u := strings.TrimRight(api, "/") + "/companion/tunnel"
	u = "ws" + strings.TrimPrefix(u, "http")
	conn, res, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}})
	if err != nil {
		if res != nil && (res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden) {
			return nil, ErrUnauthorized
		}
		return nil, err
	}
	conn.SetReadLimit(8 << 20)
	data, _ := json.Marshal(hello)
	s := &Session{conn: conn}
	if err := s.Send(ctx, protocol.Message{Type: "hello", Data: data}); err != nil {
		conn.Close(websocket.StatusInternalError, "hello failed")
		return nil, err
	}
	return s, nil
}

// Serve answers commands until the connection ends, the context ends, or kill is closed.
// Events from `events` are forwarded as they come.
func (s *Session) Serve(ctx context.Context, handle Handler, events <-chan protocol.Message, kill <-chan struct{}) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errs := make(chan error, 3)
	// Desktop input must happen in the order it was sent: one worker runs commands in turn.
	commands := make(chan protocol.Message, 64)
	go func() {
		for m := range commands {
			if err := s.Send(ctx, handle(m)); err != nil {
				errs <- err
				return
			}
		}
	}()
	go func() {
		defer close(commands)
		for {
			var m protocol.Message
			if err := wsjson.Read(ctx, s.conn, &m); err != nil {
				errs <- err
				return
			}
			switch m.Type {
			case "command":
				select {
				case commands <- m:
				default:
					_ = s.Send(ctx, protocol.Result(m.ID, nil, errors.New("too many commands waiting")))
				}
			case "ping":
				_ = s.Send(ctx, protocol.Message{Type: "pong"})
			case "kill":
				errs <- errKilledByServer
				return
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			s.conn.Close(websocket.StatusNormalClosure, "bye")
			return ctx.Err()
		case <-kill:
			// Flush the last events (the kill notice) before closing.
			drain(ctx, s, events)
			s.conn.Close(websocket.StatusNormalClosure, "killed at the computer")
			return ErrKilledLocally
		case ev := <-events:
			if err := s.Send(ctx, ev); err != nil {
				return err
			}
		case err := <-errs:
			s.conn.Close(websocket.StatusNormalClosure, "")
			return err
		}
	}
}

func drain(ctx context.Context, s *Session, events <-chan protocol.Message) {
	for {
		select {
		case ev := <-events:
			_ = s.Send(ctx, ev)
		default:
			return
		}
	}
}

var errKilledByServer = errors.New("the server used the kill switch")

// ErrKilledLocally means the person stopped the companion.
var ErrKilledLocally = errors.New("stopped at the computer")

// IsKill reports whether the session ended because of a kill switch (local or server).
func IsKill(err error) bool {
	return errors.Is(err, errKilledByServer) || errors.Is(err, ErrKilledLocally)
}

// Run keeps a tunnel up, reconnecting with backoff, until killed, unauthorized or ctx ends.
func Run(ctx context.Context, api, token string, hello protocol.Hello, handle Handler, events <-chan protocol.Message, kill <-chan struct{}) error {
	backoff := time.Second
	for {
		s, err := Dial(ctx, api, token, hello)
		if errors.Is(err, ErrUnauthorized) {
			return err
		}
		if err == nil {
			backoff = time.Second
			err = s.Serve(ctx, handle, events, kill)
			if IsKill(err) || ctx.Err() != nil {
				return err
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-kill:
			return ErrKilledLocally
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}
