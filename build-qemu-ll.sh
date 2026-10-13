#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# build-qemu-ll.sh — LinuxLoader test variant for QEMU/AAVMF: identical sources and
# build defines as build.sh (taken from the CLO makefile dry run), plus QEMU_TEST=TRUE,
# which only swaps DebugLib so DEBUG() reaches the console. Not flashable.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
"$HERE/tools/mktoolbin.sh"
SOC=${1:-sdm845}
cd "$HERE/edk2"
# EDK2 does not track -D define changes (product name, INIT_BIN...): clean when the SoC changes.
STAMP=obj/QEMU/last_soc
if [ "$(cat "$STAMP" 2>/dev/null)" != "$SOC" ]; then
  rm -rf obj/QEMU/Build/DEBUG_CLANG35/AARCH64
fi
mkdir -p obj/QEMU && echo "$SOC" > "$STAMP"
export PATH="$HERE/toolbin:$HERE/edk2/obj/ABL_OBJ/Build/Source/C/bin:$PATH"
MKVARS=(BOOTLOADER_OUT="$PWD/obj/ABL_OBJ" CLANG_BIN="$HERE/toolbin/" CLANG_PREFIX=aarch64-linux-gnu-
  CLANG35_GCC_TOOLCHAIN=/usr TARGET_ARCHITECTURE=AARCH64 BOARD_BOOTLOADER_PRODUCT_NAME="$SOC"
  VERIFIED_BOOT_ENABLED=1 BUILD_USES_RECOVERY_AS_BOOT=1 USER_BUILD_VARIANT=0
  DYNAMIC_PARTITION_SUPPORT=1 VIRTUAL_AB_OTA=1 INIT_BIN=$([ "$SOC" = sdm845 ] && echo /init || echo /sbin/init)
  USERDATAIMAGE_FILE_SYSTEM_TYPE=ext4 LOAD_ADDRESS=0x9FA00000
  DISABLE_KERNEL_PROTOCOL=$(case "$SOC" in sdm845|sm8250) echo 1;; *) echo 0;; esac))
mapfile -t DEFS < <(make -n ABL_FV_IMG "${MKVARS[@]}" 2>/dev/null | tr '\\' '\n' \
  | grep -oE '\-D [A-Z0-9_]+=[^ ]*' | grep -v 'ABL_OUT_DIR=' | sed 's/^-D //')
ARGS=(); for d in "${DEFS[@]}"; do ARGS+=(-D "$d"); done
export CLANG35_BIN="$HERE/toolbin/" CLANG35_AARCH64_PREFIX=aarch64-linux-gnu- CLANG35_GCC_TOOLCHAIN=/usr
export CLANG_EXTRA_DLINK_FLAGS="-Wl,--no-relax -Wl,--apply-dynamic-relocs"
export FUSE_LD="$HERE/toolbin/ld.lld" EXTRA_GCC_ARG= WRAPPER= MAKEPATH= BOARD_BOOTLOADER_PRODUCT_NAME="$SOC"
. ./edksetup.sh BaseTools >/dev/null
mkdir -p "$HERE/logs"   # build.py hangs, instead of failing, when it cannot open its -j log
export PATH="$HERE/edk2/obj/ABL_OBJ/Build/Source/C/bin:$PATH"
build -p QcomModulePkg/QcomModulePkg.dsc -a AARCH64 -t CLANG35 -b DEBUG \
  -m "${2:-QcomModulePkg/Application/LinuxLoader/LinuxLoader.inf}" \
  -D ABL_OUT_DIR="$PWD/obj/QEMU/Build" -D QEMU_TEST=TRUE -D ESP_HARNESS=TRUE \
  -D BOARD_BOOTLOADER_PRODUCT_NAME="$SOC" "${ARGS[@]}" \
  -j "$HERE/logs/qemu-ll-build.log" 2>&1 | tail -3
find "$PWD/obj/QEMU" -name "$(basename "${2:-LinuxLoader.inf}" .inf).efi" -path "*OUTPUT*" | head -1
