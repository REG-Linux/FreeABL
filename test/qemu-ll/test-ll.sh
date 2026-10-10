#!/bin/bash
# test-ll.sh — run the REAL LinuxLoader (QEMU test variant) through QemuQcomShim on
# Odin-like disks and check where each boot ends. Also checks the UFS disk is not
# modified (GPT / boot / dtbo) in the scenarios where nothing should be written.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
SD="$HERE/../work/sd-mformat.img"          # REG-Linux-style card with GRUB (from test-esp.sh)
GUID=b5e3a843-9261-4e72-b5c4-312e56f8907a  # gBootModeVariableGuid
ANDROID_PRE="setvar BootModeLinux -guid $GUID -bs -rt -nv =00\r\n"
rc=0
run() { # name expect-regex must-not-regex ufs-args sd(0/1) pre-nsh nowrite(0/1) secs
  local name=$1 expect=$2 forbid=$3 ufs=$4 sd=$5 pre=$6 nowrite=$7 secs=${8:-100}
  ./mkufs.py ufs-$name.img $ufs >/dev/null; cp ufs-$name.img ufs-$name.before
  rm -f vars.fd
  local disks=(ufs-$name.img); [ "$sd" = 1 ] && { cp "$SD" sd-$name.img; disks+=(sd-$name.img); }
  PRE_NSH="$pre" ./run-ll.sh ll-$name.log "$secs" "${disks[@]}"
  local log; log=$(tr -s '\r\n' '\n' < ll-$name.log)
  local ok=1 why=""
  echo "$log" | grep -aqE "$expect" || { ok=0; why="missing /$expect/"; }
  [ -n "$forbid" ] && echo "$log" | grep -aqE "$forbid" && { ok=0; why="$why found /$forbid/"; }
  echo "$log" | grep -aq 'Synchronous Exception' && { ok=0; why="$why CPU exception"; }
  if [ "$nowrite" = 1 ] && ! cmp -s ufs-$name.img ufs-$name.before; then
    ok=0; why="$why UFS disk modified ($(cmp -l ufs-$name.img ufs-$name.before | wc -l) bytes)"; fi
  if [ $ok = 1 ]; then echo "PASS $name"; else echo "FAIL $name:$why (ll-$name.log)"; rc=1; fi
}
#   name                expect                                   forbid                          ufs args                                   sd pre           nowrite
run odin-b-sd-grub     'GRUBTEST-OK'                             'LoadImageAndAuth\.\.\.'        "--active b --dtbo-b erased"               1  ""             1
run odin-b-nosd        'Entering fastboot mode'                  'LoadImageAndAuth\.\.\.|rebooting into Android' "--active b --dtbo-b erased" 0 ""            1
run odin-b-android     'Android not bootable.*|Entering fastboot mode' 'LoadImageAndAuth\.\.\.'  "--active b --dtbo-b erased"               0  "$ANDROID_PRE" 1
run odin-b-empty-boot  'Entering fastboot mode'                  'LoadImageAndAuth\.\.\.'        "--active b --boot-b empty --dtbo-b erased" 0  "$ANDROID_PRE" 1
run odin-a-sd-grub     'GRUBTEST-OK'                             'LoadImageAndAuth\.\.\.'        "--active a"                               1  ""             1
run odin-a-android     'ABL: LoadImageAndAuth\.\.\.'             'One-shot'                      "--active a"                               0  "$ANDROID_PRE" 0
run odin-a-nosd-menu   'Boot menu: Android'                      'One-shot|rebooting into Android' "--active a"                               0  ""             0  160
# Stock Android on slot A, with the real Odin boot_a/dtbo_a/vbmeta_a (odin-backup/, never
# committed): AVB, DTB selection, cmdline, up to the kernel handoff, where the shim saves
# the final DTB. Then check the cmdline against what the stock ABL gave Android.
STOCK="$HERE/../../odin-backup"
if [ -f "$STOCK/boot_a.stock.img" ]; then
  run odin-a-stock-android 'LLTEST-HANDOFF dtb=Success' '' "--active a --stock $STOCK" 0 "$ANDROID_PRE" 0 400
  rm -f final.dtb; mcopy -i int.img@@1M ::/final.dtb final.dtb 2>/dev/null
  args=$(fdtget final.dtb /chosen bootargs 2>/dev/null)
  for want in ' init=/init ' 'androidboot.verifiedbootstate=orange' 'androidboot.slot_suffix=_a' \
              'androidboot.dtbo_idx=22' 'androidboot.dtb_idx=7' 'androidboot.bootdevice=1d84000.ufshc' \
              'msm_drm.dsi_display0=dsi_innolux_td4328_1080p_cmd_display:' 'skip_initramfs'; do
    case " $args " in *"$want"*) ;; *) echo "FAIL odin-a-stock-android cmdline: missing '$want'"; rc=1;; esac
  done
else
  echo "SKIP odin-a-stock-android (no stock images in $STOCK)"
fi
exit $rc
