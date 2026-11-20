#!/bin/sh
# A "phone" for testing Settings › Phone, the Phone widgets and Control Center without a real phone:
# starts two KDE Connect daemons, each on its own private D-Bus, pairs them, and prints how to point
# LiquidDesktop at the first one. The second daemon plays the phone (it's a computer, so it reports this
# machine's battery). A tiny notification server on the phone's bus lets you send it "phone notifications".
#   tools/fake-phone.sh android   one daemon + a pretend Android phone (tools/fake-android.js) with texts,
#                                 contacts, calls, music… — for Messages, Contacts and Phone. Paired for you.
#   tools/fake-phone.sh start     start + pair, prints the DBUS_SESSION_BUS_ADDRESS to use
#   tools/fake-phone.sh notify "Title" "Text" [App]    a notification on the phone (shows up on the computer side)
#   tools/fake-phone.sh stop
# Then e.g.: env -u ELECTRON_RUN_AS_NODE DBUS_SESSION_BUS_ADDRESS=<printed> SHOT_PROFILE=/tmp/p electron tools/shot.js out steps.json
# Uses the installed kdeconnectd, or one extracted from a package: KDC_ROOT=<dir with usr/bin/kdeconnectd>.
# Note: both daemons announce themselves on your LAN while running, and "Find My Phone" makes this computer ring.
set -e
HERE="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
DIR="${XDG_RUNTIME_DIR:-/tmp}/liquid-fake-phone"
ROOT="${KDC_ROOT:-}"
KDCD="$ROOT/usr/bin/kdeconnectd"; [ -x "$KDCD" ] || KDCD="$(command -v kdeconnectd || true)"
[ -x "$KDCD" ] || KDCD=/usr/lib/kdeconnectd
bus() { cat "$DIR/bus$1"; }
devpath() { DBUS_SESSION_BUS_ADDRESS="$(bus "$1")" busctl --user tree org.kde.kdeconnect --list 2>/dev/null | grep 'devices/[^/]*$' | head -1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || for E in "$LIQUID_ELECTRON" "$HERE/node_modules/electron/dist/electron" "$(command -v electron43 || true)" "$(command -v electron || true)"; do if [ -n "$E" ] && [ -x "$E" ]; then NODE="$E"; break; fi; done

case "$1" in
android)
  [ -x "$KDCD" ] || { echo "kdeconnectd not found: install kdeconnect, or set KDC_ROOT"; exit 1; }
  [ -n "$NODE" ] || { echo "needs node (or Electron)"; exit 1; }
  mkdir -p "$DIR/cfg1" "$DIR/rt1"; chmod 700 "$DIR/rt1"
  (
    eval "$(dbus-launch --sh-syntax)"
    echo "$DBUS_SESSION_BUS_ADDRESS" > "$DIR/bus1"; echo "$DBUS_SESSION_BUS_PID" > "$DIR/dbuspid1"
    export XDG_CONFIG_HOME="$DIR/cfg1" XDG_DATA_HOME="$DIR/cfg1/data" XDG_RUNTIME_DIR="$DIR/rt1" QT_QPA_PLATFORM=offscreen
    [ -n "$ROOT" ] && export LD_LIBRARY_PATH="$ROOT/usr/lib" QT_PLUGIN_PATH="$ROOT/usr/lib/qt6/plugins"
    QT_LOGGING_RULES="kdeconnect.*=true" QT_FORCE_STDERR_LOGGING=1 setsid "$KDCD" > "$DIR/kdc1.log" 2>&1 &
    echo $! > "$DIR/pid1"
  )
  sleep 2
  ELECTRON_RUN_AS_NODE=1 setsid "$NODE" "$HERE/tools/fake-android.js" > "$DIR/android.log" 2>&1 &
  echo $! > "$DIR/stubpid"
  printf 'pairing'
  ID="$(cat "${XDG_RUNTIME_DIR:-/tmp}/liquid-fake-android/id" 2>/dev/null)"
  for _ in $(seq 20); do
    ID="$(cat "${XDG_RUNTIME_DIR:-/tmp}/liquid-fake-android/id" 2>/dev/null)"
    S="$(DBUS_SESSION_BUS_ADDRESS="$(bus 1)" busctl --user get-property org.kde.kdeconnect "/modules/kdeconnect/devices/$ID" org.kde.kdeconnect.device pairState 2>/dev/null | cut -d' ' -f2)"
    [ "$S" = 3 ] && break
    [ "$S" = 2 ] && DBUS_SESSION_BUS_ADDRESS="$(bus 1)" busctl --user call org.kde.kdeconnect "/modules/kdeconnect/devices/$ID" org.kde.kdeconnect.device acceptPairing
    printf .; sleep 1
  done; echo
  echo "the phone is paired. Run LiquidDesktop with:"
  echo "  DBUS_SESSION_BUS_ADDRESS=$(bus 1) XDG_DATA_HOME=$DIR/cfg1/data"
  echo "phone log: $DIR/android.log   send it things: echo 'sms +1_555_0101 hello' > ${XDG_RUNTIME_DIR:-/tmp}/liquid-fake-android/control"
  ;;
start)
  [ -x "$KDCD" ] || { echo "kdeconnectd not found: install kdeconnect, or set KDC_ROOT"; exit 1; }
  mkdir -p "$DIR"
  for N in 1 2; do
    mkdir -p "$DIR/cfg$N" "$DIR/rt$N"; chmod 700 "$DIR/rt$N"
    (
      eval "$(dbus-launch --sh-syntax)"
      echo "$DBUS_SESSION_BUS_ADDRESS" > "$DIR/bus$N"; echo "$DBUS_SESSION_BUS_PID" > "$DIR/dbuspid$N"
      export XDG_CONFIG_HOME="$DIR/cfg$N" XDG_DATA_HOME="$DIR/cfg$N/data" XDG_RUNTIME_DIR="$DIR/rt$N" QT_QPA_PLATFORM=offscreen
      [ -n "$ROOT" ] && export LD_LIBRARY_PATH="$ROOT/usr/lib" QT_PLUGIN_PATH="$ROOT/usr/lib/qt6/plugins"
      setsid "$KDCD" > "$DIR/kdc$N.log" 2>&1 &
      echo $! > "$DIR/pid$N"
    )
    sleep 1
  done
  printf 'waiting for the daemons to find each other'
  for _ in $(seq 20); do [ -n "$(devpath 1)" ] && [ -n "$(devpath 2)" ] && break; printf .; sleep 1; done; echo
  D1="$(devpath 1)"; D2="$(devpath 2)"
  [ -n "$D1" ] && [ -n "$D2" ] || { echo "they didn't find each other (firewall on UDP/TCP 1716?)"; exit 1; }
  DBUS_SESSION_BUS_ADDRESS="$(bus 1)" busctl --user call org.kde.kdeconnect "$D1" org.kde.kdeconnect.device requestPairing
  sleep 1
  DBUS_SESSION_BUS_ADDRESS="$(bus 2)" busctl --user call org.kde.kdeconnect "$D2" org.kde.kdeconnect.device acceptPairing
  # the phone forwards its notifications (needs a notification server on its bus to see them)
  DBUS_SESSION_BUS_ADDRESS="$(bus 2)" busctl --user call org.kde.kdeconnect "$D2" org.kde.kdeconnect.device setPluginEnabled sb kdeconnect_sendnotifications true
  if [ -n "$NODE" ]; then
    cat > "$DIR/notify-stub.js" <<EOF
const dbus = require('$HERE/node_modules/dbus-next');
class N extends dbus.interface.Interface { Notify() { return 1; } GetCapabilities() { return ['body']; } GetServerInformation() { return ['stub', 'x', '1', '1.2']; } CloseNotification() {} }
N.configureMembers({ methods: { Notify: { inSignature: 'susssasa{sv}i', outSignature: 'u' }, GetCapabilities: { outSignature: 'as' }, GetServerInformation: { outSignature: 'ssss' }, CloseNotification: { inSignature: 'u' } } });
const b = dbus.sessionBus(); b.requestName('org.freedesktop.Notifications', 4).then(() => b.export('/org/freedesktop/Notifications', new N('org.freedesktop.Notifications')));
EOF
    DBUS_SESSION_BUS_ADDRESS="$(bus 2)" ELECTRON_RUN_AS_NODE=1 setsid "$NODE" "$DIR/notify-stub.js" > /dev/null 2>&1 &
    echo $! > "$DIR/stubpid"
  fi
  sleep 2
  echo "paired. Point LiquidDesktop at the computer side with:"
  echo "  DBUS_SESSION_BUS_ADDRESS=$(bus 1)"
  ;;
notify)
  if [ -e "${XDG_RUNTIME_DIR:-/tmp}/liquid-fake-android/control" ] && [ -e "$DIR/stubpid" ] && [ ! -e "$DIR/bus2" ]; then
    echo "notify ${4:-Messages} ${2:-Hello} ${3:-From your phone}" > "${XDG_RUNTIME_DIR:-/tmp}/liquid-fake-android/control"; exit 0
  fi
  DBUS_SESSION_BUS_ADDRESS="$(bus 2)" timeout 3 notify-send -a "${4:-Messages}" "${2:-Hello}" "${3:-From your phone}"
  ;;
stop)
  for F in pid1 pid2 stubpid dbuspid1 dbuspid2; do [ -e "$DIR/$F" ] && kill "$(cat "$DIR/$F")" 2>/dev/null || true; rm -f "$DIR/$F"; done
  rm -f "$DIR/bus1" "$DIR/bus2"
  true
  echo stopped
  ;;
*) sed -n '2,12p' "$0"; exit 2 ;;
esac
