#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""freeabl-flash: back up, flash and restore the ABL of a supported device.

  freeabl-flash.py devices                     supported devices
  freeabl-flash.py check                       fastboot: unlocked, slot, battery
  freeabl-flash.py backup  -d DEVICE           EDL: save the stock abl_a and abl_b
  freeabl-flash.py dump    -d DEVICE           EDL: save the whole firmware (read only)
  freeabl-flash.py flash   -d DEVICE [-i IMG]  write FreeABL to the active slot
  freeabl-flash.py restore -d DEVICE           write the saved stock ABL back
  freeabl-flash.py reset   -d DEVICE           EDL: reboot the device

Backups are kept per Android build (~/FreeABL-backups/SERIAL/androidVERSION-PATCH-…):
a stock ABL is restored only under the build it was saved on.

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
# android: Android builds (boot side) FreeABL was run on; another one needs
# --untested. Empty: none recorded yet, not checked.
DEVICES = {
    'odin': dict(name='AYN Odin', soc='sdm845', mbn=5, validated='current', android=[],
                 memory='ufs', msm_id=0x08b0e1, loader=None,
                 loader_hint='auto-selected by the edl tool (its Loaders/ directory)'),
    'odin2portal': dict(name='AYN Odin 2 Portal', soc='sm8550', mbn=7, validated='current',
                        android=[dict(os_version='13', patch='2024-01-01',
                                      fingerprint='qti/qssi/qssi:13/TKQ1.231222.001/Odin2Portal01172242:user/release-keys')],
                        memory='ufs', msm_id=0x2520e1, loader='xbl_s_devprg_ns.melf',
                        loader_hint='xbl_s_devprg_ns.melf from the AYANEO Pocket S firmware '
                                    'package (works on this device)'),
    'pockets': dict(name='AYANEO Pocket S', soc='sm8550', mbn=7, validated='current',
                    android=[dict(os_version='13', patch='2023-06-05',
                                  fingerprint='qti/qssi/qssi:13/TKQ1.230811.002/2840:user/release-keys')],
                    memory='ufs', msm_id=0x2520e1, loader='xbl_s_devprg_ns.melf',
                    loader_hint='xbl_s_devprg_ns.melf from the AYANEO Pocket S firmware package'),
    'pocketmax': dict(name='Mangmi Pocket Max', soc='sm8250', mbn=6, validated='earlier', android=[],
                      memory='ufs', msm_id=None, loader='prog_firehose_ddr.elf',
                      loader_hint='prog_firehose_ddr.elf from the Mangmi firmware package'),
    'airx': dict(name='Mangmi Air X (MQ66)', soc='sm6115', mbn=6, validated='earlier', android=[],
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
    """Write img to part, read it back, compare the image bytes. True or False;
    None when the edl tool itself failed (the write may have stopped half way)."""
    try:
        edl_ok(dev, loader, 'w', part, img, what=f'write of {part}')
        rb = os.path.join(workdir, f'{part}.readback.img')
        edl_read(dev, loader, part, rb)
    except SystemExit as e:
        print(e, file=sys.stderr)
        return None
    a = open(img, 'rb').read()
    return open(rb, 'rb').read()[:len(a)] == a


# a write that stopped half way leaves the partition broken: say so plainly
DONT_REBOOT = ("Do NOT reboot the device: it stays in EDL. Reconnect it (same cable, a USB port on the "
               "computer itself) and run 'restore' with --via edl.")


def freeabl_images(args):
    """FreeABL images this tool flashed or can see (out/, the current folder): [(length, sha256)]."""
    seen = []
    try:
        seen = [tuple(x) for x in json.load(open(os.path.join(backup_root(args), 'freeabl-images.json')))]
    except (OSError, ValueError):
        pass
    for d in (os.getcwd(), os.path.join(ROOT, 'out')):
        for f in (os.listdir(d) if os.path.isdir(d) else []):
            if re.fullmatch(r'abl_signed-.*-ESP-r34\.elf', f):
                b = open(os.path.join(d, f), 'rb').read()
                seen.append((len(b), hashlib.sha256(b).hexdigest()))
    return seen


def remember_image(args, img):
    """Keep the length and sha256 of an image this tool flashed, to recognise it on a slot later."""
    p = os.path.join(backup_root(args), 'freeabl-images.json')
    b = open(img, 'rb').read()
    entry = [len(b), hashlib.sha256(b).hexdigest()]
    try:
        seen = json.load(open(p))
    except (OSError, ValueError):
        seen = []
    if entry not in seen:
        json.dump(seen + [entry], open(p, 'w'))


def holds_freeabl(path, images):
    d = open(path, 'rb').read()
    return any(n <= len(d) and hashlib.sha256(d[:n]).hexdigest() == h for n, h in images)


def edl_read_many(dev, loader, parts, paths):
    """Several partitions in one EDL session."""
    edl_ok(dev, loader, 'r', ','.join(parts), ','.join(paths), what='read of ' + ', '.join(parts))
    for part, path in zip(parts, paths):
        if not os.path.isfile(path) or not os.path.getsize(path):
            die(f"EDL read of {part} gave no data")


def parse_gpt(out):
    """Partitions from 'edl printgpt': [dict(name, lun, offset, length)] in bytes; the first of a name wins."""
    parts, seen, lun = [], set(), 0
    for line in out.splitlines():
        m = re.match(r'\s*(?:Parsing )?Lun (\d+):', line)
        if m:
            lun = int(m.group(1))
            continue
        m = re.match(r'\s*(\S+?):?\s+Offset (0x[0-9a-fA-F]+), Length (0x[0-9a-fA-F]+)', line)
        if m and m.group(1) not in seen:
            seen.add(m.group(1))
            parts.append(dict(name=m.group(1), lun=lun, offset=int(m.group(2), 16), length=int(m.group(3), 16)))
    return parts


def sector_size(dev):
    return 512 if dev['memory'] == 'emmc' else 4096


# --- Android build ----------------------------------------------------------
# A stock ABL belongs to the Android build it came with. Read as the ABL itself
# does (CLO VerifiedBoot.c): the com.android.build.boot (or init_boot) properties
# of vbmeta_<slot>, else the boot image header. vbmeta_sha256 tells builds apart.
# Same rules as web/core.js.
def avb_props(d):
    props = {}
    if len(d) < 256 or d[:4] != b'AVB0':
        return props
    u64 = lambda o: struct.unpack_from('>Q', d, o)[0]
    o = 256 + u64(12) + u64(96)
    end = o + u64(104)
    if end > len(d):
        return props
    while o + 16 <= end:
        tag, n = u64(o), u64(o + 8)
        if tag == 0 and o + 32 <= end:
            kl, vl, k = u64(o + 16), u64(o + 24), o + 32
            if k + kl + 1 + vl <= end:
                props[d[k:k + kl].decode(errors='replace')] = d[k + kl + 1:k + kl + 1 + vl].decode(errors='replace')
        o += 16 + n
    return props


def boot_header_version(d):
    if len(d) < 48 or d[:8] != b'ANDROID!':
        return None
    hv, = struct.unpack_from('<I', d, 40)
    raw, = struct.unpack_from('<I', d, 16 if hv >= 3 else 44)
    if not raw:
        return None
    ver, lvl = raw >> 11, raw & 0x7ff
    abc = [(ver >> 14) & 127, (ver >> 7) & 127, ver & 127]
    while len(abc) > 1 and abc[-1] == 0:
        abc.pop()
    return dict(os_version='.'.join(map(str, abc)), patch=f"{2000 + (lvl >> 4)}-{lvl & 15:02d}")


def android_from(vb, sysvb, head):
    """The build from the bytes of vbmeta_<slot>, vbmeta_system_<slot> and the boot header (each may be None)."""
    props, sysp = avb_props(vb or b''), avb_props(sysvb or b'')
    prop = lambda k: props.get(f'com.android.build.boot.{k}') or props.get(f'com.android.build.init_boot.{k}')
    os_v, patch = prop('os_version'), prop('security_patch')
    if not (os_v and patch):
        h = boot_header_version(head or b'')
        if h:
            os_v, patch = h['os_version'], h['patch']
    os_v = os_v or props.get('com.android.build.vendor.os_version')
    patch = patch or props.get('com.android.build.vendor.security_patch')
    if vb is None and not os_v:
        return None
    return dict(os_version=os_v, patch=patch,
                system_os_version=sysp.get('com.android.build.system.os_version'),
                system_patch=sysp.get('com.android.build.system.security_patch'),
                fingerprint=sysp.get('com.android.build.system.fingerprint') or prop('fingerprint')
                or props.get('com.android.build.vendor.fingerprint'),
                vbmeta_sha256=hashlib.sha256(vb).hexdigest() if vb is not None else None)


def android_build(dev, loader, slot, gpt, work):
    """The Android build on a slot, over EDL (read only), or None."""
    names = {p['name']: p for p in gpt}
    os.makedirs(work, exist_ok=True)
    want = [p for p in (f'vbmeta_{slot}', f'vbmeta_system_{slot}') if p in names]
    got = {}
    if want:
        paths = [os.path.join(work, f'{p}.img') for p in want]
        edl_read_many(dev, loader, want, paths)
        got = {p: open(path, 'rb').read() for p, path in zip(want, paths)}
    head = None
    vb = got.get(f'vbmeta_{slot}')
    pre = android_from(vb, got.get(f'vbmeta_system_{slot}'), None)
    if not (pre and pre['os_version'] and pre['patch']):
        for b in (f'boot_{slot}', f'init_boot_{slot}'):
            if b in names and head is None:
                p, ss = names[b], sector_size(dev)
                path = os.path.join(work, f'{b}.head')
                edl_ok(dev, loader, 'rs', str(p['offset'] // ss), str(max(1, 4096 // ss)), path, f"--lun={p['lun']}",
                       what=f'read of the {b} header')
                head = open(path, 'rb').read()
                if not boot_header_version(head):
                    head = None
    return android_from(vb, got.get(f'vbmeta_system_{slot}'), head)


def fb_android():
    """The build as FreeABL's fastboot reports it (FreeABL 0.2 and later), or None."""
    a = dict(os_version=fb_getvar('android-os-version') or None, patch=fb_getvar('android-security-patch') or None,
             system_os_version=None, system_patch=None, fingerprint=None,
             vbmeta_sha256=fb_getvar('vbmeta-sha256') or None)
    return a if a['os_version'] or a['vbmeta_sha256'] else None


def android_label(a):
    if not a:
        return 'Android version not known'
    os_v, patch = a.get('system_os_version') or a.get('os_version'), a.get('system_patch') or a.get('patch')
    user = f"Android {os_v or '?'}, security patch {patch or '?'}"
    if a.get('os_version') and (a['os_version'] != os_v or a.get('patch') != patch):
        return f"{user} (boot side: Android {a['os_version']}, {a.get('patch') or '?'})"
    return user


def same_build(a, b):
    """True or False when the two can be compared, None when they cannot."""
    if not a or not b:
        return None
    if a.get('vbmeta_sha256') and b.get('vbmeta_sha256'):
        return a['vbmeta_sha256'] == b['vbmeta_sha256']
    if all((a.get('os_version'), a.get('patch'), b.get('os_version'), b.get('patch'))):
        return a['os_version'] == b['os_version'] and a['patch'] == b['patch']
    return None


def android_validated(dev, a):
    """(listed, ok, exact): the device has validated builds recorded; this version and patch
    month is among them; this very build (fingerprint) too."""
    lst = dev.get('android') or []
    if not lst:
        return False, False, False
    same = [x for x in lst if a and a.get('patch') and str(x['os_version']) == str(a.get('os_version'))
            and x['patch'][:7] == a['patch'][:7]]
    return True, bool(same), any(x.get('fingerprint') and x['fingerprint'] == a.get('fingerprint') for x in same)


def build_dir_name(a):
    """Backup folder of one Android build."""
    if not a:
        return 'android-unknown'
    os_v, patch = a.get('system_os_version') or a.get('os_version'), a.get('system_patch') or a.get('patch')
    tag = f"android{os_v or ''}-{patch or 'unknown'}"
    return f"{tag}-{a['vbmeta_sha256'][:8]}" if a.get('vbmeta_sha256') else tag


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


def build_dirs(args, st):
    """[(dir, backup.json)] of this device, newest first; the folder itself holds backups of earlier versions of this tool."""
    top = device_dir(args, st)
    found = []
    for d in [top] + ([os.path.join(top, x) for x in os.listdir(top)] if os.path.isdir(top) else []):
        try:
            found.append((d, json.load(open(os.path.join(d, 'backup.json')))))
        except (OSError, ValueError):
            pass
    return sorted(found, key=lambda x: x[1].get('time', ''), reverse=True)


def get_device(args):
    if args.device == 'other':
        if not args.soc:
            die("-d other needs --soc SOC (one of: " + ', '.join(SOC_MBN) + ")")
        if not args.untested and args.cmd in ('backup', 'dump', 'flash'):
            die("-d other is for testers: add --untested (see FLASHING.md, 'Devices not in the list')")
        return dict(name=f'unlisted {args.soc} device', soc=args.soc, mbn=SOC_MBN[args.soc],
                    validated='none', android=[], memory=args.memory, msm_id=None, loader=None,
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
                                   'battery-voltage', 'battery-soc-ok', 'freeabl')}
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
    # FreeABL 0.2 and later says so; the bootloader running is the one on the active slot
    if v['freeabl'] == 'yes':
        print(f"FreeABL is running: abl_{slot} holds FreeABL, not the stock bootloader")
    st = dict(serial=serial, slot=slot, msm_id=None, product=v['product'], variant=v['variant'],
              freeabl=v['freeabl'] == 'yes', time=time.strftime('%Y-%m-%d %H:%M:%S'))
    json.dump(st, open(state_path(args), 'w'), indent=1)
    print(f"\nOK: device {serial}, active slot {slot}. Saved to {state_path(args)}.")
    print("Next: boot the device to EDL (see FLASHING.md), then run 'backup -d <device>'.")


def edl_connect(args, dev, st):
    """Loader check, connection, MSM ID check; returns the partition list."""
    if dev['loader'] and not args.loader:
        die(f"the {dev['name']} needs an EDL loader: --loader PATH ({dev['loader_hint']})")
    out = edl_ok(dev, args.loader, 'printgpt', what='connection')
    msm = load_state(args).get('msm_id')
    if msm is not None and dev['msm_id'] is not None and msm != dev['msm_id']:
        if not args.untested:
            die(f"EDL reports MSM ID 0x{msm:x}, the {dev['name']} has 0x{dev['msm_id']:x}: "
                f"wrong device? (testers: --untested)")
        print(f"WARNING: MSM ID 0x{msm:x} differs from the {dev['name']}'s 0x{dev['msm_id']:x} (--untested)")
    if msm is None:
        print("note: MSM ID not seen (EDL loader was already running): SoC not checked. "
              "Reboot to EDL again to have it checked.")
    return out, parse_gpt(out), msm


def cmd_backup(args):
    dev = get_device(args)
    st = load_state(args)
    loader = args.loader
    out, gpt, msm = edl_connect(args, dev, st)
    android = android_build(dev, loader, st['slot'], gpt, os.path.join(device_dir(args, st), '.work'))
    print(f"slot {st['slot']}: {android_label(android)}" + (f" ({android['fingerprint']})" if android and android.get('fingerprint') else ''))
    # one folder per Android build: an update brings a new stock ABL and a new folder
    dd = os.path.join(device_dir(args, st), build_dir_name(android))
    os.makedirs(dd, exist_ok=True)
    open(os.path.join(dd, 'gpt.txt'), 'w').write(out)
    info = dict(device=args.device, soc=dev['soc'], product=st.get('product'), variant=st.get('variant'), serial=st['serial'], slot=st['slot'],
                msm_id=None if msm is None else f'0x{msm:x}', time=time.strftime('%Y-%m-%d %H:%M:%S'),
                android=android, partitions={})
    images = freeabl_images(args)
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
        freeabl = (s == st['slot'] and st.get('freeabl')) or holds_freeabl(p1, images)
        if freeabl and s == st['slot']:
            os.remove(p1)
            die(f"{part}, the active slot, holds FreeABL: a backup now would keep FreeABL, not the stock "
                "bootloader. Keep the backup you made before installing FreeABL; to put a new FreeABL build "
                "on, use 'flash --via fastboot'. After an Android update the device runs its new stock "
                "bootloader again and can be backed up.")
        info['partitions'][part] = dict(sha256=sha256(p1), mbn=v, **({'freeabl': True} if freeabl else {}))
        if freeabl:
            print(f"{part} holds FreeABL (left from before an Android update?): kept, never restored")
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
    st = load_state(args)
    st['backup_dir'] = dd
    json.dump(st, open(state_path(args), 'w'), indent=1)
    print(f"\nBackup verified in {dd}. Copy that folder somewhere safe (another disk, the cloud).")
    if dev['validated'] != 'current':
        print(f"\nTester report (to add this device to FreeABL): soc {dev['soc']}, "
              f"MSM ID {info['msm_id'] or 'not seen'}, stock signature v{act}, "
              f"fastboot product {st.get('product') or '-'}, variant {st.get('variant') or '-'}, "
              f"storage {dev['memory'] or 'auto'}, {android_label(android)}")


DUMP_MAX_BYTES = 128 << 20
DUMP_SKIP = ('userdata', 'super')


def cmd_dump(args):
    """Every partition of both slots up to DUMP_MAX_BYTES, except userdata and super. Read only."""
    dev = get_device(args)
    st = load_state(args)
    out, gpt, msm = edl_connect(args, dev, st)
    android = android_build(dev, args.loader, st['slot'], gpt, os.path.join(device_dir(args, st), '.work'))
    dd = os.path.join(device_dir(args, st), build_dir_name(android), 'firmware')
    os.makedirs(dd, exist_ok=True)
    parts = [p for p in gpt if p['name'] not in DUMP_SKIP and p['length'] <= DUMP_MAX_BYTES]
    skipped = [f"{p['name']} ({p['length'] >> 20} MiB)" for p in gpt if p not in parts]
    print(f"{len(parts)} partitions, {sum(p['length'] for p in parts) >> 20} MiB, {android_label(android)}. "
          f"Left out: {', '.join(skipped) or 'none'}")
    paths = [os.path.join(dd, f"{p['name']}.img") for p in parts]
    edl_read_many(dev, args.loader, [p['name'] for p in parts], paths)
    info = dict(device=args.device, soc=dev['soc'], serial=st['serial'], slot=st['slot'],
                msm_id=None if msm is None else f'0x{msm:x}', time=time.strftime('%Y-%m-%d %H:%M:%S'),
                android=android, firmware={})
    with open(os.path.join(dd, 'SHA256SUMS'), 'w') as f:
        for p, path in zip(parts, paths):
            h = sha256(path)
            info['firmware'][p['name']] = dict(lun=p['lun'], offset=p['offset'], length=p['length'], sha256=h)
            f.write(f"{h}  {p['name']}.img\n")
    json.dump(info, open(os.path.join(dd, 'firmware.json'), 'w'), indent=1)
    open(os.path.join(dd, 'gpt.txt'), 'w').write(out)
    print(f"\nFirmware saved in {dd}. It holds this device's own data: keep it private.")


def load_backup(args, dev, st, android=None):
    """The backup to use: the one made on the Android build the device runs (android, when known),
    else the one 'backup' made last. Returns (dir, info, stock image of the active slot, same_build)."""
    found = build_dirs(args, st)
    if not found:
        die(f"no verified backup for device {st['serial']}: run 'backup' first")
    pick, same = None, None
    if android:
        for d, info in found:
            if same_build(info.get('android'), android):
                pick, same = (d, info), True
                break
        if not pick and all(same_build(i.get('android'), android) is False for _, i in found):
            have = '; '.join(f"{android_label(i.get('android'))} in {d}" for d, i in found)
            die(f"the device runs {android_label(android)} (an Android update since?), and the backups are "
                f"from other builds: {have}. Their bootloader may not start this Android. Make a backup on "
                f"this build ('backup'), or restore with your vendor's firmware package")
    if not pick:
        last = st.get('backup_dir')
        pick = next(((d, i) for d, i in found if d == last), found[0])
        same = same_build(pick[1].get('android'), android)
    dd, info = pick
    if info['device'] != args.device or info['soc'] != dev['soc']:
        die(f"the backup was made for '{info['device']}' ({info['soc']}), not '{args.device}' ({dev['soc']})")
    p = os.path.join(dd, f"abl_{st['slot']}.stock.img")
    if sha256(p) != info['partitions'][f"abl_{st['slot']}"]['sha256']:
        die(f"{p} changed since the backup was made")
    return dd, info, p, same


def cmd_flash(args):
    dev = get_device(args)
    st = load_state(args)
    if args.via == 'fastboot' and fb_one_device() != st['serial']:
        die("the device in fastboot mode is not the one in the backup")
    fba = fb_android() if args.via == 'fastboot' else None
    dd, info, stock, _ = load_backup(args, dev, st, fba)
    if info['slot'] != st['slot']:
        die("the active slot changed since the backup (an Android update?): run 'check' and 'backup' again")
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
    # the Android build: read over EDL at the backup, or from FreeABL's fastboot
    android = fba or info.get('android')
    listed, ok, exact = android_validated(dev, android)
    if not listed:
        print(f"note: no validated Android versions recorded for the {dev['name']}; this one is {android_label(android)}")
    elif ok and not exact and android.get('fingerprint'):
        print(f"note: this exact build ({android['fingerprint']}) was not run on yet; FreeABL was on one "
              "with the same Android version and patch")
    elif not ok:
        was = ', '.join(f"Android {x['os_version']} {x['patch'][:7]}" for x in dev['android'])
        warn += (f"\nWARNING: FreeABL was not run on {android_label(android)} on the {dev['name']} (validated: {was}). "
                 f"If Android does not start, FreeABL's menu and fastboot still do: 'restore --via fastboot'.")
    if dev['validated'] != 'current' or (listed and not ok):
        if not args.untested:
            die(f"the {dev['name']} is not validated with this build: testers add --untested" if dev['validated'] != 'current'
                else f"FreeABL was not run on {android_label(android)} on the {dev['name']} yet: testers add --untested")
        phrase = f"FLASH-UNTESTED-{part.upper()}"
    confirm(phrase,
            f"\nAbout to write {os.path.basename(img)} (sha256 {h[:16]}...)\n"
            f"to {part} of the {dev['name']} {st['serial']} via {args.via}. Nothing else is written.{warn}")
    if args.via == 'edl':
        if dev['loader'] and not args.loader:
            die(f"--loader PATH needed ({dev['loader_hint']})")
        ok = edl_write_verified(dev, args.loader, part, img, dd)
        if ok:
            remember_image(args, img)
            print(f"\nWRITE VERIFIED: {part} holds FreeABL.")
        else:
            why = 'the copy read back differs' if ok is False else 'the write stopped'
            print(f"\n{why}: putting the stock {part} back")
            if edl_write_verified(dev, args.loader, part, stock, dd):
                die(f"{why}; stock {part} restored and verified, FreeABL was not installed")
            die(f"{why}, and the stock {part} could not be put back. {DONT_REBOOT}")
        print(f"Next: 'reset -d {args.device}' (or hold Power) to boot FreeABL.")
    else:
        rc, out = fb_run('flash', part, img, timeout=120)
        print(out.strip())
        if rc:
            if 'ritical' in out:
                die("the stock bootloader refuses to write abl (critical partition). "
                    "Use --via edl (no data loss), see FLASHING.md")
            die("fastboot flash failed")
        remember_image(args, img)
        print(f"\nFLASHED {part}. fastboot cannot read it back; reboot with 'fastboot reboot'.")


def cmd_restore(args):
    dev = get_device(args)
    st = load_state(args)
    # a stock ABL from another Android build may not start this one
    if args.via == 'edl':
        _, gpt, _ = edl_connect(args, dev, st)
        now = android_build(dev, args.loader, st['slot'], gpt, os.path.join(device_dir(args, st), '.work'))
    else:
        if fb_one_device() != st['serial']:
            die("the device in fastboot mode is not the one in the backup")
        now = fb_android()
    dd, info, stock, same = load_backup(args, dev, st, now)
    part = f"abl_{st['slot']}"
    if mbn_version(stock) in ('empty', None):
        die(f"the backup of {part} is not a signed ABL: refusing to write it")
    if info['partitions'][part].get('freeabl'):
        die(f"the backup's {part} is FreeABL, not stock: use a backup made on this Android build before "
            "FreeABL was installed, or your vendor's firmware package")
    note = ''
    if same is None:
        note = ("\nNote: this backup does not record its Android build (made by an earlier version of this tool): not checked."
                if not info.get('android') else
                "\nNote: this FreeABL cannot tell the Android build. If Android was updated since this backup, "
                "cancel and restore with --via edl, which checks it.")
    else:
        print(f"backup {dd} and device on the same Android build ({android_label(now)})")
    confirm(f"RESTORE-{part.upper()}",
            f"\nAbout to write the stock backup to {part} of {st['serial']} via {args.via}.{note}")
    if args.via == 'edl':
        ok = edl_write_verified(dev, args.loader, part, stock, dd)
        if ok is None:
            die(f"the write of {part} stopped. {DONT_REBOOT}")
        if not ok:
            die(f"readback of {part} does not match the backup. {DONT_REBOOT}")
        print(f"\nRESTORE VERIFIED: {part} is stock again.")
    else:
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
    for name in ('backup', 'dump', 'flash', 'restore', 'reset'):
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
