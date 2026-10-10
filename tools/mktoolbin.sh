#!/bin/bash
# mktoolbin.sh — create toolbin/: the clang/lld/llvm tool names the CLO build expects,
# pointing at versioned host tools. Idempotent. Override the versions with
# CLANG_VER (default 18) and LLD_VER (default 15, falls back to CLANG_VER).
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TB="$HERE/toolbin"
[ -x "$TB/clang" ] && [ -x "$TB/ld.lld" ] && exit 0
CLANG_VER=${CLANG_VER:-18}; LLD_VER=${LLD_VER:-15}
pick() { for c in "$@"; do command -v "$c" 2>/dev/null && return; done
         echo "mktoolbin: none of $* found" >&2; exit 1; }
mkdir -p "$TB"
ln -sf "$(pick clang-$CLANG_VER clang)" "$TB/clang"
ln -sf "$(pick clang-$CLANG_VER clang)" "$TB/clang++"
ln -sf "$(pick ld.lld-$LLD_VER ld.lld-$CLANG_VER ld.lld)" "$TB/ld.lld"
for t in ar nm objcopy objdump ranlib strip; do
  ln -sf "$(pick llvm-$t-$CLANG_VER llvm-$t)" "$TB/llvm-$t"
done
echo "toolbin: $(ls "$TB" | tr '\n' ' ')"
