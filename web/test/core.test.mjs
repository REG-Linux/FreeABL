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
  await assert.rejects(core.flash(flashArgs(x, FREE7)), /could not be put back. Do NOT reboot/);
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

// --- Android builds ----------------------------------------------------------
test('backup records the Android build; boot side and system side told apart', async () => {
  const x = await setup({ stockA: STOCK7, stockB: STOCK7 }, { device: 'pockets' });
  assert.equal(x.bk.info.android.os_version, '13');
  assert.equal(x.bk.info.android.patch, '2023-06-05');
  assert.match(x.bk.info.android.vbmeta_sha256, /^[0-9a-f]{64}$/);
  assert.equal(x.b.tarName, 'freeabl-backup-SIM12345-android13-2023-06-05.tar');
  const gki = await setup({ stockA: STOCK7, stockB: STOCK7, android: { a: { gki: true, patch: '2023-06-05' }, b: {} } }, { device: 'pockets' });
  assert.equal(gki.bk.info.android.patch, '2023-06-05');
  const split = await setup({ stockA: STOCK6, stockB: STOCK6, msmId: 0x99,
                              android: { a: { os: '11', patch: '2024-03-05', system: { os: '13', patch: '2025-03-05' } }, b: {} } },
                            { device: 'pocketmax' });
  assert.equal(core.androidLabel(split.bk.info.android), 'Android 13, security patch 2025-03-05 (boot side: Android 11, 2024-03-05)');
  const old = await setup({ stockA: STOCK7, stockB: STOCK7, android: { a: null, b: null } }, { device: 'pockets' });
  assert.equal(old.bk.info.android, null);
});

test('restore over EDL refuses a backup from another Android build', async () => {
  const x = await setup({ stockA: STOCK7, stockB: STOCK7 }, { device: 'pockets' });
  await core.flash(flashArgs(x, FREE7));
  // an update that came back to slot a (two updates) brought a new build
  x.sim.androidUpdate('a', { patch: '2025-02-05' });
  const r = { via: 'edl', edl: x.sim.edl, state: x.state, bk: x.bk, confirm: typing('RESTORE-ABL_A'), log: quiet };
  await assert.rejects(core.restore(r), /made on Android 13, security patch 2023-06-05; the device now runs Android 13, security patch 2025-02-05/);
  assert.ok(prefix(x.sim, 'abl_a', FREE7));
  // the backup made on this build restores
  x.sim.parts.abl_a.set(STOCK7);
  const y = await core.backup(x.sim.edl, x.dev, x.state, null, quiet);
  x.sim.parts.abl_a.set(FREE7);
  await core.restore({ ...r, bk: await core.loadBackup(y.tar, x.dev, x.state) });
  assert.ok(prefix(x.sim, 'abl_a', STOCK7));
});

test('restore over fastboot: checked with FreeABL that reports the build, warned without', async () => {
  const x = await setup({ stockA: STOCK7, stockB: STOCK7 }, { device: 'pockets' });
  let said = '';
  const r = { via: 'fastboot', fb: x.sim.fastboot, state: x.state, bk: x.bk, log: quiet,
              confirm: async (p, msg) => { said = msg; return p; } };
  await core.restore(r);
  assert.match(said, /cannot tell the Android build/);
  const a = x.bk.info.android;
  Object.assign(x.sim.vars, { 'android-os-version': a.os_version, 'android-security-patch': a.patch, 'vbmeta-sha256': a.vbmeta_sha256 });
  await core.restore(r);
  assert.doesNotMatch(said, /Note/);
  // what FreeABL 0.2 sent on the Portal: 59 digits, upper case; later builds send 32
  for (const v of [a.vbmeta_sha256.slice(0, 59).toUpperCase(), a.vbmeta_sha256.slice(0, 32)]) {
    x.sim.vars['vbmeta-sha256'] = v;
    await core.restore(r);
    assert.doesNotMatch(said, /Note/);
  }
  x.sim.vars['vbmeta-sha256'] = 'f'.repeat(32);
  await assert.rejects(core.restore(r), /made on Android/);
  x.sim.vars['vbmeta-sha256'] = a.vbmeta_sha256.slice(0, 16);   // too short to tell: not trusted
  await assert.rejects(core.restore(r), /made on Android/);
  const old = await core.loadBackup(core.makeTar(Object.entries(core.readTar(x.b.tar)).map(([name, data]) =>
    ({ name, data: name.endsWith('backup.json') ? new TextEncoder().encode(JSON.stringify({ ...x.bk.info, android: undefined })) : data }))), x.dev, x.state);
  await core.restore({ ...r, bk: old });
  assert.match(said, /does not record its Android build/);
});

test('Android versions FreeABL was validated on', async () => {
  const t = structuredClone(table);
  t.devices.pockets.android = [{ os_version: '13', patch: '2023-06-05' }];
  const on = async (build) => {
    const sim = new SimDevice({ stockA: STOCK7, stockB: STOCK7, android: { a: build, b: {} } });
    const dev = core.resolveDevice(t, { device: 'pockets' });
    const state = await core.check(sim.fastboot, t, quiet);
    const b = await core.backup(sim.edl, dev, state, await core.edlConnect(sim.edl, dev, new Uint8Array(1), false, quiet), quiet);
    return { sim, dev, state, b, bk: await core.loadBackup(b.tar, dev, state) };
  };
  const x = await on({ patch: '2023-06-01' });   // same month, another build
  const said = [];
  await core.flash(flashArgs(x, FREE7, { log: (m) => said.push(m) }));
  assert.ok(said.some((m) => /this exact build .* was not run on yet/.test(m)), said.join('\n'));
  const y = await on({ os: '14', patch: '2025-01-05' });
  await assert.rejects(core.flash(flashArgs(y, FREE7)), /not run on Android 14, security patch 2025-01-05.*Tester mode/);
  let msg = '';
  await core.flash(flashArgs(y, FREE7, { untested: true, confirm: async (p, m) => { msg = m; return 'FLASH-UNTESTED-ABL_A'; } }));
  assert.match(msg, /validated: Android 13 2023-06/);
  assert.ok(prefix(y.sim, 'abl_a', FREE7));
  // update over fastboot: FreeABL tells the build; a listed one passes, another needs tester mode
  y.sim.vars['android-os-version'] = '13'; y.sim.vars['android-security-patch'] = '2023-06-05';
  await core.flash(flashArgs(y, FREE7, { via: 'fastboot' }));
  y.sim.vars['android-security-patch'] = '2025-01-05';
  await assert.rejects(core.flash(flashArgs(y, FREE7, { via: 'fastboot' })), /Tester mode/);
});

// --- firmware dump -------------------------------------------------------------
async function dumpOf(x) {
  const plan = await core.dumpPlan(x.sim.edl, x.state);
  const chunks = [];
  const info = await core.dump(x.sim.edl, x.dev, x.state, null, plan, { write: async (c) => chunks.push(c.slice()) }, quiet);
  return { plan, info, blob: new Blob(chunks) };
}

test('firmware dump: both slots, read only, big partitions left out, usable as a backup', async () => {
  const x = await setup({ stockA: STOCK7, stockB: STOCK7 }, { device: 'pockets' });
  const writes = x.sim.writes.length;
  const { plan, info, blob } = await dumpOf(x);
  assert.equal(plan.name, 'freeabl-firmware-SIM12345-android13-2023-06-05.tar');
  assert.deepEqual(plan.skipped, ['userdata (65536 MiB)']);
  for (const p of ['abl_a', 'abl_b', 'xbl_a', 'xbl_b', 'vbmeta_a', 'vbmeta_system_b', 'boot_a']) assert.ok(info.firmware[p], p);
  assert.equal(x.sim.writes.length, writes);
  const listing = execFileSync('tar', ['-tf', '-'], { input: new Uint8Array(await blob.arrayBuffer()) }).toString();
  assert.match(listing, /SIM12345\/firmware\/xbl_a\.img/);
  assert.match(listing, /SIM12345\/backup\.json/);
  // restore from it, as from a backup
  await core.flash(flashArgs(x, FREE7));
  const bk = await core.loadBackup(blob, x.dev, x.state);
  assert.equal(bk.info.android.vbmeta_sha256, x.bk.info.android.vbmeta_sha256);
  await core.restore({ via: 'edl', edl: x.sim.edl, state: x.state, bk, confirm: typing('RESTORE-ABL_A'), log: quiet });
  assert.ok(prefix(x.sim, 'abl_a', STOCK7));
  const sums = new TextDecoder().decode(await (await core.tarIndex(blob))['SIM12345/SHA256SUMS']());
  assert.match(sums, new RegExp(`${await core.sha256hex(x.sim.parts.xbl_b)}  firmware/xbl_b.img`));
});

// --- FreeABL already on a slot, writes that fail half way ---------------------------
test('backup refused while FreeABL runs on the active slot; FreeABL on the other slot marked', async () => {
  await assert.rejects(setup({ stockA: FREE7, stockB: STOCK7, vars: { freeabl: 'yes' } }, { device: 'pockets' }),
                       /abl_a, the active slot, holds FreeABL/);
  // an older FreeABL that does not say so: recognised from the image chosen for the install
  const sim = new SimDevice({ stockA: FREE7, stockB: STOCK7 });
  const dev = core.resolveDevice(table, { device: 'pockets' });
  const state = await core.check(sim.fastboot, table, quiet);
  await assert.rejects(core.backup(sim.edl, dev, state, null, quiet, { freeablImages: [FREE7] }), /holds FreeABL/);
  // after an Android update: slot b runs the new stock bootloader, abl_a still holds FreeABL
  sim.vars['current-slot'] = 'b';
  const st = await core.check(sim.fastboot, table, quiet);
  const b = await core.backup(sim.edl, dev, st, null, quiet, { freeablImages: [FREE7] });
  assert.equal(b.info.partitions.abl_a.freeabl, true);
  assert.equal(b.info.partitions.abl_b.freeabl, undefined);
  const bk = await core.loadBackup(b.tar, dev, st);
  await assert.rejects(core.restore({ via: 'edl', edl: sim.edl, state: { ...st, slot: 'a' }, bk, confirm: typing('RESTORE-ABL_A'), log: quiet }),
                       /backup's abl_a is FreeABL, not stock/);
});

test('USB failure in the middle of a write: stock put back, or told not to reboot', async () => {
  const x = await setup({ stockA: STOCK7, stockB: STOCK7 }, { device: 'pockets' });
  x.sim.failWrites = 1;
  await assert.rejects(core.flash(flashArgs(x, FREE7)), /the write stopped: NetworkError.*stock abl_a restored and verified/);
  assert.ok(prefix(x.sim, 'abl_a', STOCK7));
  x.sim.failWrites = 2;
  await assert.rejects(core.flash(flashArgs(x, FREE7)), /could not be put back. Do NOT reboot/);
  x.sim.failWrites = 1;
  await assert.rejects(core.restore({ via: 'edl', edl: x.sim.edl, state: x.state, bk: x.bk, confirm: typing('RESTORE-ABL_A'), log: quiet }),
                       /write of abl_a stopped.*Do NOT reboot/);
  await core.restore({ via: 'edl', edl: x.sim.edl, state: x.state, bk: x.bk, confirm: typing('RESTORE-ABL_A'), log: quiet });
  assert.ok(prefix(x.sim, 'abl_a', STOCK7));
});

// --- two devices connected: the chip serial ties a backup to its device -------------
test('wrong device: backup of one, restore or flash on another, swap between fastboot and EDL', async () => {
  const x = await setup({ stockA: STOCK7, stockB: STOCK7, chipSerial: 'aaaa0001' }, { device: 'pockets' });
  assert.equal(x.bk.info.chip_serial, 'aaaa0001');
  // the other device (same model, same Android serial in this simulation) in EDL
  const other = new SimDevice({ stockA: FREE7, stockB: STOCK7, chipSerial: 'bbbb0002' });
  const edl = other.edl;
  await core.edlConnect(edl, x.dev, new Uint8Array(1), false, quiet);
  await assert.rejects(core.restore({ via: 'edl', edl, state: x.state, bk: x.bk, confirm: typing('RESTORE-ABL_A'), log: quiet }),
                       /device in EDL is chip bbbb0002, the backup chip aaaa0001: not the same device/);
  await assert.rejects(core.flash(flashArgs({ ...x, sim: other }, FREE7, { edl })), /not the same device/);
  assert.deepEqual(other.writes, []);
  // FreeABL's fastboot reports the chip: Update and Back to stock over fastboot check it
  other.vars['chip-serial'] = 'bbbb0002';
  const st = await core.check(other.fastboot, table, quiet);
  await assert.rejects(core.restore({ via: 'fastboot', fb: other.fastboot, state: st, bk: x.bk, confirm: typing('RESTORE-ABL_A'), log: quiet }),
                       /fastboot is chip bbbb0002, the backup chip aaaa0001/);
  // checked in fastboot (FreeABL), then the other one put in EDL
  x.sim.vars['chip-serial'] = 'aaaa0001';
  const st2 = await core.check(x.sim.fastboot, table, quiet);
  const edl2 = new SimDevice({ stockA: STOCK7, stockB: STOCK7, chipSerial: 'bbbb0002' }).edl;
  await core.edlConnect(edl2, x.dev, new Uint8Array(1), false, quiet);
  await assert.rejects(core.backup(edl2, x.dev, st2, null, quiet), /device in fastboot is chip aaaa0001, the device in EDL chip bbbb0002: not the same device/);
});

// --- device in Android, USB debugging ---------------------------------------------
test('Android over USB debugging: what the device is, early warnings, reboots', async () => {
  const dev = core.resolveDevice(table, { device: 'pockets' });
  const said = [];
  const sim = new SimDevice({ stockA: STOCK7, stockB: STOCK7 });
  const adb = sim.adb;
  const r = await core.androidCheck(adb, dev, (m) => said.push(m));
  assert.equal(r.android.patch, '2023-06-05');
  assert.ok(said.some((m) => /AYANEO Pocket S \(kalama\)/.test(m)));
  assert.ok(said.some((m) => /exact Android build/.test(m)), said.join('\n'));
  await adb.reboot('edl');
  assert.deepEqual(sim.reboots, ['edl']);
  const other = new SimDevice({ stockA: STOCK7, stockB: STOCK7, vars: { unlocked: 'no' } });
  other.androidProps = { 'ro.build.version.security_patch': '2025-01-05' };
  const s2 = [];
  await core.androidCheck(other.adb, dev, (m) => s2.push(m));
  assert.ok(s2.some((m) => /bootloader is locked/.test(m)), s2.join('\n'));
  assert.ok(s2.some((m) => /will need tester mode/.test(m)), s2.join('\n'));
  assert.equal(other.writes.length, 0);
});

test('EDL loader checked against the one validated on the device', async () => {
  const dev = core.resolveDevice(table, { device: 'pockets' });
  assert.match(dev.loaderUrl, /FreeABL-loaders\/[0-9a-f]{40}\/sm8550\//);
  const said = [];
  await core.checkLoader(dev, new Uint8Array([1, 2, 3]), false, (m) => said.push(m));
  assert.match(said[0], /not the one validated/);
  await assert.rejects(core.checkLoader(dev, new Uint8Array([1, 2, 3]), true, quiet), /fetched EDL loader does not have the expected sha256/);
  const real = '/home/romain/AyaneoPocketS/images/xbl_s_devprg_ns.melf';
  if ((await import('node:fs')).existsSync(real)) {
    const s2 = [];
    await core.checkLoader(dev, new Uint8Array(readFileSync(real)), true, (m) => s2.push(m));
    assert.match(s2[0], /recognised/);
  }
});

test('the chip serial seen in Android must be the one in EDL', async () => {
  const dev = core.resolveDevice(table, { device: 'pockets' });
  const sim = new SimDevice({ stockA: STOCK7, stockB: STOCK7, chipSerial: 'aaaa0001' });
  const seen = await core.androidCheck(sim.adb, dev, quiet);
  assert.equal(seen.chipSerial, 'aaaa0001');
  const state = { ...(await core.check(sim.fastboot, table, quiet)), androidChipSerial: seen.chipSerial };
  // the other device is the one put in EDL
  const other = new SimDevice({ stockA: STOCK7, stockB: STOCK7, chipSerial: 'bbbb0002' });
  await core.edlConnect(other.edl, dev, new Uint8Array(1), false, quiet);
  await assert.rejects(core.backup(other.edl, dev, state, null, quiet), /seen in Android is chip aaaa0001, the device in EDL chip bbbb0002: not the same device/);
  await core.edlConnect(sim.edl, dev, new Uint8Array(1), false, quiet);
  const b = await core.backup(sim.edl, dev, state, null, quiet);
  assert.equal(b.info.chip_serial, 'aaaa0001');
});
