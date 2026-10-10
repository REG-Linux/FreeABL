#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# mkcard.sh <img> <mformat|mkfs> <path-in-ESP> <efi-file> [<path2> <file2>...]
set -e
IMG=$1 FMT=$2; shift 2
truncate -s 1400M $IMG
sgdisk -o -n1:2048:+1200M -t1:EF00 -c1:REGLINUX -n2:0:0 -t2:8300 -c2:SHARE $IMG >/dev/null
P=$(mktemp); truncate -s 1200M $P
if [ "$FMT" = mformat ]; then mformat -i $P -F -v REGLINUX -c 32 ::; else mkfs.fat -F32 -n REGLINUX $P >/dev/null; fi
while [ $# -ge 2 ]; do d=$(dirname $1); p=""; for c in $(echo $d | tr / ' '); do p="$p/$c"; mmd -i $P ::$p 2>/dev/null || true; done; mcopy -o -i $P $2 ::$1; shift 2; done
dd if=$P of=$IMG bs=1M seek=1 conv=notrunc status=none; rm $P
