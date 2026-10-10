#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# test-pm.sh — SM8250 (Mangmi Pocket Max): the real LinuxLoader built for sm8250, shim profile
# "pocketmax", on the device's own EDL dump (~/MangmiPocketMax/partitions/edl-1008, never
# committed; skipped when absent). Android path up to the kernel handoff, cmdline checked.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
DUMP="${PM_DUMP:-$HOME/MangmiPocketMax/partitions/edl-1008}"
GUID=b5e3a843-9261-4e72-b5c4-312e56f8907a
if [ ! -f "$DUMP/boot_a.img" ]; then echo "SKIP pm-stock-android (no dump in $DUMP)"; exit 0; fi
./mkufs.py ufs-pm.img --active a --dump "$DUMP" >/dev/null
rm -f vars.fd
PRE_NSH="setvar BootModeLinux -guid $GUID -bs -rt -nv =00\r\nsetvar QemuShimProfile -guid $GUID -bs -rt =706f636b65746d6178\r\n" \
  ./run-ll.sh ll-pm-android.log 400 ufs-pm.img
rc=0
grep -aq 'LLTEST-HANDOFF dtb=Success' ll-pm-android.log || { echo "FAIL pm-stock-android: no kernel handoff (ll-pm-android.log)"; rc=1; }
rm -f final.dtb; mcopy -i int.img@@1M ::/final.dtb final.dtb 2>/dev/null
args=" $(fdtget final.dtb /chosen bootargs 2>/dev/null) "
for want in 'androidboot.dtbo_idx=13' 'androidboot.dtb_idx=0' 'androidboot.verifiedbootstate=orange' \
            'androidboot.slot_suffix=_a'; do
  case "$args" in *" $want "*) ;; *) echo "FAIL pm-stock-android cmdline: missing '$want'"; rc=1;; esac
done
case "$args" in *" skip_initramfs "*) echo "FAIL pm-stock-android: skip_initramfs on a dynamic-partition device"; rc=1;; esac
# Separate recovery partition: not recovery-as-boot, so no force_normal_boot (first-stage init
# would switch into an empty /first_stage_ramdisk). The stock ABL does not pass it either.
case "$args" in *"androidboot.force_normal_boot"*) echo "FAIL pm-stock-android: force_normal_boot with a recovery partition"; rc=1;; esac
[ $rc = 0 ] && echo "PASS pm-stock-android"
exit $rc
