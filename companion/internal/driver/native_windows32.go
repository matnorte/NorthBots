//go:build windows && !(amd64 || arm64)

package driver

import "errors"

// Native is only built for 64-bit Windows.
func Native() (Driver, error) {
	return nil, errors.New("the desktop driver needs 64-bit Windows")
}
