#!/bin/sh
# Installs the agentgate binary for this machine into ~/.local/bin.
set -eu

REPO="${AGENTGATE_REPO:?set AGENTGATE_REPO=<owner>/agentgate}"
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
case "$os" in darwin|linux) ;; *) echo "unsupported OS: $os" >&2; exit 1 ;; esac

dest="$HOME/.local/bin"
mkdir -p "$dest"
curl -fsSL "https://github.com/$REPO/releases/latest/download/agentgate-$os-$arch" -o "$dest/agentgate.tmp"
chmod +x "$dest/agentgate.tmp"
mv "$dest/agentgate.tmp" "$dest/agentgate"
echo "installed $dest/agentgate"
case ":$PATH:" in *":$dest:"*) ;; *) echo "add $dest to your PATH" ;; esac
