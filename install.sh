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

dest="${AGENTGATE_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$dest"
temp=$(mktemp -d "$dest/.agentgate-install.XXXXXX")
trap 'rm -rf "$temp"' EXIT HUP INT TERM
asset="agentgate-$os-$arch"
# Resolve one release so concurrent releases cannot mix binaries and checksums.
release=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
tag=${release##*/}
base="https://github.com/$REPO/releases/download/$tag"
curl -fsSL "$base/$asset" -o "$temp/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$temp/SHA256SUMS"
expected=$(awk -v asset="$asset" '$2 == asset {print $1}' "$temp/SHA256SUMS")
[ ${#expected} -eq 64 ] || { echo "missing checksum for $asset" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temp/$asset" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$temp/$asset" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || { echo "checksum verification failed" >&2; exit 1; }
chmod +x "$temp/$asset"
mv "$temp/$asset" "$dest/agentgate"
echo "installed $dest/agentgate"
case ":$PATH:" in *":$dest:"*) ;; *) echo "add $dest to your PATH" ;; esac
