#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# run-all.sh — every no-board test for the ESP ABL.
#  1. host unit test of the routing logic (BootDispatch.c, all input combinations)
#  2. QEMU: BootLib ESP chain -> GRUB (EspHarness)
#  3. QEMU: the real LinuxLoader through QemuQcomShim on Odin-like disks
HERE="$(cd "$(dirname "$0")" && pwd)"; E="$HERE/../edk2/QcomModulePkg"; rc=0
echo "== 1. routing logic (host)"
cc -Wall -Wextra -Werror -DESP_HOST_TEST -I"$E/Include/Library" -o "$HERE/boot_dispatch_test" \
   "$HERE/boot_dispatch_test.c" "$E/Library/BootLib/BootDispatch.c" && "$HERE/boot_dispatch_test" | tail -1 || rc=1
echo "== 2. ESP chain (QEMU)";  "$HERE/test-esp.sh" || rc=1
echo "== 3. LinuxLoader (QEMU)"
"$HERE/../build-qemu-ll.sh" sdm845 >/dev/null && "$HERE/../build-qemu-ll.sh" sdm845 QcomModulePkg/Application/QemuQcomShim/QemuQcomShim.inf >/dev/null \
  && "$HERE/qemu-ll/test-ll.sh" || rc=1
echo "== 4. LinuxLoader SM8250 (QEMU, Mangmi Pocket Max dump)"
"$HERE/../build-qemu-ll.sh" sm8250 >/dev/null && "$HERE/../build-qemu-ll.sh" sm8250 QcomModulePkg/Application/QemuQcomShim/QemuQcomShim.inf >/dev/null \
  && "$HERE/qemu-ll/test-pm.sh" || rc=1
echo "== 5. LinuxLoader SM6115 (QEMU, Mangmi Air X MQ66 / MQ65 factory images)"
"$HERE/../build-qemu-ll.sh" sm6115 >/dev/null && "$HERE/../build-qemu-ll.sh" sm6115 QcomModulePkg/Application/QemuQcomShim/QemuQcomShim.inf >/dev/null \
  && "$HERE/qemu-ll/test-airx.sh" || rc=1
echo "== 6. LinuxLoader SM8550 (QEMU, AYANEO Pocket S flat build)"
"$HERE/../build-qemu-ll.sh" sm8550 >/dev/null && "$HERE/../build-qemu-ll.sh" sm8550 QcomModulePkg/Application/QemuQcomShim/QemuQcomShim.inf >/dev/null \
  && "$HERE/qemu-ll/test-pockets.sh" || rc=1
echo; [ $rc = 0 ] && echo "ALL TESTS PASS" || echo "SOME TESTS FAILED"; exit $rc
