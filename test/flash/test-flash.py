#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests for tools/freeabl-flash.py against a simulated device (fakedev.py)."""
import hashlib, json, os, shutil, struct, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, '..', '..', 'tools', 'freeabl-flash.py')
SIZE = 1 << 20
failures = []


def signed_elf(version, tag):
    """Minimal ELF32 with a hash segment whose MBN header has the given version."""
    eh = b'\x7fELF\x01\x01\x01' + b'\0' * 9 + struct.pack('<HHIIIIIHHHHHH', 2, 40, 1, 0, 52, 0, 0, 52, 32, 1, 40, 0, 0)
    ph = struct.pack('<8I', 0, 0x100, 0, 0, 0x40, 0x40, 2 << 24, 0x1000)
    d = bytearray(eh + ph)
    d += b'\0' * (0x100 - len(d))
    d += struct.pack('<II', 0, version) + b'\0' * 0x38
    d += hashlib.sha256(tag.encode()).digest() * 64
    return bytes(d)


def vbmeta_image(props, size=64 * 1024):
    """An AVB vbmeta image (unsigned) holding property descriptors."""
    descs = b''
    for k, v in props.items():
        kb, vb = k.encode(), v.encode()
        n = (16 + len(kb) + 1 + len(vb) + 1 + 7) // 8 * 8
        descs += struct.pack('>QQQQ', 0, n, len(kb), len(vb)) + (kb + b'\0' + vb + b'\0').ljust(n - 16, b'\0')
    h = bytearray(256)
    h[:4] = b'AVB0'
    struct.pack_into('>Q', h, 20, len(descs))
    struct.pack_into('>QQ', h, 96, 0, len(descs))
    return (bytes(h) + descs).ljust(size, b'\0')


def build(os_v='13', patch='2023-06-05', gki=False):
    """vbmeta and vbmeta_system of an Android build, as in web/sim.js."""
    b = 'init_boot' if gki else 'boot'
    return (vbmeta_image({f'com.android.build.{b}.os_version': os_v, f'com.android.build.{b}.security_patch': patch}),
            vbmeta_image({'com.android.build.system.os_version': os_v, 'com.android.build.system.security_patch': patch,
                          'com.android.build.system.fingerprint': 'qti/qssi/qssi:13/TKQ1.230811.002/2840:user/release-keys' if (os_v, patch) == ('13', '2023-06-05')
                          else f'AYN/kalama/kalama:{os_v}/TKQ1/eng:user/release-keys'}))


def boot_header(os_v='13', patch='2023-06'):
    a, b, c = (list(map(int, os_v.split('.'))) + [0, 0])[:3]
    y, m = map(int, patch.split('-')[:2])
    h = bytearray(4096)
    h[:8] = b'ANDROID!'
    struct.pack_into('<I', h, 16, ((((a << 14) | (b << 7) | c) << 11) | ((y - 2000) << 4) | m))
    struct.pack_into('<I', h, 40, 4)
    return bytes(h)


class Dev:
    def __init__(self, stock_a, stock_b, android=({}, {}), **v):
        self.dir = tempfile.mkdtemp(prefix='fakedev-')
        self.bin = os.path.join(self.dir, 'bin')
        os.mkdir(self.bin)
        for t in ('fastboot', 'edl'):
            os.symlink(os.path.join(HERE, 'fakedev.py'), os.path.join(self.bin, t))
        self.vars = dict(serialno='TEST1234', unlocked='yes', secure='no', product='kalama',
                         variant='SGP UFS', **{'current-slot': 'a', 'battery-voltage': '4100'},
                         msm=0x1f20e1)
        self.vars.update(v)
        self.vars = {k: x for k, x in self.vars.items() if x is not None}
        self.vars['parts'] = ['abl_a', 'abl_b', 'xbl_a', 'xbl_b']
        for p, data in (('abl_a', stock_a), ('abl_b', stock_b)):
            open(os.path.join(self.dir, p), 'wb').write(data.ljust(SIZE, b'\0'))
        for p in ('xbl_a', 'xbl_b'):
            open(os.path.join(self.dir, p), 'wb').write(p.encode() * 1000)
        for slot, b in zip('ab', android):
            self.update(slot, b)

    def update(self, slot, b):
        """What an Android update writes to a slot, as far as the checks see it; None: no vbmeta (older Android)."""
        parts = [p for p in self.vars['parts'] if not p.endswith(f'_{slot}') or p.startswith(('abl_', 'xbl_'))]
        if b is not None:
            vb, sysvb = build(**b)
            for name, data in ((f'vbmeta_{slot}', vb), (f'vbmeta_system_{slot}', sysvb),
                               (f'boot_{slot}', boot_header(b.get('os_v', '13'), b.get('patch', '2023-06')))):
                open(os.path.join(self.dir, name), 'wb').write(data)
                parts.append(name)
        self.vars['parts'] = parts
        json.dump(self.vars, open(os.path.join(self.dir, 'vars.json'), 'w'))
        self.backups = os.path.join(self.dir, 'backups')
        self.loader = os.path.join(self.dir, 'loader.melf')
        open(self.loader, 'wb').write(b'loader')

    def run(self, *args, stdin=''):
        env = dict(os.environ, FAKEDEV=self.dir, PATH=self.bin + os.pathsep + os.environ['PATH'], FREEABL_NO_FETCH='1')
        env.pop('FASTBOOT', None)
        env.pop('FREEABL_EDL', None)
        r = subprocess.run([sys.executable, TOOL, '--backup-dir', self.backups, *args],
                           input=stdin, capture_output=True, text=True, env=env, cwd=self.dir)
        return r.returncode, r.stdout + r.stderr

    def part(self, p):
        return open(os.path.join(self.dir, p), 'rb').read()

    def image(self, data, name='abl_signed-SM8550-ESP-r34.elf', sums=True):
        p = os.path.join(self.dir, name)
        open(p, 'wb').write(data)
        if sums:
            open(p + '.sha256', 'w').write(f"{hashlib.sha256(data).hexdigest()}  {name}\n")
        return p


def check(name, cond, out=''):
    print(f"{'ok  ' if cond else 'FAIL'} {name}")
    if not cond:
        failures.append(name)
        print('    ' + out.strip().replace('\n', '\n    ')[-1500:])


STOCK7, STOCK5 = signed_elf(7, 'stock'), signed_elf(5, 'stock845')
FREE7, FREE5 = signed_elf(7, 'freeabl'), signed_elf(5, 'freeabl845')
EMPTY = b''
L = lambda d: ('-l', d.loader)

# 1. happy path: check, backup, flash over EDL, restore over EDL
d = Dev(STOCK7, EMPTY)
rc, out = d.run('check'); check('check: unlocked device accepted', rc == 0, out)
rc, out = d.run('backup', '-d', 'pockets', *L(d)); check('backup: ok, abl_b empty', rc == 0 and 'EMPTY' in out, out)
bk = os.path.join(d.backups, 'TEST1234', 'android13-2023-06-05-' + hashlib.sha256(d.part('vbmeta_a')).hexdigest()[:8])
check('backup: in the folder of its Android build', os.path.isfile(os.path.join(bk, 'backup.json')), str(os.listdir(os.path.dirname(bk))))
check('backup: stock abl_a saved', open(os.path.join(bk, 'abl_a.stock.img'), 'rb').read() == d.part('abl_a'))
img = d.image(FREE7)
rc, out = d.run('flash', '-d', 'pockets', *L(d), '-i', img, stdin='nope\n')
check('flash: wrong confirmation aborts, nothing written', rc != 0 and d.part('abl_a')[:len(STOCK7)] == STOCK7, out)
rc, out = d.run('flash', '-d', 'pockets', *L(d), '-i', img, stdin='FLASH-ABL_A\n')
check('flash: written and verified', rc == 0 and 'WRITE VERIFIED' in out and d.part('abl_a')[:len(FREE7)] == FREE7, out)
check('flash: abl_b untouched', not d.part('abl_b').strip(b'\0'))
calls = open(os.path.join(d.dir, 'calls.log')).read()
check('flash: only abl_a written', all(l.split()[2] == 'abl_a' for l in calls.splitlines() if l.startswith('edl w ')), calls)
rc, out = d.run('backup', '-d', 'pockets', *L(d))
check('backup again after flash: refuses, keeps stock backup', rc != 0 and
      open(os.path.join(bk, 'abl_a.stock.img'), 'rb').read()[:len(STOCK7)] == STOCK7, out)
rc, out = d.run('restore', '-d', 'pockets', *L(d), stdin='RESTORE-ABL_A\n')
check('restore: stock back and verified', rc == 0 and d.part('abl_a')[:len(STOCK7)] == STOCK7, out)
shutil.rmtree(d.dir)

# 2. locked bootloader
d = Dev(STOCK7, STOCK7, unlocked='no')
rc, out = d.run('check'); check('check: locked device refused', rc != 0 and 'locked' in out, out)
shutil.rmtree(d.dir)

# 2b. secure boot on, or not reported
d = Dev(STOCK7, STOCK7, secure='yes')
rc, out = d.run('check'); check('check: secure boot on refused', rc != 0 and 'secure boot is on' in out, out)
shutil.rmtree(d.dir)
d = Dev(STOCK7, STOCK7, secure=None)
rc, out = d.run('check'); check('check: secure not reported refused', rc != 0 and 'secure boot is off' in out, out)
shutil.rmtree(d.dir)

# 3. low battery
d = Dev(STOCK7, STOCK7, **{'battery-voltage': '3500'})
rc, out = d.run('check'); check('check: low battery refused', rc != 0 and 'battery' in out, out)
shutil.rmtree(d.dir)

# 4. flash without backup
d = Dev(STOCK7, STOCK7)
d.run('check')
rc, out = d.run('flash', '-d', 'pockets', *L(d), '-i', d.image(FREE7), stdin='FLASH-ABL_A\n')
check('flash: refused without backup', rc != 0 and 'backup' in out and d.part('abl_a')[:len(STOCK7)] == STOCK7, out)
shutil.rmtree(d.dir)

# 5. wrong device: MSM ID mismatch, and stock signature format mismatch
d = Dev(STOCK7, STOCK7, msm=0x08b0e1)
d.run('check')
rc, out = d.run('backup', '-d', 'pockets', *L(d)); check('backup: MSM ID mismatch refused', rc != 0 and 'MSM ID' in out, out)
shutil.rmtree(d.dir)
d = Dev(STOCK5, STOCK5, msm=0x08b0e1)
d.run('check')
rc, out = d.run('backup', '-d', 'odin'); check('backup: odin v5 ok, no loader needed', rc == 0, out)
rc, out = d.run('flash', '-d', 'odin', '-i', d.image(FREE7), stdin='FLASH-ABL_A\n')
check('flash: v7 image refused on a v5 device', rc != 0 and 'signature format' in out, out)
rc, out = d.run('flash', '-d', 'odin', '-i', d.image(FREE5, 'abl_signed-SDM845-ESP-r34.elf'), stdin='FLASH-ABL_A\n')
check('flash: odin v5 image ok', rc == 0 and d.part('abl_a')[:len(FREE5)] == FREE5, out)
shutil.rmtree(d.dir)

# 6. bad checksum
d = Dev(STOCK7, STOCK7)
d.run('check'); d.run('backup', '-d', 'pockets', *L(d))
img = d.image(FREE7)
open(img + '.sha256', 'w').write('0' * 64 + '  abl_signed-SM8550-ESP-r34.elf\n')
rc, out = d.run('flash', '-d', 'pockets', *L(d), '-i', img, stdin='FLASH-ABL_A\n')
check('flash: checksum mismatch refused', rc != 0 and 'does not match' in out, out)
shutil.rmtree(d.dir)

# 7. write corrupted: stock restored automatically (corruption only on the first write)
d = Dev(STOCK7, STOCK7)
d.run('check'); d.run('backup', '-d', 'pockets', *L(d))
d.vars['corrupt'] = True
json.dump(d.vars, open(os.path.join(d.dir, 'vars.json'), 'w'))
rc, out = d.run('flash', '-d', 'pockets', *L(d), '-i', d.image(FREE7), stdin='FLASH-ABL_A\n')
check('flash: readback mismatch detected, not reported as success', rc != 0 and 'read back differs' in out and 'Do NOT reboot' in out, out)
shutil.rmtree(d.dir)

# 8. slot b active: flash goes to abl_b only
d = Dev(STOCK7, STOCK7, **{'current-slot': 'b'})
d.run('check'); d.run('backup', '-d', 'pockets', *L(d))
rc, out = d.run('flash', '-d', 'pockets', *L(d), '-i', d.image(FREE7), stdin='FLASH-ABL_B\n')
check('flash: slot b active -> abl_b only', rc == 0 and d.part('abl_b')[:len(FREE7)] == FREE7
      and d.part('abl_a')[:len(STOCK7)] == STOCK7, out)
shutil.rmtree(d.dir)

# 9. fastboot path: critical partition refusal explained
d = Dev(STOCK7, STOCK7, critical=True)
d.run('check'); d.run('backup', '-d', 'pockets', *L(d))
rc, out = d.run('flash', '-d', 'pockets', '--via', 'fastboot', '-i', d.image(FREE7), stdin='FLASH-ABL_A\n')
check('flash --via fastboot: critical refusal explained', rc != 0 and '--via edl' in out, out)
shutil.rmtree(d.dir)

# 10. loader required for devices that need one; untested SoCs not offered
d = Dev(STOCK7, STOCK7)
d.run('check')
rc, out = d.run('backup', '-d', 'pockets'); check('backup: loader required', rc != 0 and '--loader' in out, out)
rc, out = d.run('flash', '-d', 'sm8650'); check('sm8650 not offered', rc != 0, out)
shutil.rmtree(d.dir)

# 11. tester mode: devices and SoCs not in the list, other chip IDs
d = Dev(STOCK7, EMPTY, msm=0x99e1)
d.run('check')
rc, out = d.run('backup', '-d', 'other', '--soc', 'sm8650'); check('other: --untested required', rc != 0 and '--untested' in out, out)
rc, out = d.run('backup', '-d', 'other', '--untested'); check('other: --soc required', rc != 0 and '--soc' in out, out)
rc, out = d.run('backup', '-d', 'pockets', '--soc', 'sm8650', *L(d)); check('listed device with another SoC refused', rc != 0 and '-d other' in out, out)
rc, out = d.run('backup', '-d', 'pockets', *L(d)); check('MSM ID mismatch refused without --untested', rc != 0 and '--untested' in out, out)
rc, out = d.run('backup', '-d', 'other', '--soc', 'sm8650', '--untested', *L(d))
check('other: backup ok, tester report printed', rc == 0 and 'Tester report' in out and '0x99e1' in out, out)
img = d.image(FREE7, 'abl_signed-SM8650-ESP-r34.elf')
rc, out = d.run('flash', '-d', 'other', '--soc', 'sm8650', *L(d), '-i', img, stdin='FLASH-UNTESTED-ABL_A\n')
check('other: flash refused without --untested', rc != 0 and d.part('abl_a')[:len(STOCK7)] == STOCK7, out)
rc, out = d.run('flash', '-d', 'other', '--soc', 'sm8650', '--untested', *L(d), '-i', img, stdin='FLASH-ABL_A\n')
check('other: plain confirmation not enough', rc != 0 and d.part('abl_a')[:len(STOCK7)] == STOCK7, out)
rc, out = d.run('flash', '-d', 'other', '--soc', 'sm8550', '--untested', *L(d), '-i', d.image(FREE7), stdin='FLASH-UNTESTED-ABL_A\n')
check('other: backup made for another SoC refused', rc != 0 and 'backup was made' in out, out)
rc, out = d.run('flash', '-d', 'other', '--soc', 'sm8650', '--untested', *L(d), '-i', img, stdin='FLASH-UNTESTED-ABL_A\n')
check('other: flash ok with --untested and the untested phrase', rc == 0 and d.part('abl_a')[:len(FREE7)] == FREE7, out)
rc, out = d.run('restore', '-d', 'other', '--soc', 'sm8650', *L(d), stdin='RESTORE-ABL_A\n')
check('other: restore works without --untested', rc == 0 and d.part('abl_a')[:len(STOCK7)] == STOCK7, out)
shutil.rmtree(d.dir)
d = Dev(STOCK7, STOCK7, msm=0x99e1)
d.run('check')
rc, out = d.run('backup', '-d', 'pockets', '--untested', *L(d)); check('MSM ID mismatch allowed with --untested', rc == 0 and 'WARNING' in out, out)
shutil.rmtree(d.dir)
d = Dev(signed_elf(6, 'stock'), EMPTY, msm=0x99e1)
d.run('check')
rc, out = d.run('backup', '-d', 'other', '--soc', 'sm8550', '--untested', *L(d))
check('other: stock signature mismatch still refused', rc != 0 and 'signature format' in out, out)
shutil.rmtree(d.dir)
d = Dev(signed_elf(6, 'stock'), EMPTY, msm=0xce0e1)
d.run('check'); d.run('backup', '-d', 'pocketmax', *L(d))
img = d.image(signed_elf(6, 'free'), 'abl_signed-SM8250-ESP-r34.elf')
rc, out = d.run('flash', '-d', 'pocketmax', *L(d), '-i', img, stdin='FLASH-ABL_A\n')
check('earlier-build device needs --untested', rc != 0 and '--untested' in out, out)
rc, out = d.run('flash', '-d', 'pocketmax', '--untested', *L(d), '-i', img, stdin='FLASH-UNTESTED-ABL_A\n')
check('earlier-build device ok with --untested', rc == 0, out)
shutil.rmtree(d.dir)

# 13. Android builds: backups per build, restore only under the build of the backup
def bjson(d):
    found = []
    top = os.path.join(d.backups, 'TEST1234')
    for x in os.listdir(top):
        f = os.path.join(top, x, 'backup.json')
        if os.path.isfile(f):
            found.append((x, json.load(open(f))))
    return dict(found)

d = Dev(STOCK7, STOCK7)
d.run('check')
rc, out = d.run('backup', '-d', 'pockets', *L(d))
check('backup: Android build shown', rc == 0 and 'slot a: Android 13, security patch 2023-06-05' in out, out)
(name, info), = bjson(d).items()
check('backup: build recorded', info['android']['patch'] == '2023-06-05' and info['android']['vbmeta_sha256'] == hashlib.sha256(d.part('vbmeta_a')).hexdigest(), str(info))
img = d.image(FREE7)
d.run('flash', '-d', 'pockets', *L(d), '-i', img, stdin='FLASH-ABL_A\n')
d.update('a', dict(patch='2025-02-05'))        # two Android updates later, back on slot a
rc, out = d.run('restore', '-d', 'pockets', *L(d), stdin='RESTORE-ABL_A\n')
check('restore over EDL: backup from another build refused', rc != 0 and 'backups are from other builds' in out
      and d.part('abl_a')[:len(FREE7)] == FREE7, out)
open(os.path.join(d.dir, 'abl_a'), 'r+b').write(STOCK7)   # the update brought its own stock ABL
rc, out = d.run('backup', '-d', 'pockets', *L(d))
check('backup on the new build: a second folder', rc == 0 and len(bjson(d)) == 2, out)
open(os.path.join(d.dir, 'abl_a'), 'r+b').write(FREE7)
rc, out = d.run('restore', '-d', 'pockets', *L(d), stdin='RESTORE-ABL_A\n')
check('restore over EDL: the backup of this build chosen', rc == 0 and 'same Android build (Android 13, security patch 2025-02-05)' in out
      and d.part('abl_a')[:len(STOCK7)] == STOCK7, out)
# over fastboot: FreeABL that reports the build is checked, one that does not is warned about
rc, out = d.run('restore', '-d', 'pockets', '--via', 'fastboot', stdin='RESTORE-ABL_A\n')
check('restore over fastboot without the build: warned', rc == 0 and 'cannot tell the Android build' in out, out)
new = [i for i in bjson(d).values() if i['android']['patch'] == '2025-02-05'][0]['android']
v = json.load(open(os.path.join(d.dir, 'vars.json')))
v.update({'android-os-version': '13', 'android-security-patch': '2025-02-05', 'vbmeta-sha256': new['vbmeta_sha256'][:59].upper()})
json.dump(v, open(os.path.join(d.dir, 'vars.json'), 'w'))
rc, out = d.run('restore', '-d', 'pockets', '--via', 'fastboot', stdin='RESTORE-ABL_A\n')
check('restore over fastboot with the build: checked', rc == 0 and 'same Android build' in out and 'Note' not in out, out)
v['vbmeta-sha256'] = 'f' * 64
json.dump(v, open(os.path.join(d.dir, 'vars.json'), 'w'))
rc, out = d.run('restore', '-d', 'pockets', '--via', 'fastboot', stdin='RESTORE-ABL_A\n')
check('restore over fastboot, other build: refused', rc != 0 and 'other builds' in out, out)
shutil.rmtree(d.dir)

# boot side from init_boot properties (GKI), or from the boot header when vbmeta has none
d = Dev(STOCK7, STOCK7, android=(dict(gki=True, patch='2023-06-05'), {}))
d.run('check'); d.run('backup', '-d', 'pockets', *L(d))
check('build: init_boot properties', list(bjson(d).values())[0]['android']['patch'] == '2023-06-05')
shutil.rmtree(d.dir)
d = Dev(STOCK7, STOCK7)
open(os.path.join(d.dir, 'vbmeta_a'), 'wb').write(vbmeta_image({}))
d.run('check'); rc, out = d.run('backup', '-d', 'pockets', *L(d))
a = list(bjson(d).values())[0]['android']
check('build: boot header when vbmeta has no version', a['os_version'] == '13' and a['patch'] == '2023-06', str(a))
check('build: header read with edl rs on the right sector', 'edl rs ' in open(os.path.join(d.dir, 'calls.log')).read())
shutil.rmtree(d.dir)
d = Dev(STOCK7, STOCK7, android=(None, None))
d.run('check'); rc, out = d.run('backup', '-d', 'pockets', *L(d))
check('build: none on an older Android, backup still made', rc == 0 and 'android-unknown' in bjson(d) and 'Android version not known' in out, out)
shutil.rmtree(d.dir)

# 15. FreeABL already on a slot; writes that stop half way
d = Dev(FREE7, STOCK7, freeabl='yes')
d.run('check')
rc, out = d.run('backup', '-d', 'pockets', *L(d))
check('backup refused while FreeABL runs on the active slot', rc != 0 and 'active slot, holds FreeABL' in out, out)
shutil.rmtree(d.dir)
d = Dev(STOCK7, STOCK7)
d.run('check'); d.run('backup', '-d', 'pockets', *L(d))
img = d.image(FREE7)
rc, out = d.run('flash', '-d', 'pockets', *L(d), '-i', img, stdin='FLASH-ABL_A\n')
check('flash remembers the image', rc == 0 and os.path.isfile(os.path.join(d.backups, 'freeabl-images.json')), out)
os.remove(img); os.remove(img + '.sha256')
d.vars['current-slot'] = 'b'
d.update('b', dict(patch='2025-02-05'))      # an Android update to slot b, FreeABL left on abl_a
d.run('check')
rc, out = d.run('backup', '-d', 'pockets', *L(d))
new = [i for i in bjson(d).values() if i['slot'] == 'b']
check('after an update: FreeABL on the other slot recognised and marked', rc == 0 and 'abl_a holds FreeABL' in out
      and new and new[0]['partitions']['abl_a'].get('freeabl') and not new[0]['partitions']['abl_b'].get('freeabl'), out)
shutil.rmtree(d.dir)
d = Dev(STOCK7, STOCK7, fail_writes=1)
d.run('check'); d.run('backup', '-d', 'pockets', *L(d))
img = d.image(FREE7)
rc, out = d.run('flash', '-d', 'pockets', *L(d), '-i', img, stdin='FLASH-ABL_A\n')
check('write stopped half way: stock put back', rc != 0 and 'the write stopped; stock abl_a restored and verified' in out
      and d.part('abl_a')[:len(STOCK7)] == STOCK7, out)
v = json.load(open(os.path.join(d.dir, 'vars.json'))); v['fail_writes'] = 2; json.dump(v, open(os.path.join(d.dir, 'vars.json'), 'w'))
rc, out = d.run('flash', '-d', 'pockets', *L(d), '-i', img, stdin='FLASH-ABL_A\n')
check('write and stock write stopped: told not to reboot', rc != 0 and 'could not be put back. Do NOT reboot' in out, out)
v['fail_writes'] = 0; json.dump(v, open(os.path.join(d.dir, 'vars.json'), 'w'))
rc, out = d.run('restore', '-d', 'pockets', *L(d), stdin='RESTORE-ABL_A\n')
check('then restore over EDL works', rc == 0 and d.part('abl_a')[:len(STOCK7)] == STOCK7, out)
shutil.rmtree(d.dir)

# 16. two devices: the chip serial ties the backup to its device
d = Dev(STOCK7, STOCK7, chip='aaaa0001')
d.run('check'); d.run('backup', '-d', 'pockets', *L(d))
check('backup records the chip serial', list(bjson(d).values())[0].get('chip_serial') == 'aaaa0001')
d.vars['chip'] = 'bbbb0002'; d.update('a', {})          # another device of the same model, fresh in EDL
os.remove(os.path.join(d.dir, '.loaded')) if os.path.exists(os.path.join(d.dir, '.loaded')) else None
rc, out = d.run('restore', '-d', 'pockets', *L(d), stdin='RESTORE-ABL_A\n')
calls = open(os.path.join(d.dir, 'calls.log')).read()
check('restore on another device refused, nothing written', rc != 0 and 'chip bbbb0002' in out and 'not the same device' in out
      and not any(l.startswith('edl w') for l in calls.splitlines()), out)
d.vars['chip-serial'] = 'bbbb0002'; d.update('a', {})   # FreeABL's fastboot reports it
d.run('check')
rc, out = d.run('restore', '-d', 'pockets', '--via', 'fastboot', stdin='RESTORE-ABL_A\n')
check('restore over fastboot on another device refused', rc != 0 and 'not the same device' in out, out)
shutil.rmtree(d.dir)

# 17. a serial changed by the bootloader: the backup is found by the chip serial
d = Dev(STOCK7, STOCK7, chip='aaaa0001', serialno='00314WHD01003717')
d.run('check'); d.run('backup', '-d', 'pockets', *L(d))
d.vars.update({'serialno': '446f5b70', 'chip-serial': 'aaaa0001', 'freeabl': 'yes'}); d.update('a', {})   # FreeABL now runs
rc, out = d.run('check')
rc, out = d.run('restore', '-d', 'pockets', '--via', 'fastboot', stdin='RESTORE-ABL_A\n')
check('restore finds the backup filed under the old serial by its chip', rc == 0 and 'RESTORED abl_a' in out, out)
shutil.rmtree(d.dir)

# 18. Sahara 3 output of the edl tool: chip ID and chip serial read (64-bit serial cut to the chip's)
d = Dev(STOCK7, STOCK7, sahara=3, chip='77bf0381')
d.run('check')
rc, out = d.run('backup', '-d', 'pockets', *L(d))
info = list(bjson(d).values())[0]
check('Sahara 3: MSM ID seen and checked, chip serial 77bf0381', rc == 0 and 'MSM ID not seen' not in out
      and info['msm_id'] == '0x1f20e1' and info['chip_serial'] == '77bf0381', out + str(info))
shutil.rmtree(d.dir)

# 14. firmware dump: read only, big partitions left out
d = Dev(STOCK7, STOCK7)
d.run('check')
rc, out = d.run('dump', '-d', 'pockets', *L(d))
fw = [os.path.join(d.backups, 'TEST1234', x, 'firmware') for x in os.listdir(os.path.join(d.backups, 'TEST1234')) if x.startswith('android')][0]
fj = json.load(open(os.path.join(fw, 'firmware.json'))) if os.path.isfile(os.path.join(fw, 'firmware.json')) else {}
check('dump: every small partition of both slots', rc == 0 and sorted(fj.get('firmware', {})) ==
      sorted(['abl_a', 'abl_b', 'xbl_a', 'xbl_b', 'vbmeta_a', 'vbmeta_b', 'vbmeta_system_a', 'vbmeta_system_b', 'boot_a', 'boot_b']), out)
check('dump: userdata left out', 'Left out: userdata (65536 MiB)' in out, out)
check('dump: contents and sums', open(os.path.join(fw, 'xbl_b.img'), 'rb').read() == d.part('xbl_b')
      and fj['firmware']['xbl_b']['sha256'] == hashlib.sha256(d.part('xbl_b')).hexdigest())
calls = open(os.path.join(d.dir, 'calls.log')).read()
check('dump: nothing written', not any(l.startswith(('edl w', 'fastboot flash')) for l in calls.splitlines()), calls)
shutil.rmtree(d.dir)

# 12. devices.json (used by web/) matches the table embedded in the tool
import importlib.util
spec = importlib.util.spec_from_file_location('ff', TOOL)
ff = importlib.util.module_from_spec(spec); spec.loader.exec_module(ff)
dj = json.load(open(os.path.join(HERE, '..', '..', 'devices.json')))
emb = {k: {kk: (('0x%x' % vv) if kk == 'msm_id' and vv is not None else vv) for kk, vv in d.items()}
       for k, d in ff.DEVICES.items()}
check('devices.json matches the tool', {k: {kk: v[kk] for kk in emb.get(k, {})} for k, v in dj['devices'].items()} == emb and dj['soc_mbn'] == ff.SOC_MBN
      and dj['min_battery_mv'] == ff.MIN_MV)

# Android builds FreeABL was validated on
dv = dict(ff.DEVICES['pockets'], android=[dict(os_version='13', patch='2023-06-05')])
fp = ff.DEVICES['pockets']['android'][0]['fingerprint']
check('validated builds: same month passes, another needs --untested, the exact build is told apart',
      ff.android_validated(dv, dict(os_version='13', patch='2023-06-01')) == (True, True, False)
      and ff.android_validated(ff.DEVICES['pockets'], dict(os_version='13', patch='2023-06-05', fingerprint=fp)) == (True, True, True)
      and ff.android_validated(dv, dict(os_version='14', patch='2025-01-05')) == (True, False, False)
      and ff.android_validated(dv, None) == (True, False, False)
      and ff.android_validated(dict(ff.DEVICES['odin'], android=[]), None) == (False, False, False))
# same parser as the web page, on the same bytes
pv = build(patch='2023-06-05')[0]
check('vbmeta properties: Python and web agree', ff.avb_props(pv) == json.loads(subprocess.run(
    ['node', '-e', 'import("./web/core.js").then(c=>{let b=[];process.stdin.on("data",d=>b.push(d)).on("end",()=>console.log(JSON.stringify(c.avbProps(new Uint8Array(Buffer.concat(b))))))})'],
    input=pv, capture_output=True, cwd=os.path.join(HERE, '..', '..')).stdout or b'null'))

# the EDL loader: fetched from loader_url when not given, its sha256 checked
import types
lt = tempfile.mkdtemp(prefix='loader-')
open(os.path.join(lt, 'good.elf'), 'wb').write(b'loader bytes')
good = hashlib.sha256(b'loader bytes').hexdigest()
dv = dict(ff.DEVICES['pockets'], loader_url='file://' + os.path.join(lt, 'good.elf'), loader_sha256=good)
a = types.SimpleNamespace(loader=None, backup_dir=os.path.join(lt, 'b'))
ff.resolve_loader(a, dv)
check('loader fetched and checked when not given', a.loader and open(a.loader, 'rb').read() == b'loader bytes')
a = types.SimpleNamespace(loader=None, backup_dir=os.path.join(lt, 'c'))
try:
    ff.resolve_loader(a, dict(dv, loader_sha256='0' * 64)); refused = False
except SystemExit as e:
    refused = 'expected sha256' in str(e)
check('fetched loader with another sha256 refused', refused)
for k, v in ff.DEVICES.items():
    if v.get('loader_url'):
        check(f'{k}: loader URL pinned to a commit', '/FreeABL-loaders/' in v['loader_url'] and len(v['loader_sha256']) == 64)
shutil.rmtree(lt)

print(f"\n{'all passed' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
