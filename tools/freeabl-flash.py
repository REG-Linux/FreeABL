#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""freeabl-flash: back up, flash and restore the ABL of a supported device.

  freeabl-flash.py devices                     supported devices
  freeabl-flash.py check                       fastboot: unlocked, slot, battery
  freeabl-flash.py backup  -d DEVICE           EDL: save the stock abl_a and abl_b
  freeabl-flash.py flash   -d DEVICE [-i IMG]  write FreeABL to the active slot
  freeabl-flash.py restore -d DEVICE           write the saved stock ABL back
  freeabl-flash.py reset   -d DEVICE           EDL: reboot the device

Testers: `-d other --soc SOC --untested` flashes a device that is not in the
list, and `--untested` also lets a listed device through when its chip (MSM)
ID differs or it was validated with an earlier build only. The stock ABL
backup and the signature-format check are never skipped.

Rules this tool keeps: it writes one partition only (abl_<active slot>), never
the partition table, never the active slot, never the other slot. It does not
flash without a verified backup of the device's stock ABL, nor an image whose
signature format differs from the stock ABL's. See FLASHING.md.
"""
import argparse, hashlib, json, os, re, shutil, struct, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# validated: "current" = this code on this device; "earlier" = an earlier FreeABL
# build only. Other devices and SoCs need -d other --soc SOC --untested.
# msm_id: Sahara MSM ID seen on the device (None = not recorded, not checked).
DEVICES = {
    'odin': dict(name='AYN Odin', soc='sdm845', mbn=5, validated='current',
                 memory='ufs', msm_id=0x08b0e1, loader=None,
                 loader_hint='auto-selected by the edl tool (its Loaders/ directory)'),
    'odin2portal': dict(name='AYN Odin 2 Portal', soc='sm8550', mbn=7, validated='current',
                        memory='ufs', msm_id=0x2520e1, loader='xbl_s_devprg_ns.melf',
                        loader_hint='xbl_s_devprg_ns.melf from the AYANEO Pocket S firmware '
                                    'package (works on this device)'),
    'pockets': dict(name='AYANEO Pocket S', soc='sm8550', mbn=7, validated='current',
                    memory='ufs', msm_id=0x2520e1, loader='xbl_s_devprg_ns.melf',
                    loader_hint='xbl_s_devprg_ns.melf from the AYANEO Pocket S firmware package'),
    'pocketmax': dict(name='Mangmi Pocket Max', soc='sm8250', mbn=6, validated='earlier',
                      memory='ufs', msm_id=None, loader='prog_firehose_ddr.elf',
                      loader_hint='prog_firehose_ddr.elf from the Mangmi firmware package'),
    'airx': dict(name='Mangmi Air X (MQ66)', soc='sm6115', mbn=6, validated='earlier',
                 memory=None, msm_id=None, loader=None,
                 loader_hint='the firehose loader from the Mangmi firmware package'),
}
# signature format (MBN header version) of the FreeABL image for each SoC
SOC_MBN = {'sdm845': 5, 'sm6115': 6, 'sm8250': 6, 'sm8550': 7, 'sm8650': 7, 'sm8750': 7}
MIN_MV = 3700
STATE_FILE = None
SLOTS = ('a', 'b')


def die(msg):
    sys.exit(f"STOP: {msg}")


def sha256(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def mbn_version(path):
    """Signature format of a signed ABL ELF: 5, 6, 7; 'empty' if all zeros; None if unknown."""
    d = open(path, 'rb').read()
    if not d.strip(b'\0'):
        return 'empty'
    if d[:4] != b'\x7fELF' or d[4] not in (1, 2):
        return None
    if d[4] == 1:                              # ELF32
        phoff, = struct.unpack_from('<I', d, 0x1c)
        phentsize, phnum = struct.unpack_from('<HH', d, 0x2a)
        fl_at, off_at, offfmt = 24, 4, '<I'
    else:                                      # ELF64
        phoff, = struct.unpack_from('<Q', d, 0x20)
        phentsize, phnum = struct.unpack_from('<HH', d, 0x36)
        fl_at, off_at, offfmt = 4, 8, '<Q'
    for i in range(phnum):
        p = phoff + i * phentsize
        flags, = struct.unpack_from('<I', d, p + fl_at)
        off, = struct.unpack_from(offfmt, d, p + off_at)
        if (flags >> 24) & 7 == 2:             # hash segment: MBN header, version in word 1
            return struct.unpack_from('<I', d, off + 4)[0]
    return None


# --- fastboot ---------------------------------------------------------------
def fastboot_bin():
    fb = os.environ.get('FASTBOOT') or shutil.which('fastboot')
    if not fb:
        die("fastboot not found: install Android platform-tools or set FASTBOOT")
    return fb


def fb_run(*args, timeout=60):
    r = subprocess.run([fastboot_bin(), *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout + r.stderr


def fb_getvar(name):
    try:
        _, out = fb_run('getvar', name, timeout=15)
    except subprocess.TimeoutExpired:
        return None
    m = re.search(rf'^{re.escape(name)}:\s*(.*)$', out, re.M)
    return m.group(1).strip() if m else None


def fb_one_device():
    _, out = fb_run('devices')
    devs = [l.split()[0] for l in out.splitlines() if l.strip().endswith('fastboot')]
    if not devs:
        die("no device in fastboot mode")
    if len(devs) > 1:
        die("more than one device in fastboot mode: connect only one")
    return devs[0]


# --- EDL (bkerler edl) ------------------------------------------------------
def edl_cmd():
    e = os.environ.get('FREEABL_EDL')
    if e:
        return e.split()
    e = shutil.which('edl')
    if not e:
        die("edl tool not found: pip install git+https://github.com/bkerler/edl, "
            "or set FREEABL_EDL to its command")
    return [e]


def edl_run(dev, loader, *args, memory=True):
    cmd = [*edl_cmd(), *args]
    if loader:
        cmd.append(f'--loader={loader}')
    if memory and dev['memory']:
        cmd.append(f"--memory={dev['memory']}")
    r = subprocess.run(cmd, capture_output=True, text=True)
    out = r.stdout + r.stderr
    # the MSM ID is only shown on the first connection after EDL entry: keep it
    m = re.search(r'MSM_ID:0x([0-9a-fA-F]+)', out)
    if m and STATE_FILE and os.path.isfile(STATE_FILE):
        try:
            st = json.load(open(STATE_FILE))
            st['msm_id'] = int(m.group(1), 16)
            json.dump(st, open(STATE_FILE, 'w'), indent=1)
        except (OSError, ValueError):
            pass
    return r.returncode, out


def edl_ok(dev, loader, *args, what):
    rc, out = edl_run(dev, loader, *args)
    if rc or re.search(r'\bError:|\bFailed\b', out):
        sys.stderr.write(out[-2000:])
        die(f"EDL {what} failed (output above)")
    return out


def edl_read(dev, loader, part, path):
    edl_ok(dev, loader, 'r', part, path, what=f'read of {part}')
    if not os.path.isfile(path) or not os.path.getsize(path):
        die(f"EDL read of {part} gave no data")


def edl_write_verified(dev, loader, part, img, workdir):
    """Write img to part, read it back, compare the image bytes."""
    edl_ok(dev, loader, 'w', part, img, what=f'write of {part}')
    rb = os.path.join(workdir, f'{part}.readback.img')
    edl_read(dev, loader, part, rb)
    a = open(img, 'rb').read()
    return open(rb, 'rb').read()[:len(a)] == a


# --- state ------------------------------------------------------------------
def backup_root(args):
    return os.path.abspath(args.backup_dir or os.path.join(os.path.expanduser('~'), 'FreeABL-backups'))


def state_path(args):
    return os.path.join(backup_root(args), 'current-device.json')


def load_state(args):
    try:
        return json.load(open(state_path(args)))
    except (OSError, ValueError):
        die("no device state: run 'check' with the device in fastboot mode first")


def device_dir(args, st):
    return os.path.join(backup_root(args), f"{st['serial']}")


def get_device(args):
    if args.device == 'other':
        if not args.soc:
            die("-d other needs --soc SOC (one of: " + ', '.join(SOC_MBN) + ")")
        if not args.untested and args.cmd in ('backup', 'flash'):
            die("-d other is for testers: add --untested (see FLASHING.md, 'Devices not in the list')")
        return dict(name=f'unlisted {args.soc} device', soc=args.soc, mbn=SOC_MBN[args.soc],
                    validated='none', memory=args.memory, msm_id=None, loader=None,
                    loader_hint="the firehose loader from your device's firmware package")
    if args.device not in DEVICES:
        die(f"unknown device '{args.device}' (see 'devices')")
    if args.soc and args.soc != DEVICES[args.device]['soc']:
        die(f"the {DEVICES[args.device]['name']} is {DEVICES[args.device]['soc']}: "
            f"for another SoC use -d other --soc {args.soc} --untested")
    dev = dict(DEVICES[args.device])
    if args.memory:
        dev['memory'] = args.memory
    return dev


def confirm(phrase, what):
    print(what)
    try:
        got = input(f"Type {phrase} to continue: ").strip()
    except EOFError:
        got = ''
    if got != phrase:
        die("aborted")


def default_image(dev):
    name = f"abl_signed-{dev['soc'].upper()}-ESP-r34.elf"
    for d in (os.getcwd(), os.path.join(ROOT, 'out')):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    die(f"image {name} not found: pass it with --image")


def check_image(dev, img):
    if not os.path.isfile(img):
        die(f"image not found: {img}")
    h = sha256(img)
    sums = []
    if os.path.isfile(img + '.sha256'):
        sums.append(img + '.sha256')
    s = os.path.join(os.path.dirname(img), 'SHA256SUMS')
    if os.path.isfile(s):
        sums.append(s)
    listed = None
    for f in sums:
        for line in open(f):
            parts = line.split()
            if len(parts) >= 2 and os.path.basename(parts[-1].lstrip('*')) == os.path.basename(img):
                listed = parts[0].lower()
    if listed is None:
        print(f"note: no checksum file next to {os.path.basename(img)}; sha256 {h}")
    elif listed != h:
        die(f"{img}: sha256 {h} does not match its checksum file ({listed})")
    else:
        print(f"image sha256 OK ({h[:16]}...)")
    v = mbn_version(img)
    if v != dev['mbn']:
        die(f"{os.path.basename(img)} has signature format {v}, the {dev['name']} needs v{dev['mbn']}")
    if f"-{dev['soc'].upper()}-" not in os.path.basename(img):
        die(f"{os.path.basename(img)} is not the {dev['soc']} image")
    return h


# --- commands ---------------------------------------------------------------
def cmd_devices(args):
    print(f"{'device':<12} {'SoC':<7} {'status':<36} name")
    for k, d in DEVICES.items():
        st = 'validated' if d['validated'] == 'current' else 'validated with an earlier build only'
        print(f"{k:<12} {d['soc']:<7} {st:<36} {d['name']}")
    print(f"\nOther devices (testers): -d other --soc {{{','.join(SOC_MBN)}}} --untested. "
          f"sm8650 and sm8750 were never run on a device.")


def cmd_check(args):
    serial = fb_one_device()
    v = {k: fb_getvar(k) for k in ('product', 'variant', 'unlocked', 'secure', 'current-slot',
                                   'battery-voltage', 'battery-soc-ok')}
    for k, x in v.items():
        print(f"  {k:<16} {x if x not in (None, '') else '-'}")
    if v['unlocked'] != 'yes':
        die("the bootloader is locked. FreeABL images carry a test signature and "
            "need an unlocked bootloader (see FLASHING.md)")
    # a test signature only runs with secure boot off (fuse not blown); an update could turn it on
    if v['secure'] != 'no':
        die(f"secure boot is on (secure = {v['secure']}): this device only runs bootloaders signed "
            "by its maker, FreeABL would not start. Not flashing" if v['secure'] else
            "the bootloader does not say whether secure boot is off (getvar secure): not flashing")
    slot = (v['current-slot'] or '').lstrip('_')
    if slot not in SLOTS:
        die(f"cannot read the active slot (current-slot = {v['current-slot']!r})")
    try:
        mv = int(v['battery-voltage'] or 0)
    except ValueError:
        mv = 0
    if mv and mv < MIN_MV:
        die(f"battery at {mv} mV: charge above {MIN_MV} mV first (the bootloader does not charge)")
    if not mv:
        print("note: battery level unknown: make sure the battery is above 50%")
    os.makedirs(backup_root(args), exist_ok=True)
    st = dict(serial=serial, slot=slot, msm_id=None, product=v['product'], variant=v['variant'],
              time=time.strftime('%Y-%m-%d %H:%M:%S'))
    json.dump(st, open(state_path(args), 'w'), indent=1)
    print(f"\nOK: device {serial}, active slot {slot}. Saved to {state_path(args)}.")
    print("Next: boot the device to EDL (see FLASHING.md), then run 'backup -d <device>'.")


def cmd_backup(args):
    dev = get_device(args)
    st = load_state(args)
    loader = args.loader
    if dev['loader'] and not loader:
        die(f"the {dev['name']} needs an EDL loader: --loader PATH ({dev['loader_hint']})")
    dd = device_dir(args, st)
    os.makedirs(dd, exist_ok=True)
    out = edl_ok(dev, loader, 'printgpt', what='connection')
    msm = load_state(args).get('msm_id')
    if msm is not None and dev['msm_id'] is not None and msm != dev['msm_id']:
        if not args.untested:
            die(f"EDL reports MSM ID 0x{msm:x}, the {dev['name']} has 0x{dev['msm_id']:x}: "
                f"wrong device? (testers: --untested)")
        print(f"WARNING: MSM ID 0x{msm:x} differs from the {dev['name']}'s 0x{dev['msm_id']:x} (--untested)")
    if msm is None:
        print("note: MSM ID not seen (EDL loader was already running): SoC not checked. "
              "Reboot to EDL again to have it checked.")
    open(os.path.join(dd, 'gpt.txt'), 'w').write(out)
    info = dict(device=args.device, soc=dev['soc'], product=st.get('product'), variant=st.get('variant'), serial=st['serial'], slot=st['slot'],
                msm_id=None if msm is None else f'0x{msm:x}', time=time.strftime('%Y-%m-%d %H:%M:%S'),
                partitions={})
    for s in SLOTS:
        part = f'abl_{s}'
        p1 = os.path.join(dd, f'{part}.stock.img')
        p2 = os.path.join(dd, f'{part}.verify.img')
        if os.path.exists(p1) and mbn_version(p1) not in (None,):
            # never overwrite an existing stock backup: it may already be the only copy
            print(f"{part}: keeping the existing backup {p1}")
        else:
            edl_read(dev, loader, part, p1)
        edl_read(dev, loader, part, p2)
        if not args.allow_changed and sha256(p1) != sha256(p2):
            die(f"{part}: the saved backup differs from the device. If FreeABL is already "
                f"flashed this is expected; otherwise read again (--allow-changed keeps the old backup)")
        os.remove(p2)
        v = mbn_version(p1)
        info['partitions'][part] = dict(sha256=sha256(p1), mbn=v)
        print(f"{part}: {'EMPTY (all zeros)' if v == 'empty' else f'signature v{v}' if v else 'NOT A SIGNED ABL'}"
              f"  sha256 {sha256(p1)[:16]}...")
    act = info['partitions'][f"abl_{st['slot']}"]['mbn']
    if act != dev['mbn']:
        die(f"the active abl_{st['slot']} has signature format {act}, FreeABL for the "
            f"{dev['name']} is v{dev['mbn']}: not flashing this device")
    json.dump(info, open(os.path.join(dd, 'backup.json'), 'w'), indent=1)
    with open(os.path.join(dd, 'SHA256SUMS'), 'w') as f:
        for s in SLOTS:
            f.write(f"{info['partitions'][f'abl_{s}']['sha256']}  abl_{s}.stock.img\n")
    print(f"\nBackup verified in {dd}. Copy that folder somewhere safe (another disk, the cloud).")
    if dev['validated'] != 'current':
        print(f"\nTester report (to add this device to FreeABL): soc {dev['soc']}, "
              f"MSM ID {info['msm_id'] or 'not seen'}, stock signature v{act}, "
              f"fastboot product {st.get('product') or '-'}, variant {st.get('variant') or '-'}, "
              f"storage {dev['memory'] or 'auto'}")


def load_backup(args, dev, st):
    dd = device_dir(args, st)
    try:
        info = json.load(open(os.path.join(dd, 'backup.json')))
    except (OSError, ValueError):
        die(f"no verified backup for device {st['serial']}: run 'backup' first")
    if info['device'] != args.device or info['soc'] != dev['soc']:
        die(f"the backup was made for '{info['device']}' ({info['soc']}), not '{args.device}' ({dev['soc']})")
    p = os.path.join(dd, f"abl_{st['slot']}.stock.img")
    if sha256(p) != info['partitions'][f"abl_{st['slot']}"]['sha256']:
        die(f"{p} changed since the backup was made")
    return dd, info, p


def cmd_flash(args):
    dev = get_device(args)
    st = load_state(args)
    dd, info, stock = load_backup(args, dev, st)
    if info['slot'] != st['slot']:
        die("the active slot changed since the backup: run 'check' and 'backup' again")
    img = os.path.abspath(args.image or default_image(dev))
    h = check_image(dev, img)
    part = f"abl_{st['slot']}"
    warn, phrase = '', f"FLASH-{part.upper()}"
    if dev['validated'] == 'earlier':
        warn = (f"\nWARNING: the {dev['name']} was validated with an earlier FreeABL build only. "
                f"This build was not run on it yet.")
    elif dev['validated'] == 'none':
        warn = (f"\nWARNING: FreeABL was never run on this device. If it does not boot, you need "
                f"EDL without Android (button combination or test point) and your backup to recover.")
    if dev['validated'] != 'current':
        if not args.untested:
            die(f"the {dev['name']} is not validated with this build: testers add --untested")
        phrase = f"FLASH-UNTESTED-{part.upper()}"
    confirm(phrase,
            f"\nAbout to write {os.path.basename(img)} (sha256 {h[:16]}...)\n"
            f"to {part} of the {dev['name']} {st['serial']} via {args.via}. Nothing else is written.{warn}")
    if args.via == 'edl':
        if dev['loader'] and not args.loader:
            die(f"--loader PATH needed ({dev['loader_hint']})")
        if edl_write_verified(dev, args.loader, part, img, dd):
            print(f"\nWRITE VERIFIED: {part} holds FreeABL.")
        else:
            print(f"\nREADBACK MISMATCH: restoring the stock {part}")
            if edl_write_verified(dev, args.loader, part, stock, dd):
                die(f"stock {part} restored and verified; FreeABL was not installed")
            die(f"stock {part} restore NOT verified: do not reboot; retry 'restore'")
        print(f"Next: 'reset -d {args.device}' (or hold Power) to boot FreeABL.")
    else:
        if fb_one_device() != st['serial']:
            die("the device in fastboot mode is not the one in the backup")
        rc, out = fb_run('flash', part, img, timeout=120)
        print(out.strip())
        if rc:
            if 'ritical' in out:
                die("the stock bootloader refuses to write abl (critical partition). "
                    "Use --via edl (no data loss), see FLASHING.md")
            die("fastboot flash failed")
        print(f"\nFLASHED {part}. fastboot cannot read it back; reboot with 'fastboot reboot'.")


def cmd_restore(args):
    dev = get_device(args)
    st = load_state(args)
    dd, info, stock = load_backup(args, dev, st)
    part = f"abl_{st['slot']}"
    if mbn_version(stock) in ('empty', None):
        die(f"the backup of {part} is not a signed ABL: refusing to write it")
    confirm(f"RESTORE-{part.upper()}",
            f"\nAbout to write the stock backup to {part} of {st['serial']} via {args.via}.")
    if args.via == 'edl':
        if dev['loader'] and not args.loader:
            die(f"--loader PATH needed ({dev['loader_hint']})")
        if not edl_write_verified(dev, args.loader, part, stock, dd):
            die(f"readback of {part} does not match the backup: do not reboot; retry")
        print(f"\nRESTORE VERIFIED: {part} is stock again.")
    else:
        if fb_one_device() != st['serial']:
            die("the device in fastboot mode is not the one in the backup")
        rc, out = fb_run('flash', part, stock, timeout=120)
        print(out.strip())
        if rc:
            die("fastboot flash failed: use --via edl")
        print(f"\nRESTORED {part}.")


def cmd_reset(args):
    dev = get_device(args)
    rc, out = edl_run(dev, args.loader, 'reset', memory=False)
    print(out.strip()[-500:])
    if rc:
        die("EDL reset failed: hold Power for 15 s")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--backup-dir', help='where backups go (default ~/FreeABL-backups)')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('devices')
    sub.add_parser('check')
    for name in ('backup', 'flash', 'restore', 'reset'):
        p = sub.add_parser(name)
        p.add_argument('-d', '--device', required=True, choices=sorted(DEVICES) + ['other'])
        p.add_argument('-l', '--loader', help='EDL firehose loader for the device')
        p.add_argument('--soc', choices=sorted(SOC_MBN), help='with -d other: the SoC of the device')
        p.add_argument('--memory', choices=('ufs', 'emmc'), help='storage type for EDL (default: per device, or auto)')
        p.add_argument('--untested', action='store_true',
                       help='testers: allow -d other, a different MSM ID, or a device not validated with this build')
        if name == 'backup':
            p.add_argument('--allow-changed', action='store_true',
                           help='keep an older backup even if the device now differs')
        if name in ('flash', 'restore'):
            p.add_argument('--via', choices=('edl', 'fastboot'), default='edl')
        if name == 'flash':
            p.add_argument('-i', '--image', help='FreeABL image (default: the one for the SoC in . or out/)')
    args = ap.parse_args()
    if getattr(args, 'loader', None):
        args.loader = os.path.abspath(args.loader)
        if not os.path.isfile(args.loader):
            die(f"loader not found: {args.loader}")
    globals()['STATE_FILE'] = state_path(args)
    globals()['cmd_' + args.cmd](args)


if __name__ == '__main__':
    main()
