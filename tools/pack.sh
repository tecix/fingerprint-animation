#!/bin/sh
# Build the zip to upload to https://extensions.gnome.org/upload/
#   tools/pack.sh   ->  dist/fingerprint-animation@tecix.shell-extension.zip
set -eu
cd "$(dirname "$0")/.."
UUID=fingerprint-animation@tecix
mkdir -p dist
cp LICENSE "$UUID/LICENSE"
trap 'rm -f "$UUID/LICENSE"' EXIT
gnome-extensions pack "$UUID" \
    --extra-source=glyph.js \
    --extra-source=LICENSE \
    --out-dir=dist --force
echo "Built dist/$UUID.shell-extension.zip:"
unzip -l "dist/$UUID.shell-extension.zip"
