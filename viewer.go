// Package strata carries the one file the command embeds: the viewer, browser JavaScript that is
// pasted into every page. go:embed cannot reach above its own directory, so the embedding lives
// here, at the repository root, beside src/viewer.js (which is not copied or moved).
package strata

import _ "embed"

// Viewer is src/viewer.js.
//
//go:embed src/viewer.js
var Viewer string

// PackageJSON is package.json, which holds the version a checkout reports.
//
//go:embed package.json
var PackageJSON []byte
