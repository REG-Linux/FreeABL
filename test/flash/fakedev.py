#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Fake `fastboot` and `edl` for test-flash.py: one simulated device in $FAKEDEV.

$FAKEDEV/vars.json  fastboot variables, plus "critical": refuse fastboot flash of abl,
                    "msm": EDL MSM ID, "corrupt": flip a byte on every EDL write
$FAKEDEV/<part>     partition contents (1 MiB)
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
    print(f"HWID:              0x{V['msm']:08x}00000000 (MSM_ID:0x{V['msm']:08x},OEM_ID:0x0000,MODEL_ID:0x0000)")
    open(loaded, 'w').close()
cmd = args[0]
if cmd == 'printgpt':
    print("Lun 4:\nabl_a  Offset 0x00000000, Length 0x00100000\nabl_b  Offset 0x00100000, Length 0x00100000")
elif cmd == 'r':
    open(args[2], 'wb').write(open(part(args[1]), 'rb').read())
    print(f"Dumped sector 0 with sector count 256 as {args[2]}.")
elif cmd == 'w':
    write(args[1], args[2], V.get('corrupt'))
    print(f"Wrote {args[2]} to sector 0.")
elif cmd == 'reset':
    os.remove(loaded)
    print("Reset succeeded.")
