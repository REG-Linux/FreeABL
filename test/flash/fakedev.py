#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Fake `fastboot` and `edl` for test-flash.py: one simulated device in $FAKEDEV.

$FAKEDEV/vars.json  fastboot variables, plus "critical": refuse fastboot flash of abl,
                    "msm": EDL MSM ID, "corrupt": flip a byte on every EDL write, "fail_writes": that
                    many EDL writes stop half way,
                    "parts": the partitions on LUN 4, in order (userdata on LUN 0 is listed, never read)
$FAKEDEV/<part>     partition contents
"""
import json, os, sys

D = os.environ['FAKEDEV']
V = json.load(open(os.path.join(D, 'vars.json')))
SIZE = 1 << 20
log = open(os.path.join(D, 'calls.log'), 'a')


def part(name):
    return os.path.join(D, name)


def write(name, src, corrupt=False):
    data = bytearray(open(part(name), 'rb').read())
    new = open(src, 'rb').read()
    data[:len(new)] = new
    if corrupt:
        data[100] ^= 0xff
    open(part(name), 'wb').write(bytes(data))


tool = os.path.basename(sys.argv[0])
args = sys.argv[1:]
log.write(f"{tool} {' '.join(args)}\n")
if tool == 'fastboot':
    if args[0] == 'devices':
        print(f"{V['serialno']}\tfastboot")
    elif args[0] == 'getvar':
        if args[1] in V:
            sys.stderr.write(f"{args[1]}: {V[args[1]]}\nFinished. Total time: 0.001s\n")
        else:
            sys.stderr.write(f"getvar:{args[1]} FAILED (remote: 'GetVar Variable Not found')\n")
            sys.exit(1)
    elif args[0] == 'flash':
        if V.get('critical'):
            sys.stderr.write("FAILED (remote: 'Flashing is not allowed for Critical Partitions')\n")
            sys.exit(1)
        write(args[1], args[2])
        sys.stderr.write(f"Writing '{args[1]}'  OKAY [  0.001s]\n")
    sys.exit(0)

# edl
opts = [a for a in args if a.startswith('--')]
args = [a for a in args if not a.startswith('--')]
loaded = os.path.join(D, '.loaded')
if not os.path.exists(loaded):
    if V.get('sahara') == 3:        # as the edl tool prints it for a Sahara 3 device (AYANEO Pocket S)
        print(f"sahara - - Chip Serial Number : 437{V.get('chip', '1234abcd')}")
        print("sahara - - Chip Identifier V3 : 00020000")
        print(f"sahara - - MSM HWID : 0x{V['msm']:x} | model_id:0x0000 | oem_id:0000")
        print("sahara - - OEM PKHASH : 00000000")
    else:                           # Sahara 2, as the edl tool prints it (Mangmi Pocket Max)
        print(f"\nVersion 0x2\n------------------------\nHWID:              0x{V['msm']:08x}00000000 "
              f"(MSM_ID:0x{V['msm']:08x},OEM_ID:0x0000,MODEL_ID:0x0000)\nCPU detected:      \"SM8250\"\n"
              f"PK_HASH:           0xd40eee56f3194665\nSerial:            0x{V.get('chip', '1234abcd')}")
    open(loaded, 'w').close()
cmd = args[0]
# layout as the edl tool prints it (offsets in bytes); UFS, 4096-byte sectors
layout, off = [], 0x10000
for n in V.get('parts', ['abl_a', 'abl_b']):
    size = os.path.getsize(part(n))
    layout.append((n, off, size))
    off += (size + 4095) // 4096 * 4096       # partitions start on a sector
if cmd == 'printgpt':
    row = "{:20} Offset 0x{:016x}, Length 0x{:016x}, Flags 0x0000000000000000, UUID x, Type x, Active False"
    print("\nParsing Lun 0:\n\nGPT Table:\n-------------\n" + row.format('userdata:', 0x6000, 1 << 36))
    print("\nParsing Lun 4:\n\nGPT Table:\n-------------\n" + '\n'.join(row.format(n + ':', o, l) for n, o, l in layout))
elif cmd == 'r':
    for name, path in zip(args[1].split(','), args[2].split(',')):
        if not os.path.exists(part(name)):
            print(f"Error: Couldn't detect partition: {name}")
            sys.exit(1)
        open(path, 'wb').write(open(part(name), 'rb').read())
        print(f"Dumped sector 0 with sector count 256 as {path}.")
elif cmd == 'rs':
    start, count, path = int(args[1]) * 4096, int(args[2]) * 4096, args[3]
    n, o, l = next(x for x in layout if x[1] <= start < x[1] + x[2])
    open(path, 'wb').write(open(part(n), 'rb').read()[start - o:start - o + count].ljust(count, b'\0'))
    print(f"Dumped sector {args[1]} with sector count {args[2]} as {path}.")
elif cmd == 'w':
    if V.get('fail_writes'):        # the USB transfer dies half way
        V['fail_writes'] -= 1
        json.dump(V, open(os.path.join(D, 'vars.json'), 'w'))
        data = bytearray(open(part(args[1]), 'rb').read())
        new = open(args[2], 'rb').read()
        data[:len(new) // 2] = new[:len(new) // 2]
        open(part(args[1]), 'wb').write(bytes(data))
        print("Error: USB write failed")
        sys.exit(1)
    write(args[1], args[2], V.get('corrupt'))
    print(f"Wrote {args[2]} to sector 0.")
elif cmd == 'reset':
    os.remove(loaded)
    print("Reset succeeded.")
