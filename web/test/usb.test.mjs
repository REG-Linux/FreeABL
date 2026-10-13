// SPDX-License-Identifier: GPL-3.0-or-later
// node --test web/test/  : the real USB code (vendor/fastboot.min.mjs and
// vendor/edl-qdl.mjs through usb.js) against a fake phone that speaks
// fastboot, Sahara and Firehose byte by byte (fakeusb.mjs).
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from '../core.js';
import { signedElf } from '../sim.js';
import { FakePhone } from './fakeusb.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const table = JSON.parse(readFileSync(ROOT + 'devices.json', 'utf8'));
const STOCK7 = signedElf(7, 'stock'), FREE7 = signedElf(7, 'freeabl');
const STOCK5 = signedElf(5, 'stock845'), FREE5 = signedElf(5, 'freeabl845');
const quiet = () => {};
// a USB deadlock fails its test instead of hanging the run
const test = (name, fn) => nodeTest(name, { timeout: 60000 }, fn);
const typing = (s) => async () => s;

// qdl.js logs every device message at debug level
console.debug = () => {};
// browser API used by fastboot.js's upload
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((r) => { this.result = r; this.onload?.({ target: this }); }, (e) => this.onerror?.(e));
  }
};
const usb = await import('../usb.js');

function attach(phone) {
  Object.defineProperty(globalThis, 'navigator', { value: { usb: phone.usb }, configurable: true, writable: true });
  return phone;
}
const allowed = new Set(['configure', 'read', 'program', 'power', 'nop']);
const startsWith = core.startsWith;

test('Sahara 3 (SM8550): chip ID, read, write abl_a only, reset', async () => {
  const ph = attach(new FakePhone({ stockA: STOCK7, stockB: new Uint8Array(0) }).plug('edl'));
  const edl = usb.edlDriver(quiet);
  const { msmId, chipSerial } = await edl.connect(ph.loader, 'ufs');
  assert.equal(msmId, 0x2520e1);
  assert.equal(chipSerial, '1056a040');
  assert.deepEqual(edl.chipInfo, { hwid: '002520e100510000', pkHash: '9823c68bf148113f5be92310de6cbc2e84e2aef962eeded50dc51717feebfae3' });
  assert.deepEqual([...new Set(ph.helloVersions)], [3], 'answers the hello with the device version');
  const a = await edl.read('abl_a');
  assert.equal(a.length, 1 << 20);
  assert.ok(startsWith(a, STOCK7));
  assert.ok((await edl.read('abl_b')).every((x) => x === 0));
  await edl.write('abl_a', FREE7);
  assert.ok(startsWith(await edl.read('abl_a'), FREE7));
  assert.deepEqual(ph.writes.map((w) => ph.where(w)), ['abl_a']);
  await assert.rejects(edl.write('abl_a', new Uint8Array((1 << 20) + 1)), /larger than abl_a/);
  await edl.reset();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ph.booted, 1);
  assert.deepEqual(ph.forbidden, []);
  assert.ok(ph.firehoseCmds.every((c) => allowed.has(c)), ph.firehoseCmds.join());
});

test('Sahara 2 (SDM845): MSM ID from the 64-bit hardware ID, masked like bkerler/edl', async () => {
  for (const top of [0x00, 0x05]) {
    const ph = attach(new FakePhone({ sahara: 2, msmId: 0x08b0e1, hwidTop: top, stockA: STOCK5, stockB: STOCK5 }).plug('edl'));
    const { msmId } = await usb.edlDriver(quiet).connect(ph.loader, 'ufs');
    assert.equal(msmId, 0x08b0e1);
    assert.deepEqual([...new Set(ph.helloVersions)], [2]);
  }
});

test('chip ID not readable or command mode refused: not fatal, SoC unchecked', async () => {
  for (const opts of [{ chipIdFails: true }, { commandMode: false }]) {
    const ph = attach(new FakePhone({ stockA: STOCK7, ...opts }).plug('edl'));
    const edl = usb.edlDriver(quiet);
    assert.equal((await edl.connect(ph.loader, 'ufs')).msmId, null);
    assert.ok(startsWith(await edl.read('abl_a'), STOCK7));
  }
});

test('wrong loader: clear error', async () => {
  const ph = attach(new FakePhone({ stockA: STOCK7 }).plug('edl'));
  const bad = ph.loader.slice();
  bad[5000] ^= 1;
  await assert.rejects(usb.edlDriver(quiet).connect(bad, 'ufs'), /refused the loader/);
});

test('configure: loader with a smaller payload, loader without log lines', async () => {
  const ph = attach(new FakePhone({ stockA: STOCK7, maxPayload: 262144, configureLogs: false }).plug('edl'));
  const edl = usb.edlDriver(quiet);
  await edl.connect(ph.loader, 'ufs');
  const big = new Uint8Array(1 << 20).map((_, i) => (i * 13) & 0xff);
  big.set(FREE7);
  await edl.write('abl_a', big);
  assert.ok(startsWith(ph.part('abl_a'), big));
});

test('wrong storage type: clear error, eMMC device works with 512-byte sectors', async () => {
  let ph = attach(new FakePhone({ stockA: STOCK7 }).plug('edl'));
  await assert.rejects(usb.edlDriver(quiet).connect(ph.loader, 'emmc'), /refused the configuration for eMMC/);
  ph = attach(new FakePhone({ memory: 'emmc', stockA: STOCK7 }).plug('edl'));
  const edl = usb.edlDriver(quiet);
  await edl.connect(ph.loader, 'emmc');
  assert.ok(startsWith(await edl.read('abl_a'), STOCK7));
  await edl.write('abl_a', FREE7);
  assert.deepEqual(ph.writes.map((w) => ph.where(w)), ['abl_a']);
  assert.ok(ph.reads.every((r) => r.lun === 0));
});

test('page reloaded with the loader already running: reconnects without a new upload', async () => {
  const ph = attach(new FakePhone({ stockA: STOCK7 }).plug('edl'));
  await usb.edlDriver(quiet).connect(ph.loader, 'ufs');
  ph.dev.waiters.length = 0;             // the old page's reads die with it
  const edl = usb.edlDriver(quiet);
  const { msmId } = await edl.connect(ph.loader, 'ufs');
  assert.equal(msmId, null);
  assert.equal(ph.loads, 1);
  assert.ok(startsWith(await edl.read('abl_a'), STOCK7));
});

test('page closed in the middle of a command: its unread replies do not shift the next page', async () => {
  const ph = attach(new FakePhone({ stockA: STOCK7 }).plug('edl'));
  await usb.edlDriver(quiet).connect(ph.loader, 'ufs');
  ph.dev.waiters.length = 0;
  // the old page sent a nop and a configure and went away before reading
  await ph.dev.out(new TextEncoder().encode('<?xml version="1.0" ?><data><nop /></data>'));
  await ph.dev.out(new TextEncoder().encode('<?xml version="1.0" ?><data><configure MemoryName="UFS" MaxPayloadSizeToTargetInBytes="1048576" /></data>'));
  assert.ok(ph.dev.inq.length > 20);
  const edl = usb.edlDriver(quiet);
  await edl.connect(ph.loader, 'ufs');
  assert.ok(startsWith(await edl.read('abl_a'), STOCK7));
  assert.ok((await edl.read('abl_b')).every((x) => x === 0));
  await edl.write('abl_a', FREE7);
  assert.ok(startsWith(await edl.read('abl_a'), FREE7));
});

test('slow device: late replies are waited for, never lost', async () => {
  // each reply comes after qdl.js's own timeouts (1 s hello, 1-3 s firehose, 2 s data)
  const ph = attach(new FakePhone({ stockA: STOCK7, lag: { hello: 1500, configure: 4500, read: 2500, program: 4500 } }).plug('edl'));
  const edl = usb.edlDriver(quiet);
  assert.equal((await edl.connect(ph.loader, 'ufs')).msmId, 0x2520e1);
  ph.lag.read = 0;
  const { lun, start } = await edl.locate('abl_a');
  ph.lag.read = 2500;
  assert.ok(startsWith(STOCK7, await edl.firehose.cmdReadBuffer(lun, start, 1)));
  await edl.write('abl_a', FREE7);
  ph.lag = {};
  assert.ok(startsWith(await edl.read('abl_a'), FREE7));
  assert.deepEqual(ph.writes.map((w) => ph.where(w)), ['abl_a']);
});

test('device held by another program: says what to close', async () => {
  const ph = attach(new FakePhone({ stockA: STOCK7, busy: true }));
  await assert.rejects(usb.fastbootDriver(quiet).connect(), /adb kill-server/);
  ph.plug('edl');
  await assert.rejects(usb.edlDriver(quiet).connect(ph.loader, 'ufs'), /qcserial.*adb kill-server/);
});

test('partition list, Android build and firmware dump through the real driver; large transfers', async () => {
  const ph = attach(new FakePhone({ stockA: STOCK7, stockB: STOCK7, android: { a: { patch: '2023-06-05' }, b: { patch: '2023-11-05' } } }).plug('edl'));
  const edl = usb.edlDriver(quiet);
  await edl.connect(ph.loader, 'ufs');
  const names = (await edl.partitions()).map((p) => p.name);
  for (const n of ['userdata', 'xbl_a', 'xbl_b', 'abl_a', 'abl_b', 'vbmeta_a', 'boot_b']) assert.ok(names.includes(n), n);
  assert.equal((await core.androidBuild(edl, 'a')).patch, '2023-06-05');
  assert.equal((await core.androidBuild(edl, 'b')).patch, '2023-11-05');
  assert.equal((await edl.read('vbmeta_a', 4096)).length, 4096);
  const before = ph.transfersIn;
  await edl.read('abl_a');
  assert.ok(ph.transfersIn - before < 10, `${ph.transfersIn - before} USB transfers for 1 MiB`);
  const dev = core.resolveDevice(table, { device: 'pockets' });
  const state = { serial: 'FAKE1234', slot: 'a' };
  const plan = await core.dumpPlan(edl, state);
  const chunks = [];
  const info = await core.dump(edl, dev, state, null, plan, { write: async (c) => chunks.push(c.slice()) }, quiet);
  assert.deepEqual(Object.keys(info.firmware).sort(), names.filter((n) => n !== 'userdata').sort());   // all small, userdata left out
  assert.deepEqual(ph.writes, []);
  assert.ok(ph.firehoseCmds.every((c) => allowed.has(c)), ph.firehoseCmds.join());
  const bk = await core.loadBackup(new Blob(chunks), dev, state);
  assert.ok(startsWith(bk.parts.abl_b, STOCK7));
  assert.equal(bk.info.android.patch, '2023-06-05');
});

// --- the page's steps (core.js) with the real drivers -------------------------
async function install(ph, device, stock, image) {
  attach(ph);
  const dev = core.resolveDevice(table, { device });
  const state = await core.check(usb.fastbootDriver(quiet), table, quiet);
  ph.plug('edl');
  const edl = usb.edlDriver(quiet);
  const msm = await core.edlConnect(edl, dev, ph.loader, false, quiet);
  const b = await core.backup(edl, dev, state, msm, quiet);
  const bk = await core.loadBackup(b.tar, dev, state);
  assert.ok(startsWith(bk.parts.abl_a, stock));
  const args = { via: 'edl', edl, dev, state, bk, image, imageSha: 'f'.repeat(64), untested: false,
                 confirm: typing('FLASH-ABL_A'), log: quiet };
  return { dev, state, edl, bk, b, args };
}

test('install, update and restore through the real drivers (Pocket S)', async () => {
  const ph = new FakePhone({ stockA: STOCK7, stockB: new Uint8Array(0) });
  const x = await install(ph, 'pockets', STOCK7, FREE7);
  await core.flash(x.args);
  assert.ok(startsWith(ph.part('abl_a'), FREE7));
  assert.ok(ph.part('abl_b').every((b) => b === 0));
  await x.edl.reset();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ph.state, 'boot');

  // update over FreeABL's fastboot
  const NEW7 = signedElf(7, 'freeabl-new');
  ph.plug('fastboot');
  await core.flash({ ...x.args, via: 'fastboot', fb: usb.fastbootDriver(quiet), image: NEW7 });
  assert.ok(startsWith(ph.part('abl_a'), NEW7));
  assert.ok(ph.fastbootCmds.includes('flash:abl_a'), ph.fastbootCmds.join());

  // back to stock over fastboot, then over EDL
  await core.restore({ via: 'fastboot', fb: usb.fastbootDriver(quiet), state: x.state, bk: x.bk, confirm: typing('RESTORE-ABL_A'), log: quiet });
  assert.ok(startsWith(ph.part('abl_a'), STOCK7));
  ph.part('abl_a').set(NEW7);
  ph.plug('edl');
  const edl = usb.edlDriver(quiet);
  await edl.connect(ph.loader, 'ufs');
  await core.restore({ via: 'edl', edl, state: x.state, bk: x.bk, confirm: typing('RESTORE-ABL_A'), log: quiet });
  assert.ok(startsWith(ph.part('abl_a'), STOCK7));
  assert.deepEqual([...new Set(ph.writes.map((w) => ph.where(w)))], ['abl_a']);
  assert.deepEqual(ph.forbidden, []);
});

test('install on the Odin (SDM845, Sahara 2)', async () => {
  const ph = new FakePhone({ sahara: 2, msmId: 0x08b0e1, stockA: STOCK5, stockB: STOCK5,
                             vars: { product: 'sdm845', variant: 'SDM UFS' } });
  const x = await install(ph, 'odin', STOCK5, FREE5);
  assert.equal(x.b.info.msm_id, '0x8b0e1');
  await core.flash(x.args);
  assert.ok(startsWith(ph.part('abl_a'), FREE5));
  assert.ok(startsWith(ph.part('abl_b'), STOCK5));
});

test('write that does not read back: stock put back, FreeABL not installed', async () => {
  const ph = new FakePhone({ stockA: STOCK7 });
  const x = await install(ph, 'pockets', STOCK7, FREE7);
  ph.corrupt = true;
  await assert.rejects(core.flash(x.args), /could not be put back. Do NOT reboot/);
  ph.corrupt = false;
  await core.restore({ via: 'edl', edl: x.edl, state: x.state, bk: x.bk, confirm: typing('RESTORE-ABL_A'), log: quiet });
  assert.ok(startsWith(ph.part('abl_a'), STOCK7));
});

test('stock bootloader refuses fastboot flash of abl: points to EDL', async () => {
  const ph = new FakePhone({ stockA: STOCK7, critical: true });
  const x = await install(ph, 'pockets', STOCK7, FREE7);
  ph.plug('fastboot');
  await assert.rejects(core.flash({ ...x.args, via: 'fastboot', fb: usb.fastbootDriver(quiet) }), /use EDL/);
  assert.ok(startsWith(ph.part('abl_a'), STOCK7));
});

test('wrong SoC caught from the chip ID over the real Sahara exchange', async () => {
  const ph = attach(new FakePhone({ sahara: 2, msmId: 0x08b0e1, stockA: STOCK5 }).plug('edl'));
  const dev = core.resolveDevice(table, { device: 'pockets' });
  await assert.rejects(core.edlConnect(usb.edlDriver(quiet), dev, ph.loader, false, quiet), /MSM ID 0x8b0e1/);
});
