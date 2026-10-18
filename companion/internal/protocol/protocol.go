// Package protocol defines the messages the companion and the NorthBot server exchange over
// the outbound WebSocket tunnel. Every message is one JSON object.
package protocol

import "encoding/json"

// Power is how much an agent may do on this computer. The person at the computer picks it.
type Power string

const (
	// PowerView allows screenshots, listing shared app windows and reading shared folders.
	PowerView Power = "view"
	// PowerClick also allows clicking, typing and keys inside shared apps.
	PowerClick Power = "view+click"
	// PowerFull also allows launching shared apps and writing into shared folders.
	PowerFull Power = "full"
)

// Valid reports whether p is a known power level.
func (p Power) Valid() bool { return p == PowerView || p == PowerClick || p == PowerFull }

// Allows reports whether this power level permits an action.
func (p Power) Allows(action string) bool {
	switch action {
	case "screenshot", "list_windows", "list_folder", "read_file":
		return p.Valid()
	case "click", "type", "key":
		return p == PowerClick || p == PowerFull
	case "launch_app", "write_file":
		return p == PowerFull
	}
	return false
}

// Acting actions change something on the computer; each one leaves a screenshot in the trail.
func Acting(action string) bool {
	switch action {
	case "click", "type", "key", "launch_app", "write_file":
		return true
	}
	return false
}

// Message is one frame on the tunnel.
//
//	server → companion: {type:"command", id, action, args} | {type:"kill"} | {type:"ping"}
//	companion → server: {type:"hello", data} | {type:"result", id, ok, data|error} | {type:"event", kind, data} | {type:"pong"}
type Message struct {
	Type   string          `json:"type"`
	ID     string          `json:"id,omitempty"`
	Action string          `json:"action,omitempty"`
	Args   json.RawMessage `json:"args,omitempty"`
	OK     *bool           `json:"ok,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
	Error  string          `json:"error,omitempty"`
	Kind   string          `json:"kind,omitempty"`
}

// Hello tells the server what this computer shares. The server cannot widen it.
type Hello struct {
	DeviceName string   `json:"deviceName"`
	OS         string   `json:"os"`
	Version    string   `json:"version"`
	Power      Power    `json:"power"`
	Folders    []string `json:"folders"`
	Apps       []string `json:"apps"`
}

// PairRequest trades a one-time pairing code for a device token.
type PairRequest struct {
	Code       string `json:"code"`
	DeviceName string `json:"deviceName"`
	OS         string `json:"os"`
	MAC        string `json:"mac,omitempty"`
}

// PairResponse carries the device token (shown once; the server keeps only its hash).
type PairResponse struct {
	DeviceID string `json:"deviceId"`
	Token    string `json:"token"`
}

// Result builds a result frame.
func Result(id string, data any, err error) Message {
	ok := err == nil
	m := Message{Type: "result", ID: id, OK: &ok}
	if err != nil {
		m.Error = err.Error()
		return m
	}
	if data != nil {
		b, _ := json.Marshal(data)
		m.Data = b
	}
	return m
}

// Event builds an event frame.
func Event(kind string, data any) Message {
	b, _ := json.Marshal(data)
	return Message{Type: "event", Kind: kind, Data: b}
}
