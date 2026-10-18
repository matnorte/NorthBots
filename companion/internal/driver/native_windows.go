//go:build windows && (amd64 || arm64)

package driver

import (
	"fmt"
	"image"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")

	pSetCursorPos              = user32.NewProc("SetCursorPos")
	pMouseEvent                = user32.NewProc("mouse_event")
	pKeybdEvent                = user32.NewProc("keybd_event")
	pSendInput                 = user32.NewProc("SendInput")
	pEnumWindows               = user32.NewProc("EnumWindows")
	pGetWindowTextW            = user32.NewProc("GetWindowTextW")
	pGetWindowRect             = user32.NewProc("GetWindowRect")
	pIsWindowVisible           = user32.NewProc("IsWindowVisible")
	pGetWindowThreadProcessId  = user32.NewProc("GetWindowThreadProcessId")
	pGetForegroundWindow       = user32.NewProc("GetForegroundWindow")
	pRegisterHotKey            = user32.NewProc("RegisterHotKey")
	pUnregisterHotKey          = user32.NewProc("UnregisterHotKey")
	pGetMessageW               = user32.NewProc("GetMessageW")
	pPostThreadMessageW        = user32.NewProc("PostThreadMessageW")
	pCreateWindowExW           = user32.NewProc("CreateWindowExW")
	pDestroyWindow             = user32.NewProc("DestroyWindow")
	pShowWindowAsync           = user32.NewProc("ShowWindowAsync")
	pSetWindowTextW            = user32.NewProc("SetWindowTextW")
	pTranslateMessage          = user32.NewProc("TranslateMessage")
	pDispatchMessageW          = user32.NewProc("DispatchMessageW")
	pGetSystemMetrics          = user32.NewProc("GetSystemMetrics")
	pGetDC                     = user32.NewProc("GetDC")
	pReleaseDC                 = user32.NewProc("ReleaseDC")
	pCreateCompatibleDC        = gdi32.NewProc("CreateCompatibleDC")
	pCreateCompatibleBitmap    = gdi32.NewProc("CreateCompatibleBitmap")
	pSelectObject              = gdi32.NewProc("SelectObject")
	pBitBlt                    = gdi32.NewProc("BitBlt")
	pGetDIBits                 = gdi32.NewProc("GetDIBits")
	pDeleteObject              = gdi32.NewProc("DeleteObject")
	pDeleteDC                  = gdi32.NewProc("DeleteDC")
	pOpenProcess               = kernel32.NewProc("OpenProcess")
	pQueryFullProcessImageName = kernel32.NewProc("QueryFullProcessImageNameW")
	pCloseHandle               = kernel32.NewProc("CloseHandle")
	pGetCurrentThreadId        = kernel32.NewProc("GetCurrentThreadId")
	pShellExecuteW             = shell32.NewProc("ShellExecuteW")
)

const (
	mouseLeftDown = 0x0002
	mouseLeftUp   = 0x0004
	keyUp         = 0x0002
	keyUnicode    = 0x0004
	inputKeyboard = 1
	wmHotkey      = 0x0312
	wmQuit        = 0x0012
	modAlt        = 0x0001
	modControl    = 0x0002
	modShift      = 0x0004
	modNoRepeat   = 0x4000
	wsPopup       = 0x80000000
	wsExTopmost   = 0x00000008
	wsExToolwin   = 0x00000080
	wsExNoActive  = 0x08000000
	swHide        = 0
	swShowNoAct   = 4
	srccopy       = 0x00CC0020
	queryLimited  = 0x1000
)

type rect struct{ Left, Top, Right, Bottom int32 }

type msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

// keyboardInput is an INPUT with a KEYBDINPUT (40 bytes on 64-bit Windows).
type keyboardInput struct {
	typ   uint32
	_     uint32
	vk    uint16
	scan  uint16
	flags uint32
	time  uint32
	extra uintptr
	_     [8]byte
}

var keys = map[string]uintptr{
	"enter": 0x0D, "tab": 0x09, "backspace": 0x08, "escape": 0x1B, "delete": 0x2E,
	"home": 0x24, "end": 0x23, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
}

type native struct {
	hotkeys  chan string
	threadID uintptr
	banner   uintptr
	done     chan struct{}
	mu       sync.Mutex
}

// Native returns the real Windows desktop driver. It runs a small UI thread for the banner and
// the hotkeys (Ctrl+Alt+Shift+B take back, +R resume, +K kill).
func Native() (Driver, error) {
	n := &native{hotkeys: make(chan string, 8), done: make(chan struct{})}
	ready := make(chan error, 1)
	go n.uiThread(ready)
	if err := <-ready; err != nil {
		return nil, err
	}
	return n, nil
}

func (n *native) uiThread(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(n.done)
	defer close(n.hotkeys)
	tid, _, _ := pGetCurrentThreadId.Call()
	n.threadID = tid
	cls, _ := syscall.UTF16PtrFromString("STATIC")
	title, _ := syscall.UTF16PtrFromString("NorthBot")
	width, _, _ := pGetSystemMetrics.Call(0)
	hwnd, _, err := pCreateWindowExW.Call(wsExTopmost|wsExToolwin|wsExNoActive, uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(title)), wsPopup, 0, 0, width, 28, 0, 0, 0, 0)
	if hwnd == 0 {
		ready <- fmt.Errorf("could not create the banner window: %v", err)
		return
	}
	n.banner = hwnd
	defer pDestroyWindow.Call(hwnd)
	bindings := map[uintptr]string{1: HotkeyTakeBack, 2: HotkeyResume, 3: HotkeyKill}
	letters := map[uintptr]uintptr{1: 'B', 2: 'R', 3: 'K'}
	for id, vk := range letters {
		if ok, _, err := pRegisterHotKey.Call(0, id, modControl|modAlt|modShift|modNoRepeat, vk); ok == 0 {
			ready <- fmt.Errorf("could not register the Ctrl+Alt+Shift hotkeys: %v", err)
			return
		}
		defer pUnregisterHotKey.Call(0, id)
	}
	ready <- nil
	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if r == 0 || int32(r) == -1 {
			return
		}
		if m.Message == wmHotkey {
			if name, ok := bindings[m.WParam]; ok {
				select {
				case n.hotkeys <- name:
				default:
				}
			}
			continue
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

func (n *native) Screenshot() (image.Image, error) {
	w, _, _ := pGetSystemMetrics.Call(0)
	h, _, _ := pGetSystemMetrics.Call(1)
	screen, _, _ := pGetDC.Call(0)
	if screen == 0 {
		return nil, fmt.Errorf("no screen device context")
	}
	defer pReleaseDC.Call(0, screen)
	mem, _, _ := pCreateCompatibleDC.Call(screen)
	defer pDeleteDC.Call(mem)
	bmp, _, _ := pCreateCompatibleBitmap.Call(screen, w, h)
	defer pDeleteObject.Call(bmp)
	old, _, _ := pSelectObject.Call(mem, bmp)
	defer pSelectObject.Call(mem, old)
	if ok, _, err := pBitBlt.Call(mem, 0, 0, w, h, screen, 0, 0, srccopy); ok == 0 {
		return nil, fmt.Errorf("screen capture failed: %v", err)
	}
	// BITMAPINFOHEADER for a top-down 32-bit image.
	hdr := struct {
		Size          uint32
		Width, Height int32
		Planes, Bits  uint16
		Compression   uint32
		SizeImage     uint32
		XPels, YPels  int32
		ClrUsed       uint32
		ClrImportant  uint32
		_             [4]uint32
	}{Width: int32(w), Height: -int32(h), Planes: 1, Bits: 32}
	hdr.Size = 40
	img := image.NewRGBA(image.Rect(0, 0, int(w), int(h)))
	if r, _, err := pGetDIBits.Call(mem, bmp, 0, h, uintptr(unsafe.Pointer(&img.Pix[0])), uintptr(unsafe.Pointer(&hdr)), 0); r == 0 {
		return nil, fmt.Errorf("reading the capture failed: %v", err)
	}
	// Windows gives BGRA; swap to RGBA and make it opaque.
	for i := 0; i+3 < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+2], img.Pix[i+3] = img.Pix[i+2], img.Pix[i], 255
	}
	return img, nil
}

func windowInfo(hwnd uintptr) (Window, bool) {
	if v, _, _ := pIsWindowVisible.Call(hwnd); v == 0 {
		return Window{}, false
	}
	buf := make([]uint16, 256)
	l, _, _ := pGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if l == 0 {
		return Window{}, false
	}
	var r rect
	pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	return Window{ID: int(hwnd), App: appOf(hwnd), Title: syscall.UTF16ToString(buf[:l]), X: int(r.Left), Y: int(r.Top), W: int(r.Right - r.Left), H: int(r.Bottom - r.Top)}, true
}

func appOf(hwnd uintptr) string {
	var pid uint32
	pGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	h, _, _ := pOpenProcess.Call(queryLimited, 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer pCloseHandle.Call(h)
	buf := make([]uint16, 1024)
	size := uint32(len(buf))
	if ok, _, _ := pQueryFullProcessImageName.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size))); ok == 0 {
		return ""
	}
	return strings.ToLower(filepath.Base(syscall.UTF16ToString(buf[:size])))
}

var (
	enumMu  sync.Mutex
	enumOut []Window
	enumCb  = syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
		if w, ok := windowInfo(hwnd); ok {
			enumOut = append(enumOut, w)
		}
		return 1
	})
)

// Windows lists visible top-level windows from bottom to top (so later ones are on top).
func (n *native) Windows() ([]Window, error) {
	enumMu.Lock()
	defer enumMu.Unlock()
	enumOut = nil
	pEnumWindows.Call(enumCb, 0)
	// EnumWindows goes top to bottom; callers expect bottom to top.
	out := make([]Window, len(enumOut))
	for i, w := range enumOut {
		out[len(enumOut)-1-i] = w
	}
	return out, nil
}

func (n *native) Focused() (*Window, error) {
	h, _, _ := pGetForegroundWindow.Call()
	if h == 0 {
		return nil, nil
	}
	w, ok := windowInfo(h)
	if !ok {
		return nil, nil
	}
	return &w, nil
}

func (n *native) Click(x, y int) error {
	if ok, _, err := pSetCursorPos.Call(uintptr(x), uintptr(y)); ok == 0 {
		return fmt.Errorf("could not move the pointer: %v", err)
	}
	pMouseEvent.Call(mouseLeftDown, 0, 0, 0, 0)
	pMouseEvent.Call(mouseLeftUp, 0, 0, 0, 0)
	return nil
}

func (n *native) Type(text string) error {
	units := syscall.StringToUTF16(text)
	units = units[:len(units)-1]
	inputs := make([]keyboardInput, 0, len(units)*2)
	for _, u := range units {
		inputs = append(inputs, keyboardInput{typ: inputKeyboard, scan: u, flags: keyUnicode}, keyboardInput{typ: inputKeyboard, scan: u, flags: keyUnicode | keyUp})
	}
	if len(inputs) == 0 {
		return nil
	}
	sent, _, err := pSendInput.Call(uintptr(len(inputs)), uintptr(unsafe.Pointer(&inputs[0])), unsafe.Sizeof(inputs[0]))
	if int(sent) != len(inputs) {
		return fmt.Errorf("typing was blocked: %v", err)
	}
	return nil
}

func (n *native) Key(name string) error {
	vk, ok := keys[strings.ToLower(name)]
	if !ok {
		return fmt.Errorf("unknown key %q", name)
	}
	pKeybdEvent.Call(vk, 0, 0, 0)
	pKeybdEvent.Call(vk, 0, keyUp, 0)
	return nil
}

func (n *native) Launch(app string) error {
	verb, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString(app)
	if r, _, _ := pShellExecuteW.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), 0, 0, 1); r <= 32 {
		return fmt.Errorf("could not start %s (code %d)", app, r)
	}
	return nil
}

func (n *native) ShowBanner(text string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	t, _ := syscall.UTF16PtrFromString("  " + text)
	pSetWindowTextW.Call(n.banner, uintptr(unsafe.Pointer(t)))
	pShowWindowAsync.Call(n.banner, swShowNoAct)
	return nil
}

func (n *native) HideBanner() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	pShowWindowAsync.Call(n.banner, swHide)
	return nil
}

func (n *native) Hotkeys() <-chan string { return n.hotkeys }

func (n *native) Close() error {
	pPostThreadMessageW.Call(n.threadID, wmQuit, 0, 0)
	<-n.done
	return nil
}
