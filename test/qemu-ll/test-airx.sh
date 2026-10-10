#!/bin/bash
# test-airx.sh — SM6115 (Mangmi Air X, eMMC, boot header v4 + init_boot + vendor_boot): the real
# LinuxLoader built for sm6115, shim profile airx66 / airx65, on Mangmi's factory images
# (~/MangmiAirX/mq6{6,5}-images, never committed; skipped when absent). Android path up to the
# kernel handoff; overlay and bootconfig checked.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
GUID=b5e3a843-9261-4e72-b5c4-312e56f8907a
rc=0
#   rev  profile-hex      expected overlay model             dtbo_idx
for t in "66 616972783636 Panda_PVT_IDP 55" "65 616972783635 Panda_WIFI_I2C_GH7005_IDP 54"; do
  set -- $t; REV=$1 PROF=$2 MODEL=${3//_/ } IDX=$4
  DIR="${AIRX_IMAGES:-$HOME/MangmiAirX}/mq$REV-images"
  [ -f "$DIR/boot.img" ] || { echo "SKIP airx$REV-stock-android (no images in $DIR)"; continue; }
  ./mkufs.py ufs-ax$REV.img --active a --factory "$DIR" >/dev/null
  rm -f vars.fd
  PRE_NSH="setvar BootModeLinux -guid $GUID -bs -rt -nv =00\r\nsetvar QemuShimProfile -guid $GUID -bs -rt =$PROF\r\n" \
    ./run-ll.sh ll-ax$REV-android.log 400 ufs-ax$REV.img
  ok=1
  grep -aq 'LLTEST-HANDOFF dtb=Success' ll-ax$REV-android.log || { echo "FAIL airx$REV: no kernel handoff"; ok=0; }
  rm -f final.dtb bootconfig.txt
  mcopy -i int.img@@1M ::/final.dtb final.dtb 2>/dev/null; mcopy -i int.img@@1M ::/bootconfig.txt bootconfig.txt 2>/dev/null
  [ "$(fdtget final.dtb / model 2>/dev/null)" = "Qualcomm Technologies, Inc. $MODEL" ] || { echo "FAIL airx$REV: overlay $(fdtget final.dtb / model 2>/dev/null)"; ok=0; }
  bc=$(tr -d '\0' < bootconfig.txt 2>/dev/null)
  for want in "androidboot.dtbo_idx=$IDX" 'androidboot.force_normal_boot=0' 'androidboot.verifiedbootstate=orange' \
              'androidboot.fstab_suffix=emmc' 'androidboot.slot_suffix=_a'; do
    echo "$bc" | grep -qx "$want" || { echo "FAIL airx$REV bootconfig: missing '$want'"; ok=0; }
  done
  [ $ok = 1 ] && echo "PASS airx$REV-stock-android" || rc=1
done
exit $rc
