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


class Dev:
    def __init__(self, stock_a, stock_b, **v):
        self.dir = tempfile.mkdtemp(prefix='fakedev-')
        self.bin = os.path.join(self.dir, 'bin')
        os.mkdir(self.bin)
        for t in ('fastboot', 'edl'):
            os.symlink(os.path.join(HERE, 'fakedev.py'), os.path.join(self.bin, t))
        self.vars = dict(serialno='TEST1234', unlocked='yes', product='kalama',
                         variant='SGP UFS', **{'current-slot': 'a', 'battery-voltage': '4100'},
                         msm=0x2520e1)
        self.vars.update(v)
        json.dump(self.vars, open(os.path.join(self.dir, 'vars.json'), 'w'))
        for p, data in (('abl_a', stock_a), ('abl_b', stock_b)):
            open(os.path.join(self.dir, p), 'wb').write(data.ljust(SIZE, b'\0'))
        self.backups = os.path.join(self.dir, 'backups')
        self.loader = os.path.join(self.dir, 'loader.melf')
        open(self.loader, 'wb').write(b'loader')

    def run(self, *args, stdin=''):
        env = dict(os.environ, FAKEDEV=self.dir, PATH=self.bin + os.pathsep + os.environ['PATH'])
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
bk = os.path.join(d.backups, 'TEST1234')
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
check('flash: readback mismatch detected, not reported as success', rc != 0 and 'MISMATCH' in out, out)
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
d = Dev(signed_elf(6, 'stock'), EMPTY, msm=0x99e1)
d.run('check'); d.run('backup', '-d', 'pocketmax', *L(d))
img = d.image(signed_elf(6, 'free'), 'abl_signed-SM8250-ESP-r34.elf')
rc, out = d.run('flash', '-d', 'pocketmax', *L(d), '-i', img, stdin='FLASH-ABL_A\n')
check('earlier-build device needs --untested', rc != 0 and '--untested' in out, out)
rc, out = d.run('flash', '-d', 'pocketmax', '--untested', *L(d), '-i', img, stdin='FLASH-UNTESTED-ABL_A\n')
check('earlier-build device ok with --untested', rc == 0, out)
shutil.rmtree(d.dir)

# 12. devices.json (used by web/) matches the table embedded in the tool
import importlib.util
spec = importlib.util.spec_from_file_location('ff', TOOL)
ff = importlib.util.module_from_spec(spec); spec.loader.exec_module(ff)
dj = json.load(open(os.path.join(HERE, '..', '..', 'devices.json')))
emb = {k: {kk: (('0x%x' % vv) if kk == 'msm_id' and vv is not None else vv) for kk, vv in d.items()}
       for k, d in ff.DEVICES.items()}
check('devices.json matches the tool', dj['devices'] == emb and dj['soc_mbn'] == ff.SOC_MBN
      and dj['min_battery_mv'] == ff.MIN_MV)

print(f"\n{'all passed' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
