#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# build-harness.sh — build only the QEMU EspHarness test app (not part of the ABL image).
set -eo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
"$HERE/tools/mktoolbin.sh"
cd "$HERE/edk2"
export PATH="$HERE/toolbin:$HERE/edk2/obj/ABL_OBJ/Build/Source/C/bin:$PATH"
export CLANG35_BIN="$HERE/toolbin/" CLANG35_AARCH64_PREFIX=aarch64-linux-gnu- CLANG35_GCC_TOOLCHAIN=/usr
export CLANG_EXTRA_DLINK_FLAGS="-Wl,--no-relax -Wl,--apply-dynamic-relocs"
export FUSE_LD="$HERE/toolbin/ld.lld" EXTRA_GCC_ARG= WRAPPER= MAKEPATH=
. ./edksetup.sh BaseTools >/dev/null
mkdir -p "$HERE/logs"   # build.py hangs, instead of failing, when it cannot open its -j log
export PATH="$HERE/edk2/obj/ABL_OBJ/Build/Source/C/bin:$PATH"
build -p QcomModulePkg/QcomModulePkg.dsc -a AARCH64 -t CLANG35 -b DEBUG \
  -m QcomModulePkg/Application/EspHarness/EspHarness.inf \
  -D ABL_OUT_DIR="$PWD/obj/HARNESS/Build" -D ESP_HARNESS=TRUE \
  -D VERIFIED_BOOT_ENABLED=1 -D USER_BUILD_VARIANT=0 -D BUILD_USES_RECOVERY_AS_BOOT=1 \
  -D INIT_BIN=/sbin/init -j "$HERE/logs/harness-build.log" 2>&1 | tail -5
find "$PWD/obj/HARNESS" -name EspHarness.efi -path '*DEBUG*' | head -1
