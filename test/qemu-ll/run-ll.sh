#!/bin/bash
# run-ll.sh <log> <seconds> [extra disk images...]
# Boots AAVMF; the "internal" disk carries LinuxLoader.efi (+ optional QemuQcomShim.efi)
# and a startup.nsh that loads the shim then runs LinuxLoader.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
LOG=$1; SECS=$2; shift 2
LL=$(find "$HERE/../../edk2/obj/QEMU" -name LinuxLoader.efi | head -1)
SHIM=$(find "$HERE/../../edk2/obj/QEMU" -name QemuQcomShim.efi 2>/dev/null | head -1)
truncate -s 64M int.img; sgdisk -o -n1:2048:0 -t1:EF00 -c1:INTERNAL int.img >/dev/null
P=$(mktemp); truncate -s 62M $P; mformat -i $P -v INTERNAL ::; mcopy -i $P "$LL" ::/LinuxLoader.efi
NSH="${PRE_NSH:-}"'for %i in 0 1 2 3 4 5 6 7\r\n  if exist fs%i:\\LinuxLoader.efi then\r\n'
if [ -n "$SHIM" ]; then mcopy -i $P "$SHIM" ::/QemuQcomShim.efi; NSH+='    fs%i:\\QemuQcomShim.efi\r\n'; else NSH+='    fs%i:\\LinuxLoader.efi\r\n'; fi
NSH+='    echo LLTEST-RETURNED %lasterror%\r\n    reset -s\r\n  endif\r\nendfor\r\n'
printf '%b' "$NSH" > startup.nsh; mcopy -i $P startup.nsh ::/startup.nsh
dd if=$P of=int.img bs=1M seek=1 conv=notrunc status=none; rm $P
[ -f vars.fd ] || cp /usr/share/AAVMF/AAVMF_VARS.fd vars.fd
ARGS=(); i=0; for d in "$@"; do ARGS+=(-drive if=none,id=d$i,format=raw,file=$d -device virtio-blk-pci,drive=d$i); i=$((i+1)); done
timeout "$SECS" qemu-system-aarch64 -M virt -cpu cortex-a57 -m 2048 -nographic \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/AAVMF/AAVMF_CODE.no-secboot.fd \
  -drive if=pflash,format=raw,file=vars.fd \
  -drive if=none,id=int,format=raw,file=int.img -device virtio-blk-pci,drive=int,bootindex=0 "${ARGS[@]}" > "$LOG" 2>&1
sed -i 's/\x1b\[[0-9;=]*[A-Za-z]//g' "$LOG"
