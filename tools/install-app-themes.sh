#!/bin/sh
# Installs the MacTahoe app themes for the current user (no root needed):
#   • GTK: MacTahoe (MIT) by vinceliuice — prebuilt Dark and Light themes → ~/.local/share/themes
#   • Qt:  the Kvantum theme from MacTahoe-kde (LGPL-3.0) by vinceliuice → ~/.config/Kvantum
# Only the Kvantum part of MacTahoe-kde is used; its Plasma look-and-feel is not installed, so a KDE
# session on the same account stays as it is. Run by LiquidDesktop on first login or from
# Settings › Appearance; safe to run again (it replaces the previous copy).
set -e
GTK_REF=2026-09-10
KDE_REF=cbf6a1f71b591d143184855d62f6272ce533e7c3
THEMES="${XDG_DATA_HOME:-$HOME/.local/share}/themes"
KVANTUM="${XDG_CONFIG_HOME:-$HOME/.config}/Kvantum"
MARK="$THEMES/.liquid-mactahoe"
[ "$1" != "--force" ] && [ -f "$MARK" ] && [ "$(cat "$MARK")" = "$GTK_REF $KDE_REF" ] && { echo "MacTahoe themes are up to date"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
get() { if command -v curl >/dev/null; then curl -fsSL -o "$2" "$1"; else wget -qO "$2" "$1"; fi; }
echo "Downloading MacTahoe GTK theme…"
get "https://github.com/vinceliuice/MacTahoe-gtk-theme/archive/refs/tags/$GTK_REF.tar.gz" "$TMP/gtk.tgz"
echo "Downloading MacTahoe Kvantum theme…"
get "https://github.com/vinceliuice/MacTahoe-kde/archive/$KDE_REF.tar.gz" "$TMP/kde.tgz"

mkdir -p "$TMP/g" "$TMP/k" "$THEMES" "$KVANTUM"
tar xzf "$TMP/gtk.tgz" -C "$TMP/g" --strip-components=1 --no-same-owner
tar xzf "$TMP/kde.tgz" -C "$TMP/k" --strip-components=1 --no-same-owner

# GTK: the prebuilt variants (the project ships no plain Light build, so Light is the "solid" one)
for v in MacTahoe-Dark MacTahoe-Light-solid; do
  [ -f "$TMP/g/release/$v.tar.xz" ] || { echo "missing $v in the GTK release" >&2; exit 1; }
  rm -rf "$THEMES/$v"
  tar xJf "$TMP/g/release/$v.tar.xz" -C "$THEMES" --no-same-owner
done

# Kvantum (Qt): MacTahoe and MacTahoeDark live in one folder
[ -d "$TMP/k/Kvantum/MacTahoe" ] || { echo "missing the Kvantum theme" >&2; exit 1; }
rm -rf "$KVANTUM/MacTahoe"
cp -r "$TMP/k/Kvantum/MacTahoe" "$KVANTUM/MacTahoe"
cp "$TMP/g/COPYING" "$THEMES/MacTahoe-Dark/LICENSE-MacTahoe-gtk" 2>/dev/null || true
cp "$TMP/k/LICENSE" "$KVANTUM/MacTahoe/LICENSE-MacTahoe-kde" 2>/dev/null || true

# GTK 4 / libadwaita: MacTahoe's own "--libadwaita" build (it needs sassc). Their script writes straight into
# ~/.config/gtk-4.0, so it runs with a throwaway HOME and the result is kept in LIBADW; LiquidDesktop puts
# it into ~/.config/gtk-4.0 only while that's switched on (Settings › Appearance › App Themes).
LIBADW="$THEMES/MacTahoe-libadwaita"
rm -rf "$LIBADW"; mkdir -p "$LIBADW"
OUT="$TMP/home/.config/gtk-4.0"
if command -v sassc >/dev/null; then
  echo "Building the GTK 4 / libadwaita version…"
  mkdir -p "$TMP/home" "$TMP/dest"
  ( cd "$TMP/g" && HOME="$TMP/home" bash ./install.sh -l -c light -d "$TMP/dest" </dev/null >"$TMP/libadw.log" 2>&1 ) || true
fi
if [ -f "$OUT/gtk-Light.css" ] && [ -f "$OUT/gtk-Dark.css" ]; then
  cp "$OUT/gtk-Light.css" "$OUT/gtk-Dark.css" "$LIBADW/"
  cp -r "$OUT/assets" "$OUT/windows-assets" "$LIBADW/"
else
  # no sassc (or the build failed): the prebuilt GTK 4 styles of the two variants
  cp "$THEMES/MacTahoe-Light-solid/gtk-4.0/gtk.css" "$LIBADW/gtk-Light.css"
  cp "$THEMES/MacTahoe-Dark/gtk-4.0/gtk.css" "$LIBADW/gtk-Dark.css"
  for v in MacTahoe-Light-solid MacTahoe-Dark; do
    for d in assets windows-assets; do mkdir -p "$LIBADW/$d" && cp -r "$THEMES/$v/gtk-4.0/$d/." "$LIBADW/$d/"; done
  done
  echo "(GTK 4 / libadwaita: using the prebuilt styles; install sassc for MacTahoe's libadwaita build)"
fi

echo "$GTK_REF $KDE_REF" > "$MARK"
echo "Installed the MacTahoe GTK and Kvantum themes"
