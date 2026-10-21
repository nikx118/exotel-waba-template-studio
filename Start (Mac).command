#!/bin/bash
# WABA Template Studio — double-click to start (macOS; also works on Linux as `bash "Start (Mac).command"`).
# Uses Node.js 18+ if it's installed. If not, downloads a private copy into .runtime/ (one time,
# about 45 MB, no admin rights) and uses that. Nothing is installed system-wide.

NODE_VERSION="v22.12.0"
cd "$(dirname "$0")" || exit 1
RUNTIME="$PWD/.runtime"

fail() {
  echo
  echo "  $1"
  echo
  read -r -p "  Press Enter to close…" _
  exit 1
}

node_ok() { "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' >/dev/null 2>&1; }

NODE=""
if command -v node >/dev/null 2>&1 && node_ok node; then
  NODE="node"
elif [ -x "$RUNTIME/node/bin/node" ] && node_ok "$RUNTIME/node/bin/node"; then
  NODE="$RUNTIME/node/bin/node"
else
  case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) fail "Unsupported system: $(uname -s)" ;; esac
  case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) fail "Unsupported processor: $(uname -m)" ;; esac
  PKG="node-$NODE_VERSION-$OS-$ARCH"
  BASE="https://nodejs.org/dist/$NODE_VERSION"
  echo
  echo "  First run: downloading Node.js $NODE_VERSION for this computer (one time, ~45 MB)…"
  echo
  TMP="$(mktemp -d)" || fail "Couldn't create a temporary folder."
  curl -fL --progress-bar "$BASE/$PKG.tar.gz" -o "$TMP/node.tar.gz" || fail "Download failed. Check your internet connection, or install Node.js from https://nodejs.org and try again."
  # Make sure the download is the genuine file published by nodejs.org
  EXPECTED="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk -v f="$PKG.tar.gz" '$2 == f {print $1}')"
  ACTUAL="$(shasum -a 256 "$TMP/node.tar.gz" 2>/dev/null || sha256sum "$TMP/node.tar.gz")"
  ACTUAL="${ACTUAL%% *}"
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { rm -rf "$TMP"; fail "The Node.js download didn't match its checksum, so it wasn't used. Please try again."; }
  tar -xzf "$TMP/node.tar.gz" -C "$TMP" || fail "Couldn't unpack Node.js."
  rm -rf "$RUNTIME/node" && mkdir -p "$RUNTIME" && mv "$TMP/$PKG" "$RUNTIME/node"
  rm -rf "$TMP"
  NODE="$RUNTIME/node/bin/node"
fi

"$NODE" server.js || fail "WABA Template Studio stopped with an error (see above)."
