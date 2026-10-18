// Package driver is the companion's only door to the desktop. The real Windows driver and the
// fake one used in tests implement the same interface.
package driver

import "image"

// Window is a top-level window on the desktop.
type Window struct {
	ID    int    `json:"id"`
	App   string `json:"app"`
	Title string `json:"title"`
	X     int    `json:"x"`
	Y     int    `json:"y"`
	W     int    `json:"w"`
	H     int    `json:"h"`
}

// Contains reports whether the screen point (x, y) is inside the window.
func (w Window) Contains(x, y int) bool {
	return x >= w.X && y >= w.Y && x < w.X+w.W && y < w.Y+w.H
}

// Hotkeys the person at the computer can press.
const (
	HotkeyTakeBack = "take_back"
	HotkeyResume   = "resume"
	HotkeyKill     = "kill"
)

// Driver controls a desktop.
type Driver interface {
	Screenshot() (image.Image, error)
	Windows() ([]Window, error)
	// Focused returns the window that receives typing, or nil.
	Focused() (*Window, error)
	Click(x, y int) error
	Type(text string) error
	Key(name string) error
	Launch(app string) error
	// ShowBanner keeps a visible notice on screen while an agent is in control.
	ShowBanner(text string) error
	HideBanner() error
	// Hotkeys delivers presses of HotkeyTakeBack, HotkeyResume and HotkeyKill.
	Hotkeys() <-chan string
	Close() error
}
