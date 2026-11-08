#!/bin/sh
# Adds "LiquidDesktop" to your display manager's session list (needs sudo).
set -e
HERE="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
chmod +x "$HERE/session/liquid-desktop-session" "$HERE/session/liquid-desktop-session-inner"
sed "s|@HERE@|$HERE|g" "$HERE/session/liquid-desktop.desktop.in" > /tmp/liquid-desktop.desktop
sudo install -Dm644 /tmp/liquid-desktop.desktop /usr/share/xsessions/liquid-desktop.desktop
echo "Installed /usr/share/xsessions/liquid-desktop.desktop — pick “LiquidDesktop” on your login screen."
