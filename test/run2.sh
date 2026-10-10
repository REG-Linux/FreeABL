#!/bin/bash
# run2.sh <sd-img> <log> [seconds] : internal(harness) + SD
cp /usr/share/AAVMF/AAVMF_VARS.fd $1.vars; cd "$(dirname "$1")"
timeout ${3:-60} qemu-system-aarch64 -M virt -cpu cortex-a57 -m 1024 -nographic \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/AAVMF/AAVMF_CODE.no-secboot.fd \
  -drive if=pflash,format=raw,file=$1.vars \
  -drive if=none,id=int,format=raw,file=int.img -device virtio-blk-pci,drive=int,bootindex=0 \
  -drive if=none,id=sd,format=raw,file=$1 -device virtio-blk-pci,drive=sd,bootindex=1 > $2 2>&1
sed -i 's/\x1b\[[0-9;=]*[A-Za-z]//g' $2
