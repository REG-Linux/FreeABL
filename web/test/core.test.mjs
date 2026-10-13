// SPDX-License-Identifier: GPL-3.0-or-later
// node --test web/test/  : the web flasher's steps against a simulated device,
// the same cases as test/flash/test-flash.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../core.js';
import { SimDevice, signedElf } from '../sim.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const table = JSON.parse(readFileSync(ROOT + 'devices.json', 'utf8'));
const STOCK7 = signedElf(7, 'stock'), STOCK5 = signedElf(5, 'stock845'), STOCK6 = signedElf(6, 'stock6');
const FREE7 = signedElf(7, 'freeabl'), FREE5 = signedElf(5, 'freeabl845');
const EMPTY = new Uint8Array(0);
const quiet = () => {};
const typing = (s) => async () => s;
const prefix = (sim, p, img) => core.startsWith(sim.parts[p], img);

async function setup(opts, sel) {
  const sim = new SimDevice(opts);
  const dev = core.resolveDevice(table, sel);
  const state = await core.check(sim.fastboot, table, quiet);
  const msm = await core.edlConnect(sim.edl, dev, new Uint8Array(1), sel.untested, quiet);
  const b = await core.backup(sim.edl, dev, state, msm, quiet);
  const bk = await core.loadBackup(b.tar, dev, state);
  return { sim, dev, state, b, bk };
}

const flashArgs = (x, image, extra = {}) => ({
  via: 'edl', edl: x.sim.edl, fb: x.sim.fastboot, dev: x.dev, state: x.state, bk: x.bk,
  image, imageSha: 'f'.repeat(64), untested: false, confirm: typing(`FLASH-ABL_${x.state.slot.toUpperCase()}`), log: quiet, ...extra,
});

test('mbnVersion agrees with the Python tool on real images', () => {
  const py = `import importlib.util,sys
s=importlib.util.spec_from_file_location('f','${ROOT}tools/freeabl-flash.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(m.mbn_version(sys.argv[1]))`;
  for (const [img, v] of [[STOCK7, 7], [STOCK5, 5], [new Uint8Array(4096), 'empty']]) {
    assert.equal(core.mbnVersion(img), v);
    const f = `/tmp/freeabl-mbn-${process.pid}`;
    execFileSync('sh', ['-c', 'cat > "$0"', f], { input: img });
    assert.equal(execFileSync('python3', ['-c', py, f]).toString().trim(), String(v));
  }
});

test('tar round trip', () => {
  const files = [{ name: 'S/a.img', data: new Uint8Array([1, 2, 3]) }, { name: 'S/b', data: new Uint8Array(1000).fill(7) }];
  const out = core.readTar(core.makeTar(files));
  assert.deepEqual(Object.keys(out), ['S/a.img', 'S/b']);
  assert.deepEqual(out['S/b'], files[1].data);
});

test('tar is readable by tar(1)', () => {
  const t = core.makeTar([{ name: 'X1/backup.json', data: new TextEncoder().encode('{}\n') }]);
  assert.match(execFileSync('tar', ['-tvf', '-'], { input: t }).toString(), /X1\/backup\.json/);
});

test('happy path: backup, flash over EDL, restore', async () => {
  const x = await setup({ stockA: STOCK7, stockB: EMPTY }, { device: 'pockets' });
  assert.equal(x.bk.info.partitions.abl_b.mbn, 'empty');
  await assert.rejects(core.flash(flashArgs(x, FREE7, { confirm: typing('nope') })), /aborted/);
  assert.ok(prefix(x.sim, 'abl_a', STOCK7));
  await core.flash(flashArgs(x, FREE7));
  assert.ok(prefix(x.sim, 'abl_a', FREE7));
  assert.ok(x.sim.parts.abl_b.every((b) => b === 0));
  assert.deepEqual([...new Set(x.sim.writes)], ['abl_a']);
  await core.restore({ via: 'edl', edl: x.sim.edl, fb: x.sim.fastboot, state: x.state, bk: x.bk, confirm: typing('RESTORE-ABL_A'), log: quiet });
  assert.ok(prefix(x.sim, 'abl_a', STOCK7));
});

test('secure boot on, or not reported: refused', async () => {
  await assert.rejects(core.check(new SimDevice({ stockA: STOCK7, stockB: STOCK7, vars: { secure: 'yes' } }).fastboot, table, quiet), /secure boot is on/);
  const sim = new SimDevice({ stockA: STOCK7, stockB: STOCK7 });
  delete sim.vars.secure;
  await assert.rejects(core.check(sim.fastboot, table, quiet), /does not say whether secure boot/);
});

test('locked and low battery refused', async () => {
  await assert.rejects(core.check(new SimDevice({ stockA: STOCK7, stockB: STOCK7, vars: { unlocked: 'no' } }).fastboot, table, quiet), /locked/);
  await assert.rejects(core.check(new SimDevice({ stockA: STOCK7, stockB: STOCK7, vars: { 'battery-voltage': '3500' } }).fastboot, table, quiet), /battery/);
});

test('wrong device: MSM ID, stock signature, backup of another device', async () => {
  await assert.rejects(setup({ stockA: STOCK7, stockB: STOCK7, msmId: 0x08b0e1 }, { device: 'pockets' }), /MSM ID/);
  await assert.rejects(setup({ stockA: STOCK6, stockB: EMPTY, msmId: 0x99 }, { device: 'other', soc: 'sm8550', untested: true }), /signature format/);
  const x = await setup({ stockA: STOCK5, stockB: STOCK5, msmId: 0x08b0e1 }, { device: 'odin' });
  await assert.rejects(core.checkImage(x.dev, core.imageName('sm8550'), FREE7, null, quiet), /signature format/);
  await assert.rejects(core.checkImage(x.dev, core.imageName('sm8550'), FREE5, null, quiet), /not the sdm845 image/);
  await assert.rejects(core.loadBackup(x.b.tar, core.resolveDevice(table, { device: 'pockets' }), x.state), /backup was made/);
  await assert.rejects(core.loadBackup(x.b.tar, x.dev, { ...x.state, serial: 'OTHER' }), /connected device/);
  await assert.rejects(core.loadBackup(x.b.tar, x.dev, { ...x.state, slot: 'b' }), /slot changed/);
});

test('checksum file checked', async () => {
  const dev = core.resolveDevice(table, { device: 'pockets' });
  const name = core.imageName('sm8550');
  const h = await core.sha256hex(FREE7);
  assert.equal(await core.checkImage(dev, name, FREE7, `${h}  ${name}\n`, quiet), h);
  await assert.rejects(core.checkImage(dev, name, FREE7, `${'0'.repeat(64)}  ${name}\n`, quiet), /does not match/);
  await assert.rejects(core.checkImage(dev, name, FREE7, `${h}  other.elf\n`, quiet), /does not list/);
});

test('damaged backup refused', async () => {
  const x = await setup({ stockA: STOCK7, stockB: STOCK7 }, { device: 'pockets' });
  const t = x.b.tar.slice();
  t[1024 + 300] ^= 1;   // inside abl_a's data
  await assert.rejects(core.loadBackup(t, x.dev, x.state), /damaged/);
});

test('corrupted write detected', async () => {
  const x = await setup({ stockA: STOCK7, stockB: STOCK7 }, { device: 'pockets' });
  x.sim.corrupt = true;
  await assert.rejects(core.flash(flashArgs(x, FREE7)), /NOT verified/);
});

test('slot b active: abl_b only', async () => {
  const x = await setup({ stockA: STOCK7, stockB: STOCK7, vars: { 'current-slot': 'b' } }, { device: 'pockets' });
  await core.flash(flashArgs(x, FREE7));
  assert.ok(prefix(x.sim, 'abl_b', FREE7) && prefix(x.sim, 'abl_a', STOCK7));
});

test('fastboot: critical refusal explained, serial checked', async () => {
  const x = await setup({ stockA: STOCK7, stockB: STOCK7, critical: true }, { device: 'pockets' });
  await assert.rejects(core.flash(flashArgs(x, FREE7, { via: 'fastboot' })), /use EDL/);
  x.sim.critical = false;
  await core.flash(flashArgs(x, FREE7, { via: 'fastboot' }));
  assert.ok(prefix(x.sim, 'abl_a', FREE7));
  x.sim.vars.serialno = 'OTHER';
  await assert.rejects(core.flash(flashArgs(x, FREE7, { via: 'fastboot' })), /not the one/);
});

test('tester mode', async () => {
  assert.throws(() => core.resolveDevice(table, { device: 'other', soc: 'sm8650' }), /tester/i);
  assert.throws(() => core.resolveDevice(table, { device: 'other', untested: true }), /SoC/);
  assert.throws(() => core.resolveDevice(table, { device: 'pockets', soc: 'sm8650' }), /Other device/);
  assert.equal(core.resolveDevice(table, { device: 'other', soc: 'sm8650', forWrite: false }).soc, 'sm8650');
  const x = await setup({ stockA: STOCK7, stockB: EMPTY, msmId: 0x99e1 }, { device: 'other', soc: 'sm8650', untested: true });
  assert.match(x.b.report, /0x99e1/);
  await assert.rejects(core.flash(flashArgs(x, FREE7)), /Tester mode/);
  await assert.rejects(core.flash(flashArgs(x, FREE7, { untested: true })), /aborted/);
  await core.flash(flashArgs(x, FREE7, { untested: true, confirm: typing('FLASH-UNTESTED-ABL_A') }));
  assert.ok(prefix(x.sim, 'abl_a', FREE7));
  const y = await setup({ stockA: STOCK7, stockB: STOCK7, msmId: 0x99e1 }, { device: 'pockets', untested: true });
  assert.equal(y.bk.info.msm_id, '0x99e1');
  const z = await setup({ stockA: STOCK6, stockB: EMPTY, msmId: 0x99 }, { device: 'pocketmax' });
  await assert.rejects(core.flash(flashArgs(z, signedElf(6, 'f'))), /Tester mode/);
});

test('empty active ABL refused at backup', async () => {
  const x = await setup({ stockA: STOCK7, stockB: EMPTY, vars: { 'current-slot': 'b' } }, { device: 'pockets' }).catch((e) => e);
  assert.match(String(x.message), /signature format empty/);
});
