#!/bin/bash
# build-all.sh — build every SoC, one log each, summary at the end.
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HERE/logs"
for s in sdm845 sm6115 sm8250 sm8550 sm8650 sm8750; do
  if "$HERE/build.sh" "$s" > "$HERE/logs/$s.log" 2>&1; then echo "OK   $s $(stat -c%s "$HERE/out/abl_signed-${s^^}-ESP-r34.elf")"; else echo "FAIL $s (logs/$s.log)"; fi
done
