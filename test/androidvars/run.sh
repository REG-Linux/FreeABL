#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# run.sh — FreeABL's fastboot variables for the Android build (AndroidBuildVars.c,
# with the edk2 tree's own libavb) compiled on the host, against the Python
# tool on the same partition images: both must read the same version, patch
# and vbmeta sha256. The web page's reading is checked against the Python tool
# in test/flash/test-flash.py. Cases: boot properties, init_boot properties
# (GKI), boot header when vbmeta has no version, no vbmeta.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
A="$HERE/../../edk2/QcomModulePkg/Library/avb/libavb"
F="$HERE/../../edk2/QcomModulePkg/Library/FastbootLib"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
# the plain helpers of avb_util.c (the file itself needs the Qualcomm headers)
{ echo '#include "libavb/avb_util.h"'
  for fn in avb_be32toh avb_be64toh avb_safe_add_to avb_safe_add avb_safe_memcmp avb_malloc avb_calloc avb_basename; do
    awk -v f="$fn" '$0 ~ "^[a-z].*[ *]"f"\\(" && $0 !~ ";" {p=1} p {print} p && /^}/ {p=0; print ""}' "$A/avb_util.c"
  done; } > "$W/util.c"
gcc -std=gnu11 -fshort-wchar -w -I "$HERE/inc" -I "$HERE/inc/Library" -I "$A/.." -I "$A" -I "$F" -DAVB_COMPILATION \
  -o "$W/abv" "$F/AndroidBuildVars.c" "$HERE/stubs.c" "$HERE/sysdeps.c" "$W/util.c" \
  "$A"/avb_{property_descriptor,descriptor,sha256,vbmeta_image,rsa,sha512,crypto,version}.c
python3 - "$W" "$HERE/../.." <<'PY'
import importlib.util, json, os, subprocess, sys
W, ROOT = sys.argv[1:]
def mod(name, path):
    s = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
ff = mod('ff', f'{ROOT}/tools/freeabl-flash.py')
sys.argv = ['x']; tf = open(f'{ROOT}/test/flash/test-flash.py').read()
ns = {'__file__': f'{ROOT}/test/flash/test-flash.py'}
exec(tf[:tf.index('class Dev:')], ns)   # vbmeta_image, build, boot_header
cases = {
    'boot-props': dict(vbmeta=ns['build'](patch='2024-05-05')[0], boot=ns['boot_header']('13', '2024-05')),
    'init-boot-props': dict(vbmeta=ns['build'](os_v='14', patch='2025-02-05', gki=True)[0], boot=ns['boot_header']('14', '2025-02')),
    'header-fallback': dict(vbmeta=ns['vbmeta_image']({}), boot=ns['boot_header']('12.1', '2023-11')),
    'no-vbmeta': dict(boot=ns['boot_header']('11', '2022-03')),
}
bad = 0
for name, parts in cases.items():
    d = os.path.join(W, name); os.makedirs(d)
    for p, data in parts.items():
        open(os.path.join(d, f'{p}_a.img'), 'wb').write(data)
    vb = parts.get('vbmeta')
    a = ff.android_from(vb, None, None)
    if not (a and a['os_version'] and a['patch']):
        a = ff.android_from(vb, None, parts['boot'])
    # FreeABL sends the first 32 hex digits: a fastboot reply holds 60 characters
    py = {'os_version': a['os_version'] or '', 'patch': a['patch'] or '', 'vbmeta_sha256': (a['vbmeta_sha256'] or '')[:32]}
    c = json.loads(subprocess.run([os.path.join(W, 'abv'), d, 'a'], capture_output=True, text=True, check=True).stdout)
    ok = c == py and c['patch'] and all(len(v) <= 60 for v in c.values())
    bad += not ok
    print(f"{'ok  ' if ok else 'FAIL'} {name}: {c}" + ('' if ok else f' (tool: {py})'))
sys.exit(1 if bad else 0)
PY
