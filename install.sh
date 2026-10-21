#!/usr/bin/env bash
# Symlink the extension into the user's GNOME Shell extensions dir and enable it.
set -euo pipefail
UUID="ai-usage@paradas.co"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  echo "$DEST exists and is not a symlink; remove it first." >&2
  exit 1
fi
ln -sfn "$SRC" "$DEST"
echo "Linked $DEST -> $SRC"

if gnome-extensions enable "$UUID" 2>/dev/null; then
  echo "Enabled $UUID"
else
  echo "GNOME Shell has not seen the extension yet."
  echo "On Wayland: log out and back in, then run: gnome-extensions enable $UUID"
fi
