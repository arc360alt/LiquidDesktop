#!/bin/sh
# Runs the real LiquidDesktop session (window manager + compositor + Linux apps) inside a window.
#   tools/nested.sh [WIDTHxHEIGHT]
# On Wayland this uses rootful Xwayland, which renders on your GPU (fast). Otherwise it falls back to
# Xephyr, which only has software rendering, so expect it to be slow there.
HERE="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
SIZE="${1:-1440x900}"
N=7
while [ -e /tmp/.X$N-lock ] || [ -e /tmp/.X11-unix/X$N ]; do N=$((N+1)); done
D=:$N
if [ -n "$WAYLAND_DISPLAY" ] && command -v Xwayland >/dev/null && [ "$LIQUID_NESTED" != xephyr ]; then
  Xwayland $D -geometry "$SIZE" -decorate -ac &
else
  command -v Xephyr >/dev/null || { echo "Need Xwayland (on Wayland) or Xephyr to run a nested session"; exit 1; }
  Xephyr $D -screen "$SIZE" -no-host-grab -title "LiquidDesktop (nested session)" -ac -glamor &
fi
XPID=$!
sleep 1.5
# software OpenGL (llvmpipe) means no GPU: use picom's cheapest settings
if DISPLAY=$D glxinfo -B 2>/dev/null | grep -i "renderer string" | grep -qi llvmpipe; then
  DEFAULT_PICOM="--backend xrender --blur-method box --blur-size 5 --no-fading-openclose --shadow-radius 12"
else
  DEFAULT_PICOM=""
fi
# you are already logged in, so the nested session skips the login screen
DISPLAY=$D LIQUID_SKIP_LOGIN=1 LIQUID_PICOM_ARGS="${LIQUID_PICOM_ARGS:-$DEFAULT_PICOM}" DBUS_SESSION_BUS_ADDRESS= "$HERE/session/liquid-desktop-session"
kill $XPID 2>/dev/null
