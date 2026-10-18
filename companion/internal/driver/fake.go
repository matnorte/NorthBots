package driver

import (
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"strings"
	"sync"
)

// FakeWindow is a window on the fake desktop, with the text typed into it.
type FakeWindow struct {
	Window
	Text string
}

// Fake is an in-memory desktop for tests: windows, focus, typed text, a banner and hotkeys.
type Fake struct {
	mu       sync.Mutex
	windows  []*FakeWindow
	focused  *FakeWindow
	launched []string
	banner   string
	actions  []string
	hotkeys  chan string
	nextID   int
}

// NewFake returns a fake desktop with the given windows (IDs are assigned in order).
func NewFake(windows ...Window) *Fake {
	f := &Fake{hotkeys: make(chan string, 8)}
	for _, w := range windows {
		f.add(w)
	}
	return f
}

func (f *Fake) add(w Window) *FakeWindow {
	f.nextID++
	w.ID = f.nextID
	fw := &FakeWindow{Window: w}
	f.windows = append(f.windows, fw)
	return fw
}

func (f *Fake) Screenshot() (image.Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	img := image.NewRGBA(image.Rect(0, 0, 640, 400))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.RGBA{30, 30, 40, 255}}, image.Point{}, draw.Src)
	for i, w := range f.windows {
		c := color.RGBA{uint8(90 + 40*i), 120, uint8(200 - 30*i), 255}
		draw.Draw(img, image.Rect(w.X, w.Y, w.X+w.W, w.Y+w.H), &image.Uniform{c}, image.Point{}, draw.Src)
	}
	if f.banner != "" {
		draw.Draw(img, image.Rect(0, 0, 640, 16), &image.Uniform{color.RGBA{255, 107, 139, 255}}, image.Point{}, draw.Src)
	}
	return img, nil
}

func (f *Fake) Windows() ([]Window, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Window, 0, len(f.windows))
	for _, w := range f.windows {
		out = append(out, w.Window)
	}
	return out, nil
}

func (f *Fake) Focused() (*Window, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.focused == nil {
		return nil, nil
	}
	w := f.focused.Window
	return &w, nil
}

func (f *Fake) Click(x, y int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.actions = append(f.actions, fmt.Sprintf("click %d,%d", x, y))
	// The topmost window under the point gets focus.
	for i := len(f.windows) - 1; i >= 0; i-- {
		if f.windows[i].Contains(x, y) {
			f.focused = f.windows[i]
			return nil
		}
	}
	f.focused = nil
	return nil
}

func (f *Fake) Type(text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.actions = append(f.actions, "type "+text)
	if f.focused == nil {
		return fmt.Errorf("no window has focus")
	}
	f.focused.Text += text
	return nil
}

func (f *Fake) Key(name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.actions = append(f.actions, "key "+name)
	if f.focused == nil {
		return fmt.Errorf("no window has focus")
	}
	switch strings.ToLower(name) {
	case "enter":
		f.focused.Text += "\n"
	case "backspace":
		if n := len(f.focused.Text); n > 0 {
			f.focused.Text = f.focused.Text[:n-1]
		}
	}
	return nil
}

func (f *Fake) Launch(app string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.launched = append(f.launched, app)
	f.focused = f.add(Window{App: app, Title: app, X: 40, Y: 40, W: 300, H: 200})
	return nil
}

func (f *Fake) ShowBanner(text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.banner = text
	return nil
}

func (f *Fake) HideBanner() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.banner = ""
	return nil
}

func (f *Fake) Hotkeys() <-chan string { return f.hotkeys }

func (f *Fake) Close() error { return nil }

// Press simulates the person pressing a hotkey.
func (f *Fake) Press(hotkey string) { f.hotkeys <- hotkey }

// Banner is the text currently shown ("" when hidden).
func (f *Fake) Banner() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.banner
}

// TextOf returns what was typed into the first window of an app.
func (f *Fake) TextOf(app string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, w := range f.windows {
		if w.App == app {
			return w.Text
		}
	}
	return ""
}

// Actions lists every input the fake received, in order.
func (f *Fake) Actions() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.actions...)
}
