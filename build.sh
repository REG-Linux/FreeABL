#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# build.sh <soc> — FreeABL (CLO uefi.lnx.5.0.r34-rel + ESP boot) for one SoC.
# Kernel handoff: classic (DISABLE_KERNEL_PROTOCOL=1) on sdm845/sm8250 like their stock
# ABLs (the Mangmi Pocket Max firmware has the protocol but Android only boots classic);
# sm6115 (Air X LA2.0 stock ABL) and newer SoCs use the kernel protocol, with a runtime classic fallback.
# CLO makefile, DEBUG_CLANG35, out in obj/ABL_OBJ, ELF32 wrapper @0x9FA00000, qtestsign.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
"$HERE/tools/mktoolbin.sh"
SOC=${1:?usage: build.sh <sdm845|sm6115|sm8250|sm8550|sm8650|sm8750>}
declare -A SIGN=([sdm845]=5 [sm6115]=6 [sm8250]=6 [sm8550]=7 [sm8650]=7 [sm8750]=7)
V=${SIGN[$SOC]:?unknown soc $SOC}
cd "$HERE/edk2"
# Reproducible: __DATE__/__TIME__ come from the edk2 commit, so the same sources
# built in the same directory give the same image.
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}
for f in BaseTools/Source/C/Makefiles/header.makefile BaseTools/Conf/tools_def.template Conf/tools_def.txt; do
  [ -f "$f" ] && sed -i 's/-Wall -Werror/-Wall -Wno-error/g' "$f"
done
export PATH="$HERE/toolbin:$PATH"
rm -f obj/ABL_OBJ/Build/DEBUG_CLANG35/FV/FVMAIN_COMPACT.Fv "$HERE/unsigned_abl.elf"
# EDK2 does not track -D define changes (PRODUCT_NAME): clean when the SoC changes.
STAMP=obj/ABL_OBJ/last_soc
if [ "$(cat "$STAMP" 2>/dev/null)" != "$SOC" ]; then
  rm -rf obj/ABL_OBJ/Build/DEBUG_CLANG35/AARCH64 obj/ABL_OBJ/Build/DEBUG_CLANG35/FV
fi
mkdir -p obj/ABL_OBJ && echo "$SOC" > "$STAMP"
make -j"$(nproc)" all \
  BOOTLOADER_OUT="$PWD/obj/ABL_OBJ" \
  CLANG_BIN="$HERE/toolbin/" CLANG_PREFIX=aarch64-linux-gnu- CLANG35_GCC_TOOLCHAIN=/usr \
  TARGET_ARCHITECTURE=AARCH64 BOARD_BOOTLOADER_PRODUCT_NAME="$SOC" \
  VERIFIED_BOOT_ENABLED=1 BUILD_USES_RECOVERY_AS_BOOT=1 USER_BUILD_VARIANT=0 \
  DYNAMIC_PARTITION_SUPPORT=1 VIRTUAL_AB_OTA=1 \
  INIT_BIN=$([ "$SOC" = sdm845 ] && echo /init || echo /sbin/init) USERDATAIMAGE_FILE_SYSTEM_TYPE=ext4 \
  LOAD_ADDRESS=0x9FA00000 \
  DISABLE_KERNEL_PROTOCOL=${DISABLE_KERNEL_PROTOCOL:-$(case "$SOC" in sdm845|sm8250) echo 1;; *) echo 0;; esac)} \
  ESP_DEBUG_SCREEN=${ESP_DEBUG_SCREEN:-FALSE} \
  ESP_DISPLAY_OFF=$([ "$SOC" = sdm845 ] && echo TRUE || echo FALSE)
# Licence guard: OpenDice / BoringSSL (on CLO's link line, partly under the
# OpenSSL/SSLeay licence) must never end up in the GPL image.
MAP=obj/ABL_OBJ/Build/DEBUG_CLANG35/AARCH64/QcomModulePkg/Application/LinuxLoader/LinuxLoader/OUTPUT/LinuxLoader.map
[ -f "$MAP" ] || { echo "FAIL: no linker map ($MAP)"; exit 1; }
if grep -qiE 'OpenDice|open-dice|boringssl' "$MAP"; then
  echo "FAIL: OpenDice/BoringSSL code linked into LinuxLoader (licence)"; exit 1
fi
ELF="$PWD/obj/ABL_OBJ/../../unsigned_abl.elf"; ELF=$(readlink -f "$ELF")
mkdir -p "$HERE/out"
OUT="$HERE/out/abl_signed-${SOC^^}-ESP-r34.elf"
python3 "$HERE/tools/qtestsign/qtestsign.py" -v"$V" -o "$OUT" abl "$ELF"
sha256sum "$OUT" > "$OUT.sha256"
echo "SUCCESS: $OUT"
