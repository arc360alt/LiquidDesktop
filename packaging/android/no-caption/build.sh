#!/bin/sh
# Builds LiquidNoCaption.apk (the prebuilt copy is in packaging/android/). Needs the Android SDK build tools
# (aapt2, zipalign, apksigner) and an SDK platform. Usage: packaging/android/no-caption/build.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:-/opt/android-sdk}"
JAR="$(ls -d "$SDK"/platforms/android-*/android.jar | sort -V | tail -1)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
aapt2 compile --dir "$HERE/res" -o "$W/res.zip"
aapt2 link -o "$W/unsigned.apk" -I "$JAR" --manifest "$HERE/AndroidManifest.xml" --min-sdk-version 30 --target-sdk-version 33 "$W/res.zip"
zipalign -f 4 "$W/unsigned.apk" "$W/aligned.apk"
# any key works for an overlay preinstalled in the system image; one is kept next to this script so later
# builds are signed the same way
KS="$HERE/overlay.keystore"
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass liquiddesktop -keypass liquiddesktop -alias overlay \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=LiquidDesktop Android overlay" >/dev/null 2>&1
apksigner sign --ks "$KS" --ks-pass pass:liquiddesktop --key-pass pass:liquiddesktop --out "$HERE/../LiquidNoCaption.apk" "$W/aligned.apk"
echo "built $HERE/../LiquidNoCaption.apk"
