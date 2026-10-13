#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# build-vendor.sh — rebuild web/vendor/ from pinned upstream commits.
#   fastboot.min.mjs  kdrag0n/fastboot.js (MIT), its committed dist/ build
#   edl-qdl.mjs       web/src/edl-qdl.js bundled with commaai/qdl.js (MIT) and its
#                     dependencies, by bun
#   adb.mjs           web/src/adb-web.js bundled with Tango's ya-webadb (MIT), the
#                     versions locked in web/src/adb/package-lock.json, by bun
# Needs git and bun. The output is committed; CI checks it is up to date.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FASTBOOT_JS=5b613332aa9d66cca5bebb49f147cd084a76c464   # android-fastboot 1.1.3
QDL_JS=d1e0683d3f66c6cb49b8ba07b03887b99c12dae6
W="$HERE/.vendor-work"; OUT="$HERE/vendor"
mkdir -p "$W" "$OUT"

fetch() { # dir url commit
  [ -d "$W/$1/.git" ] || git clone -q "$2" "$W/$1"
  git -C "$W/$1" fetch -q origin "$3" 2>/dev/null || true
  git -C "$W/$1" -c advice.detachedHead=false checkout -q "$3"
}
fetch fastboot.js https://github.com/kdrag0n/fastboot.js "$FASTBOOT_JS"
fetch qdl.js https://github.com/commaai/qdl.js "$QDL_JS"

cp "$W/fastboot.js/dist/fastboot.min.mjs" "$OUT/fastboot.min.mjs"

(cd "$W/qdl.js" && bun install --frozen-lockfile --silent)
mkdir -p "$W/node_modules"; ln -sfn "$W/qdl.js/src" "$W/node_modules/qdl"
cp "$HERE/src/edl-qdl.js" "$W/edl-qdl.js"
(cd "$W" && bun build edl-qdl.js --target=browser --format=esm --minify-syntax --minify-whitespace \
   --outfile "$OUT/edl-qdl.mjs" >/dev/null)

mkdir -p "$W/adb"
cp "$HERE/src/adb/package.json" "$HERE/src/adb/package-lock.json" "$W/adb/"
(cd "$W/adb" && npm ci --silent --no-audit --no-fund)
cp "$HERE/src/adb-web.js" "$W/adb/adb-web.js"
(cd "$W/adb" && bun build adb-web.js --target=browser --format=esm --minify-syntax --minify-whitespace \
   --outfile "$OUT/adb.mjs" >/dev/null)

{
  echo "fastboot.min.mjs: kdrag0n/fastboot.js $FASTBOOT_JS"
  echo "edl-qdl.mjs: web/src/edl-qdl.js + commaai/qdl.js $QDL_JS (bun.lock)"
  echo "adb.mjs: web/src/adb-web.js + @yume-chan/adb 2.6.4, adb-daemon-webusb 2.3.2, adb-credential-web 2.1.0 (web/src/adb/package-lock.json)"
} > "$OUT/SOURCES.txt"
(cd "$OUT" && sha256sum fastboot.min.mjs edl-qdl.mjs adb.mjs >> SOURCES.txt)
cat "$OUT/SOURCES.txt"
