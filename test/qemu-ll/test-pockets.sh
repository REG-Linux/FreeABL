#!/bin/bash
# test-pockets.sh — SM8550 (AYANEO Pocket S, KalamaP SG, UFS, boot header v4, vbmeta chaining
# boot/recovery): the real LinuxLoader built for sm8550, shim profile "pockets", on AYANEO's
# flat build for the installed build (~/AyaneoPocketS/images, never committed; skipped when
# absent). Android path up to the kernel handoff; DTB/overlay and bootconfig checked against
# the device's stock values (dtb_idx 6, dtbo_idx 8).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
DIR="${POCKETS_IMAGES:-$HOME/AyaneoPocketS/images}"
GUID=b5e3a843-9261-4e72-b5c4-312e56f8907a
[ -f "$DIR/boot.img" ] || { echo "SKIP pockets-stock-android (no images in $DIR)"; exit 0; }
./mkufs.py ufs-pocs.img --active a --factory "$DIR" >/dev/null
rm -f vars.fd
PRE_NSH="setvar BootModeLinux -guid $GUID -bs -rt -nv =00\r\nsetvar QemuShimProfile -guid $GUID -bs -rt =706f636b657473\r\n" \
  ./run-ll.sh ll-pocs-android.log 400 ufs-pocs.img
rc=0
grep -aq 'LLTEST-HANDOFF dtb=Success' ll-pocs-android.log || { echo "FAIL pockets: no kernel handoff"; rc=1; }
rm -f final.dtb bootconfig.txt
mcopy -i int.img@@1M ::/final.dtb final.dtb 2>/dev/null; mcopy -i int.img@@1M ::/bootconfig.txt bootconfig.txt 2>/dev/null
[ "$(fdtget final.dtb / model 2>/dev/null)" = "Qualcomm Technologies, Inc. Kalama QRD,Graph-DVT" ] || { echo "FAIL pockets: overlay"; rc=1; }
bc=$(tr -d '\0' < bootconfig.txt 2>/dev/null)
for want in 'androidboot.dtbo_idx=8' 'androidboot.dtb_idx=6' 'androidboot.force_normal_boot=0' \
            'androidboot.verifiedbootstate=orange' 'androidboot.slot_suffix=_a'; do
  echo "$bc" | grep -qx "$want" || { echo "FAIL pockets bootconfig: missing '$want'"; rc=1; }
done
[ $rc = 0 ] && echo "PASS pockets-stock-android"
exit $rc
