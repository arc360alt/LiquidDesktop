#!/bin/sh
# Downloads the "MacOS Tahoe Cursor" theme (by MOYASH, packaged at github.com/witt-bit/MacOS-Tahoe-Cursor)
# into session/cursors/MacOS-Tahoe-Cursor — LiquidDesktop's default cursors.
# The theme is CC BY-NC-ND: it is fetched from its official release and installed unmodified, never
# committed to this repository. Runs from `npm install` (postinstall); never fails the install.
VERSION=1.2
URL="https://github.com/witt-bit/MacOS-Tahoe-Cursor/releases/download/$VERSION/MacOS-Tahoe-Cursor.zip"
SHA256=684b80296a0419597f7efeb5c80d3d9527f8a6639d0d98a498e62ed8fa8d8e12

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HERE/session/cursors/MacOS-Tahoe-Cursor"
[ -f "$DEST/.version" ] && [ "$(cat "$DEST/.version")" = "$VERSION" ] && exit 0

TMP="$(mktemp -d)" || exit 0
trap 'rm -rf "$TMP"' EXIT
if [ -n "$LIQUID_CURSOR_ZIP" ]; then cp "$LIQUID_CURSOR_ZIP" "$TMP/c.zip"   # already downloaded (PKGBUILD source)
elif command -v curl >/dev/null; then curl -fsSL -o "$TMP/c.zip" "$URL"
elif command -v wget >/dev/null; then wget -qO "$TMP/c.zip" "$URL"
fi
if [ ! -s "$TMP/c.zip" ]; then echo "liquid-desktop: couldn't download the macOS Tahoe cursors (offline?) — using the built-in ones" >&2; exit 0; fi
if [ "$(sha256sum "$TMP/c.zip" | cut -d' ' -f1)" != "$SHA256" ]; then echo "liquid-desktop: cursor download didn't match its checksum — skipped" >&2; exit 0; fi

# extract only the theme folder (and the creator's ReadMe), refusing any path that leaves it
python3 -I - "$TMP/c.zip" "$TMP/out" <<'EOF' || exit 0
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
root = 'MacOS-Tahoe-Cursor/MacOS-Tahoe-Cursor/'
with zipfile.ZipFile(src) as z:
    for i in z.infolist():
        n = i.filename
        if n == 'MacOS-Tahoe-Cursor/ReadMe.txt': rel = 'ReadMe.txt'
        elif n.startswith(root) and not i.is_dir(): rel = n[len(root):]
        else: continue
        dest = os.path.realpath(os.path.join(out, rel))
        if not dest.startswith(os.path.realpath(out) + os.sep): continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with z.open(i) as f, open(dest, 'wb') as g: g.write(f.read())
EOF
[ -f "$TMP/out/index.theme" ] && [ -d "$TMP/out/cursors" ] || exit 0
echo "$VERSION" > "$TMP/out/.version"
rm -rf "$DEST" && mkdir -p "$(dirname "$DEST")" && cp -r "$TMP/out" "$DEST" && echo "Installed the macOS Tahoe cursors (by MOYASH)"
exit 0
