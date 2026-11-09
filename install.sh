#!/bin/sh
# LiquidDesktop installer.
#
#   curl -fsSL https://raw.githubusercontent.com/arc360alt/LiquidDesktop/main/install.sh | sh
#
# Detects your distro and installs LiquidDesktop with its dependencies so "LiquidDesktop" appears on
# your login screen:
#   • Arch, Manjaro, EndeavourOS, CachyOS, Garuda… → builds the liquid-desktop-git package
#     (with yay or paru if you have one, otherwise makepkg)
#   • Debian, Ubuntu, Mint, Pop!_OS…               → apt  + install to /opt/liquid-desktop
#   • Fedora, Nobara…                               → dnf  + install to /opt/liquid-desktop
#   • openSUSE                                      → zypper + install to /opt/liquid-desktop
#
# Options (after `sh -s --` when piping, e.g. `curl … | sh -s -- --uninstall`):
#   --update      update an existing install to the latest version (same as installing again)
#   --uninstall   remove LiquidDesktop
#   --minimal     skip the optional Control Center helpers (Wi-Fi, volume, brightness, Bluetooth, media)
#   --dry-run     only print what would be done
# Environment: LIQUID_REPO (git URL), LIQUID_BRANCH (default: main), LIQUID_DISTRO (force arch|debian|fedora|suse)
# Everything runs inside main(), so when this script is piped from curl the shell reads all of it
# before running anything (no half-run installs, no "failure writing output" from curl).
main() {
set -e

REPO="${LIQUID_REPO:-https://github.com/arc360alt/LiquidDesktop.git}"
BRANCH="${LIQUID_BRANCH:-main}"
PREFIX=/opt/liquid-desktop
ACTION=install MINIMAL="${LIQUID_MINIMAL:-}" DRY=""
for a in "$@"; do
  case "$a" in
    --uninstall|uninstall) ACTION=uninstall ;;
    --update|update|--upgrade) ACTION=update ;;
    --minimal) MINIMAL=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,22p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "liquid-desktop installer: ignoring unknown option $a" >&2 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ -n "$DRY" ]; then printf '    $ %s\n' "$*"; else "$@"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" -eq 0 ] && die "Run this as your normal user, not root — it asks for sudo when it needs it."
have sudo || die "sudo is required. Install it and add your user to the wheel/sudo group first."

# ---------------------------------------------------------------- detect the distro
[ -r /etc/os-release ] || die "Can't detect your Linux distribution (/etc/os-release is missing)."
. /etc/os-release
FAMILY=""
for id in $ID $ID_LIKE; do
  case "$id" in
    arch|archlinux|manjaro|endeavouros|cachyos|garuda|artix) FAMILY=arch; break ;;
    debian|ubuntu|linuxmint|pop|elementary|zorin|kali|raspbian) FAMILY=debian; break ;;
    fedora|rhel|centos|nobara|ultramarine) FAMILY=fedora; break ;;
    opensuse*|suse|sles) FAMILY=suse; break ;;
  esac
done
[ -n "$LIQUID_DISTRO" ] && FAMILY="$LIQUID_DISTRO"   # override, e.g. for testing: arch | debian | fedora | suse
[ -n "$FAMILY" ] || die "Sorry, ${PRETTY_NAME:-this distro} isn't supported by the installer yet. See the README to install by hand."
say "Detected ${PRETTY_NAME:-$ID} ($FAMILY)${DRY:+ — dry run, nothing will be changed}"
[ "$ACTION" = update ] && say "Updating LiquidDesktop to the latest version…"

AUR_HELPER=""
for h in yay paru; do have "$h" && { AUR_HELPER="$h"; break; }; done

# ---------------------------------------------------------------- uninstall
if [ "$ACTION" = uninstall ]; then
  if [ "$FAMILY" = arch ] && pacman -Q liquid-desktop-git >/dev/null 2>&1; then
    say "Removing the liquid-desktop-git package…"
    run sudo pacman -Rns --noconfirm liquid-desktop-git
  fi
  if [ -d "$PREFIX" ]; then
    say "Removing $PREFIX…"
    run sudo rm -rf "$PREFIX"
    run sudo rm -f /usr/local/bin/liquid-desktop /usr/local/bin/liquid-desktop-session /usr/local/bin/liquid-desktop-nested /usr/local/bin/liquid-desktop-update \
      /usr/share/xsessions/liquid-desktop.desktop /usr/share/applications/liquid-desktop.desktop
  fi
  say "LiquidDesktop has been removed. (Your settings stay in ~/.config/LiquidDesktop.)"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fetch() {
  say "Downloading LiquidDesktop ($BRANCH) from $REPO…"
  run git clone --depth 1 --branch "$BRANCH" "$REPO" "$WORK/LiquidDesktop"
}

# ---------------------------------------------------------------- Arch family: a real package
install_arch() {
  say "Installing build tools…"
  run sudo pacman -S --needed --noconfirm git base-devel
  fetch
  if [ -n "$AUR_HELPER" ]; then
    say "Building and installing the package with $AUR_HELPER…"
    run env LIQUID_REPO="$REPO#branch=$BRANCH" "$AUR_HELPER" -Bi --noconfirm "$WORK/LiquidDesktop/packaging/arch"
  else
    say "Building and installing the package with makepkg (no yay/paru found)…"
    [ -n "$DRY" ] && printf '    $ cd %s\n' "$WORK/LiquidDesktop/packaging/arch"
    [ -z "$DRY" ] && cd "$WORK/LiquidDesktop/packaging/arch"
    run env LIQUID_REPO="$REPO#branch=$BRANCH" makepkg -si --noconfirm --needed
  fi
  if [ -z "$MINIMAL" ]; then
    say "Installing Control Center helpers…"
    run sudo pacman -S --needed --noconfirm --asdeps networkmanager wireplumber brightnessctl bluez-utils playerctl upower xorg-xwayland mesa-utils flatpak pacman-contrib archlinux-appstream-data xorg-xinput || true
  fi
  BIN=/usr/bin
}

# ---------------------------------------------------------------- other distros: /opt install
install_generic() {
  case "$FAMILY" in
    debian)
      say "Installing dependencies with apt…"
      run sudo apt-get update
      run sudo apt-get install -y git nodejs npm picom python3 xdg-utils xserver-xorg-core x11-xserver-utils xsettingsd \
        libnss3 libgtk-3-0 libgbm1 libxss1 libxtst6 libatk-bridge2.0-0 libdrm2
      # the ALSA library was renamed on newer Ubuntu/Debian
      run sudo apt-get install -y libasound2t64 2>/dev/null || run sudo apt-get install -y libasound2
      [ -z "$MINIMAL" ] && { run sudo apt-get install -y network-manager wireplumber brightnessctl bluez playerctl upower mesa-utils flatpak || true; }
      ;;
    fedora)
      say "Installing dependencies with dnf…"
      run sudo dnf install -y git nodejs npm picom python3 xdg-utils xorg-x11-server-Xorg xrdb xsettingsd nss gtk3 mesa-libgbm alsa-lib libXScrnSaver libXtst
      [ -z "$MINIMAL" ] && { run sudo dnf install -y NetworkManager wireplumber brightnessctl bluez playerctl upower glx-utils flatpak || true; }
      ;;
    suse)
      say "Installing dependencies with zypper…"
      run sudo zypper --non-interactive install git nodejs npm picom python3 xdg-utils xorg-x11-server mozilla-nss gtk3-tools libgtk-3-0 libgbm1 alsa
      [ -z "$MINIMAL" ] && { run sudo zypper --non-interactive install NetworkManager wireplumber brightnessctl bluez playerctl upower Mesa-demo-x flatpak || true; }
      ;;
  esac
  fetch
  say "Installing JavaScript dependencies and Electron (this takes a minute)…"
  if [ -z "$DRY" ]; then (cd "$WORK/LiquidDesktop" && npm ci --no-audit --no-fund); else printf '    $ (cd %s && npm ci)\n' "$WORK/LiquidDesktop"; fi
  say "Installing to $PREFIX…"
  run sudo rm -rf "$PREFIX"
  run sudo mkdir -p "$PREFIX"
  run sudo cp -r "$WORK/LiquidDesktop/." "$PREFIX/"
  if [ -z "$DRY" ]; then git -C "$WORK/LiquidDesktop" rev-parse HEAD | sudo tee "$PREFIX/.liquid-version" >/dev/null; fi
  run sudo rm -rf "$PREFIX/.git"
  # Electron's sandbox helper must be owned by root and setuid
  run sudo chown root:root "$PREFIX/node_modules/electron/dist/chrome-sandbox"
  run sudo chmod 4755 "$PREFIX/node_modules/electron/dist/chrome-sandbox"
  run sudo ln -sf "$PREFIX/session/liquid-desktop" /usr/local/bin/liquid-desktop
  run sudo ln -sf "$PREFIX/session/liquid-desktop-session" /usr/local/bin/liquid-desktop-session
  run sudo ln -sf "$PREFIX/tools/nested.sh" /usr/local/bin/liquid-desktop-nested
  run sudo ln -sf "$PREFIX/session/liquid-desktop-update" /usr/local/bin/liquid-desktop-update
  say "Adding LiquidDesktop to the login screen…"
  if [ -z "$DRY" ]; then
    sed "s#/usr/bin/#/usr/local/bin/#g" "$WORK/LiquidDesktop/packaging/liquid-desktop.xsession.desktop" > "$WORK/xsession.desktop"
    sudo install -Dm644 "$WORK/xsession.desktop" /usr/share/xsessions/liquid-desktop.desktop
    sudo install -Dm644 "$WORK/LiquidDesktop/packaging/liquid-desktop.desktop" /usr/share/applications/liquid-desktop.desktop
  else
    printf '    $ sudo install … /usr/share/xsessions/liquid-desktop.desktop\n'
  fi
  BIN=/usr/local/bin
}

if [ "$FAMILY" = arch ]; then install_arch; else install_generic; fi

# ---------------------------------------------------------------- next steps
DM=""
for d in sddm gdm gdm3 lightdm ly lxdm greetd; do
  systemctl is-enabled "$d.service" >/dev/null 2>&1 && { DM="$d"; break; }
done
echo
if [ "$ACTION" = update ]; then
  say "LiquidDesktop is up to date."
  echo "    Log out and back in (or restart LiquidDesktop) to use the new version."
  exit 0
fi
say "LiquidDesktop is installed."
if [ -n "$DM" ]; then
  echo "    Log out, then pick “LiquidDesktop” in the session menu of your login screen ($DM)."
else
  echo "    No login screen (display manager) is enabled. Either:"
  case "$FAMILY" in
    arch)   echo "      • sudo pacman -S sddm && sudo systemctl enable sddm   — then reboot and pick LiquidDesktop" ;;
    debian) echo "      • sudo apt install sddm && sudo systemctl enable sddm — then reboot and pick LiquidDesktop" ;;
    fedora) echo "      • sudo dnf install sddm && sudo systemctl enable sddm — then reboot and pick LiquidDesktop" ;;
    suse)   echo "      • sudo zypper install sddm && sudo systemctl enable sddm — then reboot and pick LiquidDesktop" ;;
  esac
  echo "      • or start it from a TTY with startx:  echo 'exec $BIN/liquid-desktop-session' > ~/.xinitrc && startx"
fi
echo "    Try it in a window:  liquid-desktop        Full session in a window:  liquid-desktop-nested"
echo "    Remove it later:     curl -fsSL https://raw.githubusercontent.com/arc360alt/LiquidDesktop/main/install.sh | sh -s -- --uninstall"
}

main "$@"
