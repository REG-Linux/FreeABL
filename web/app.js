// SPDX-License-Identifier: GPL-3.0-or-later
// FreeABL web flasher: the page. The checks and steps are in core.js.
import * as core from './core.js';
import { SimDevice, signedElf } from './sim.js';

const $ = (id) => document.getElementById(id);
const SIM = new URLSearchParams(location.search).has('sim');
const logEl = $('log');
let table, usb, release;
let state = null;      // from the fastboot check
let edl = null;        // connected EDL session
let made = null;       // backup made in this session
let proven = null;     // parsed backup the user proved they saved
let sim = null;
let adb = null;        // device in Android, connected over USB debugging
let fb = null;         // the fastboot connection of the check
let seen = null;       // what USB debugging showed: serial, chip serial

function log(msg) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

async function run(btn, fn) {
  const busy = [...document.querySelectorAll('main button')].filter((b) => !b.disabled);
  busy.forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } catch (e) {
    log(e instanceof core.Stop ? `STOP: ${e.message}` : `ERROR: ${e?.message || e}`);
    if (!(e instanceof core.Stop)) console.error(e);
  } finally {
    busy.forEach((b) => { b.disabled = false; });
    refresh();
  }
}

const readFile = async (input) => (input.files[0] ? new Uint8Array(await input.files[0].arrayBuffer()) : null);

function selection(forWrite = true) {
  return core.resolveDevice(table, { device: $('device').value, soc: $('device').value === 'other' ? $('soc').value : '',
                                     memory: $('memory').value, untested: $('untested').checked, forWrite });
}

// --- drivers ---------------------------------------------------------------
function simDevice() {
  if (!sim) {
    const dev = selection(false);
    sim = new SimDevice({ stockA: signedElf(dev.mbn, 'stock'), stockB: new Uint8Array(0), msmId: dev.msmId ?? 0x99e1 });
    window.freeablSim = sim;
  }
  return sim;
}
const fastbootDriver = () => (SIM ? simDevice().fastboot : usb.fastbootDriver(log));
const adbDriver = () => (SIM ? simDevice().adb : usb.adbDriver(log));
// the loader chosen, checked; else the one validated on the device, fetched and checked
async function loaderBytes(dev) {
  const chosen = (expert() || !dev.loaderUrl) ? await readFile($('loader')) : null;
  if (chosen) { await core.checkLoader(dev, chosen, false, log); return chosen; }
  if (SIM) return new Uint8Array(1);
  if (!dev.loaderUrl) return null;
  log(`Fetching the EDL loader: ${dev.loaderUrl}`);
  const r = await fetch(dev.loaderUrl).catch(() => null);
  if (!r?.ok) throw new core.Stop(`cannot fetch the EDL loader: choose it in section 1 (${dev.loaderHint})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  await core.checkLoader(dev, bytes, true, log);
  return bytes;
}

async function edlSession(dev) {
  if (edl) return edl;
  const loader = await loaderBytes(dev);
  const driver = SIM ? simDevice().edl : usb.edlDriver(log);
  log('Connecting to the device in EDL...');
  const msmId = await core.edlConnect(driver, dev, loader, $('untested').checked, log);
  edl = { driver, msmId };
  return edl;
}

const expert = () => $('untested').checked;
async function fetchBytes(url) {
  const r = await fetch(url).catch(() => null);
  if (!r?.ok) throw new core.Stop(`cannot download ${url}: check the connection, or tick "Expert / tester mode" and choose the file`);
  return new Uint8Array(await r.arrayBuffer());
}

// the release's image, fetched and checked; in expert mode the one chosen, if any
async function image(dev) {
  if (SIM) return { bytes: signedElf(dev.mbn, 'freeabl'), sha: await core.sha256hex(signedElf(dev.mbn, 'freeabl')) };
  if (!(expert() && $('image').files[0])) return core.releaseImage(release, dev, fetchBytes, log);
  const bytes = await readFile($('image'));
  const name = $('image').files[0].name;
  const sums = $('sums').files[0] ? await $('sums').files[0].text() : null;
  const sha = await core.checkImage(dev, name, bytes, sums, log);
  return { bytes, sha };
}

function confirmPhrase(phrase, text) {
  return new Promise((resolve) => {
    const d = $('confirm');
    $('confirm-text').textContent = text;
    $('confirm-phrase').textContent = phrase;
    $('confirm-input').value = '';
    d.onclose = () => resolve(d.returnValue === 'ok' ? $('confirm-input').value.trim() : '');
    d.showModal();
    $('confirm-input').focus();
  });
}

function download(bytes, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/x-tar' }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
}

// --- install ----------------------------------------------------------------
// kept only once connected: a cancelled device list leaves nothing half open
async function adbConnect() {
  log('== Device in Android (USB debugging)');
  const a = adbDriver();
  seen = await core.androidCheck(a, selection(false), log, table);
  if (!SIM) usb.pinSerial(seen.serial);
  adb = a;
}

async function doAdb() {
  await adbConnect();
  log('Read only: nothing was changed. Next: restart it in fastboot mode, for the check.');
}

async function doAdbReboot(mode) {
  // EDL comes after the fastboot check: the backup needs what it reads (slot, secure boot, battery)
  if (mode === 'edl' && !state) throw new core.Stop('first the check in fastboot mode: "Restart in fastboot mode", then "Connect in fastboot mode and check"');
  if (!adb) await adbConnect();
  await adb.reboot(mode);
  adb = null;
  log(mode === 'bootloader' ? 'Restarting in fastboot mode: when it shows the fastboot screen, use "Connect in fastboot mode and check".'
                            : 'Restarting in EDL (the screen stays black): then use "Connect in EDL and back up".');
}

async function doCheck() {
  edl = null; made = null; proven = null; sim = SIM ? sim : null;
  const dev = selection();
  log(`== Check (${dev.name})`);
  fb = fastbootDriver();
  state = await core.check(fb, table, log);
  if (!SIM) usb.pinSerial(state.serial);
  // the chip serial seen in Android: the device put in EDL must have it
  if (seen?.chipSerial && (!seen.serial || seen.serial === state.serial)) state.androidChipSerial = seen.chipSerial;
  log(`OK: device ${state.serial}, active slot ${state.slot}. Next: boot it to EDL and back up.`);
  if (!$('loader').files[0] && !SIM && !dev.loaderUrl) {
    log(`The backup needs the EDL loader: choose it now in section 1 (${dev.loaderHint || "the firehose loader from your device's firmware package"}).`);
  }
}

async function doFbAndroid() {
  // the device leaves the bus while answering: a transfer error here is the restart
  await fb.reboot().catch(() => {});
  fb = null;
  log('Android is starting. When it is up, restart it in EDL.');
}

async function doBackup() {
  const dev = selection();
  log('== Backup');
  // still answering in fastboot: it is not in EDL yet (gone: it was restarted by hand)
  if (fb && !SIM && (await Promise.race([fb.getVar('serialno'), new Promise((r) => setTimeout(() => r(null), 2000))]))) {
    throw new core.Stop('the device is still in fastboot mode: use "Restart Android", then "Connect over USB debugging and restart in EDL" (or your device\'s own way into EDL), then back up');
  }
  fb = null;
  const s = await edlSession(dev);
  const chosen = await readFile($('image'));   // to recognise FreeABL on a slot
  made = await core.backup(s.driver, dev, state, s.msmId, log, { freeablImages: chosen ? [chosen] : [] });
  download(made.tar, made.tarName);
  log(`Backup verified and downloaded as ${made.tarName}. Now select that file below.`);
  $('report').hidden = !made.report;
  if (made.report) $('report').textContent = `Tester report (open a "Device report" issue with it):\n${made.report}`;
}

// the whole firmware, streamed to a file the user picks (Chrome, Edge), else downloaded at the end
async function saveTo(name) {
  if (window.showSaveFilePicker && !SIM) {
    const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'tar archive', accept: { 'application/x-tar': ['.tar'] } }] });
    const w = await h.createWritable();
    return { write: (c) => w.write(c), close: () => w.close(), abort: () => w.abort() };
  }
  // without it the whole file (GBs) would sit in memory: Chrome on Android, for one
  if (!SIM) throw new core.Stop('this browser cannot write a large file as it goes: save the firmware with Chrome or Edge on a computer, or with the command-line tool (freeabl-flash.py dump)');
  const chunks = [];
  return { write: async (c) => { chunks.push(c.slice()); }, close: async () => download(new Blob(chunks), name), abort: async () => {} };
}

async function doDump() {
  const dev = selection();
  const tag = made.tarName.replace(/^freeabl-backup-/, '');
  // ask where to save first: the browser only opens its dialog right after the click
  const sink = await saveTo(`freeabl-firmware-${tag}`);
  log('== Save the whole firmware (read only)');
  try {
    const s = await edlSession(dev);
    const plan = await core.dumpPlan(s.driver, state);
    log(`${plan.parts.length} partitions, ${Math.round(plan.bytes / (1 << 20))} MiB, ${core.androidLabel(plan.android)}. Left out: ${plan.skipped.join(', ') || 'none'}`);
    const chosen = await readFile($('image'));
    await core.dump(s.driver, dev, state, s.msmId, plan, sink, log, { freeablImages: chosen ? [chosen] : [] });
    await sink.close();
  } catch (e) {
    await sink.abort().catch(() => {});
    throw e;
  }
  log(`Firmware saved as freeabl-firmware-${tag}. Keep it with your backup: Back to stock accepts it too.`);
}

async function doProve() {
  const dev = selection();
  const t = await readFile($('backup-proof'));
  if (!t) return;
  if (!core.sameBytes(t, made.tar)) throw new core.Stop('this file is not the backup made just now: select the downloaded file');
  proven = await core.loadBackup(t, dev, state);
  log('Backup file checked: flashing unlocked.');
}

async function doFlash() {
  const dev = selection();
  const img = await image(dev);
  log('== Flash');
  const s = await edlSession(dev);
  await core.flash({ via: 'edl', edl: s.driver, dev, state, bk: proven, image: img.bytes, imageSha: img.sha,
                     untested: $('untested').checked, confirm: confirmPhrase, log });
  log('Next: reboot.');
}

async function doReset() {
  await edl.driver.reset();
  edl = null;
  log('Rebooting. FreeABL should show its menu.');
}

// --- update and restore -----------------------------------------------------
async function backupFrom(input, dev, st) {
  const f = input.files[0];
  if (!f) throw new core.Stop('choose your backup or firmware file (freeabl-backup-… or freeabl-firmware-….tar)');
  return core.loadBackup(f, dev, st);   // read as needed: a firmware file is large
}

async function doUpdate() {
  const dev = selection();
  log('== Update over fastboot');
  const fb = fastbootDriver();
  state = await core.check(fb, table, log);
  const bk = await backupFrom($('update-backup'), dev, state);
  const img = await image(dev);
  await core.flash({ via: 'fastboot', fb, dev, state, bk, image: img.bytes, imageSha: img.sha,
                     untested: $('untested').checked, confirm: confirmPhrase, log });
}

async function doRestore(via) {
  const dev = selection(false);
  log(`== Restore over ${via}`);
  let st = null;
  const fb = via === 'fastboot' ? fastbootDriver() : null;
  if (fb) st = await core.check(fb, table, log);
  const bk = await backupFrom($('restore-backup'), dev, st);
  st = st || { serial: bk.info.serial, slot: bk.info.slot };
  const e = via === 'edl' ? (await edlSession(dev)).driver : null;
  await core.restore({ via, edl: e, fb, state: st, bk, confirm: confirmPhrase, log });
  if (via === 'edl') { await e.reset(); edl = null; log('Rebooting.'); }
}

// --- page -------------------------------------------------------------------
function refresh() {
  const sel = $('device').value;
  $('soc-row').hidden = sel !== 'other';
  let note = '';
  try {
    const dev = selection(false);
    note = { current: 'Validated with this build.', earlier: 'Validated with an earlier build only: needs tester mode.',
             none: 'Never run on this device: needs tester mode.' }[dev.validated];
    const auto = [release?.images?.[dev.soc] && `FreeABL ${release.tag}`, dev.loaderUrl && 'the EDL loader'].filter(Boolean);
    $('auto-note').textContent = auto.length && !expert() ? `${auto.join(' and ')} for this device are downloaded and checked automatically.` : '';
    $('image-row').hidden = $('sums-row').hidden = !expert();
    $('loader-row').hidden = !expert() && !!dev.loaderUrl;
    $('usb-name-note').textContent = dev.usbName ? `In the browser's device list, the ${dev.name} appears as ${dev.usbName}…` : '';
    $('loader-note').textContent = dev.loaderUrl
      ? `Loader: leave empty to fetch the one validated on this device (${dev.loaderHint}), or choose your own.`
      : dev.loaderHint ? `Loader: ${dev.loaderHint}.` : 'Loader: the firehose loader from your device\'s firmware package.';
  } catch (e) { note = e.message; }
  $('device-note').textContent = note;
  $('btn-backup').disabled = !state;
  $('btn-adb-fastboot').disabled = !adb;
  $('btn-adb-edl').disabled = !state;
  $('btn-fb-android').disabled = !fb;
  $('backup-proof').disabled = !made;
  $('btn-dump').disabled = !made;
  $('btn-flash').disabled = !proven;
  $('btn-reset').disabled = !edl;
  const done = [!!state, !!made, !!proven];
  document.querySelectorAll('#tab-install .steps li').forEach((li, i) => li.classList.toggle('done', !!done[i]));
}

async function init() {
  table = await (await fetch('../devices.json')).json();
  release = await (await fetch('release.json')).json().catch(() => null);
  const dsel = $('device');
  for (const [id, d] of Object.entries(table.devices)) dsel.add(new Option(`${d.name} (${d.soc})`, id));
  dsel.add(new Option('Other device (testers)', 'other'));
  for (const s of Object.keys(table.soc_mbn)) $('soc').add(new Option(s, s));
  if (SIM) $('sim-banner').hidden = false;
  else if (!('usb' in navigator)) $('nousb').hidden = false;
  if (!SIM) usb = await import('./usb.js');
  const reset = () => { state = null; edl = null; made = null; proven = null; sim = null; adb = null; fb = null; seen = null;
                         if (usb) usb.pinSerial(null); refresh(); };
  ['device', 'soc', 'memory', 'untested'].forEach((id) => $(id).addEventListener('change', reset));
  $('btn-adb').onclick = (e) => run(e.target, doAdb);
  $('btn-adb-fastboot').onclick = (e) => run(e.target, () => doAdbReboot('bootloader'));
  $('btn-adb-edl').onclick = (e) => run(e.target, () => doAdbReboot('edl'));
  $('btn-fb-android').onclick = (e) => run(e.target, doFbAndroid);
  $('btn-check').onclick = (e) => run(e.target, doCheck);
  $('btn-backup').onclick = (e) => run(e.target, doBackup);
  $('backup-proof').onchange = (e) => run(e.target, doProve);
  $('btn-dump').onclick = (e) => run(e.target, doDump);
  $('btn-flash').onclick = (e) => run(e.target, doFlash);
  $('btn-reset').onclick = (e) => run(e.target, doReset);
  $('btn-update').onclick = (e) => run(e.target, doUpdate);
  $('btn-restore-fb').onclick = (e) => run(e.target, () => doRestore('fastboot'));
  $('btn-restore-edl').onclick = (e) => run(e.target, () => doRestore('edl'));
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
      document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${b.dataset.tab}`; });
    };
  });
  refresh();
  log(SIM ? 'Simulation ready.' : 'Ready. Choose the device and the files, then start with Check.');
}

init().catch((e) => log(`ERROR: ${e.message || e}`));
