#!/bin/bash
# test-esp.sh — QEMU/AAVMF test of the ABL ESP chain (BootLib BootEsp+RawFat) up to GRUB.
# Needs: qemu-system-aarch64, AAVMF, mtools, sgdisk, grub-mkstandalone + arm64-efi modules.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; W="$HERE/work"; mkdir -p "$W"; cd "$W"
GRUBMOD=${GRUBMOD:-$W/grub/x/usr/lib/grub/arm64-efi}
if [ ! -d "$GRUBMOD" ]; then
  mkdir -p grub && (cd grub && curl -sO http://ports.ubuntu.com/pool/main/g/grub2-unsigned/grub-efi-arm64-bin_2.12-1ubuntu7.3_arm64.deb && dpkg-deb -x grub-efi-arm64-bin_*.deb x)
fi
[ -f grubaa64.efi ] || grub-mkstandalone -O arm64-efi -d "$GRUBMOD" -o grubaa64.efi \
  --modules="part_gpt part_msdos fat echo ls halt normal configfile" "boot/grub/grub.cfg=$HERE/grub-test.cfg"
"$HERE/../build-harness.sh" >/dev/null || { echo "FAIL build-harness"; exit 1; }
EFI=$(find "$HERE/../edk2/obj/HARNESS" -path '*EspHarness/OUTPUT/EspHarness.efi' | head -1)
truncate -s 64M int.img; sgdisk -o -n1:2048:0 -t1:EF00 -c1:INTERNAL int.img >/dev/null
P=$(mktemp); truncate -s 62M $P; mformat -i $P -v INTERNAL ::; mcopy -i $P "$EFI" ::/EspHarness.efi
printf 'for %%i in 0 1 2 3 4 5\r\n  if exist fs%%i:\\EspHarness.efi then\r\n    fs%%i:\\EspHarness.efi\r\n    reset -s\r\n  endif\r\nendfor\r\n' > startup.nsh; mcopy -i $P startup.nsh ::/startup.nsh
dd if=$P of=int.img bs=1M seek=1 conv=notrunc status=none; rm $P
rc=0
check(){ # name img expect-pattern
  "$HERE/run2.sh" "$2" "$1.log" 60
  if grep -aq 'ESPTEST: start' "$1.log" && tr -s '\r\n' '\n' < "$1.log" | grep -aq "$3" && ! grep -aq 'Exception' "$1.log"; then echo "PASS $1"; else echo "FAIL $1 (see $W/$1.log)"; rc=1; fi; }
"$HERE/mkcard.sh" sd-mformat.img mformat /EFI/BOOT/BOOTAA64.EFI grubaa64.efi; check grub-mformat sd-mformat.img GRUBTEST-OK
"$HERE/mkcard.sh" sd-mkfs.img    mkfs    /EFI/BOOT/BOOTAA64.EFI grubaa64.efi; check grub-mkfsfat  sd-mkfs.img    GRUBTEST-OK
echo nothing > dummy.txt
"$HERE/mkcard.sh" sd-empty.img   mformat /dummy.txt dummy.txt;                    check no-grub-clean-fail sd-empty.img 'StartEspBootLoader returned'
exit $rc
