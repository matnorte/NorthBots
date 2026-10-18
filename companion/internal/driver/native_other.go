//go:build !windows

package driver

import "errors"

// Native returns the real desktop driver. Only Windows is supported for now.
func Native() (Driver, error) {
	return nil, errors.New("the desktop driver only runs on Windows; use --fake-driver to try it elsewhere")
}
