#!/bin/sh
# Builds the strata command for every platform into dist/, with a SHA256SUMS file.
# Usage: scripts/release.sh [version]     (version defaults to the newest git tag, or "dev")
set -eu
cd "$(dirname "$0")/.."
version="${1:-$(git describe --tags --abbrev=0 2>/dev/null || echo dev)}"
rm -rf dist && mkdir -p dist
for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do
  os="${target%/*}"; arch="${target#*/}"; ext=""; [ "$os" = windows ] && ext=".exe"
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.ver=${version#v}" -o "dist/strata-$os-$arch$ext" ./cmd/strata
  echo "ok · strata-$os-$arch$ext"
done
(cd dist && shasum -a 256 strata-* > SHA256SUMS && cat SHA256SUMS)
