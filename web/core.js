// SPDX-License-Identifier: GPL-3.0-or-later
// FreeABL web flasher: the checks and steps, independent of USB and of the page.
// Same rules as tools/freeabl-flash.py: one partition written (abl_<active slot>),
// never the partition table, never the active slot; no flash without a verified
// backup of the stock ABL; the image's signature format must match the stock ABL's.
//
// Drivers (real ones in usb.js, simulated ones in sim.js):
//   fastboot: connect(), getVar(name) -> string|null, flash(part, bytes), reboot()
//   edl:      connect(loaderBytes, memory) -> {msmId: number|null}, read(part) -> bytes,
//             write(part, bytes), reset()

export class Stop extends Error {}
const stop = (msg) => { throw new Stop(msg); };
export const SLOTS = ['a', 'b'];

// --- bytes ------------------------------------------------------------------
export async function sha256hex(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const allZero = (b) => b.every((x) => x === 0);
export const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export const startsWith = (big, small) => big.length >= small.length && small.every((x, i) => x === big[i]);

/** Signature format of a signed ABL ELF: 5, 6, 7; 'empty' if all zeros; null if unknown. */
export function mbnVersion(d) {
  if (allZero(d)) return 'empty';
  if (d.length < 64 || d[0] !== 0x7f || d[1] !== 0x45 || d[2] !== 0x4c || d[3] !== 0x46) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const cls = d[4];
  let phoff, phentsize, phnum, flAt, offAt, wide;
  if (cls === 1) {
    phoff = v.getUint32(0x1c, true); phentsize = v.getUint16(0x2a, true); phnum = v.getUint16(0x2c, true);
    flAt = 24; offAt = 4; wide = false;
  } else if (cls === 2) {
    phoff = Number(v.getBigUint64(0x20, true)); phentsize = v.getUint16(0x36, true); phnum = v.getUint16(0x38, true);
    flAt = 4; offAt = 8; wide = true;
  } else return null;
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (p + phentsize > d.length) return null;
    const flags = v.getUint32(p + flAt, true);
    const off = wide ? Number(v.getBigUint64(p + offAt, true)) : v.getUint32(p + offAt, true);
    if (((flags >>> 24) & 7) === 2) return off + 8 <= d.length ? v.getUint32(off + 4, true) : null;
  }
  return null;
}

// --- tar (ustar, files only): the backup is one file the user keeps -----------
export function makeTar(files) {
  const enc = new TextEncoder();
  const parts = [];
  for (const { name, data } of files) {
    const h = new Uint8Array(512);
    const put = (s, off, len) => h.set(enc.encode(s).subarray(0, len), off);
    const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
    put(name, 0, 100);
    put(oct(0o644, 8), 100, 8);
    put(oct(0, 8), 108, 8);
    put(oct(0, 8), 116, 8);
    put(oct(data.length, 12), 124, 12);
    put(oct(0, 12), 136, 12);
    put('        ', 148, 8);
    put('0', 156, 1);
    put('ustar\0' + '00', 257, 8);
    let sum = 0;
    for (const b of h) sum += b;
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function readTar(t) {
  const dec = new TextDecoder();
  const files = {};
  for (let o = 0; o + 512 <= t.length;) {
    const h = t.subarray(o, o + 512);
    if (allZero(h)) break;
    const name = dec.decode(h.subarray(0, 100)).replace(/\0.*$/s, '');
    const size = parseInt(dec.decode(h.subarray(124, 136)).replace(/\0.*$/s, '').trim() || '0', 8);
    if (!name || Number.isNaN(size) || o + 512 + size > t.length) stop('the backup file is damaged (not a complete tar archive)');
    files[name] = t.slice(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

// --- devices ----------------------------------------------------------------
export function resolveDevice(table, { device, soc, memory, untested, forWrite = true }) {
  if (device === 'other') {
    if (!soc) stop(`"Other device" needs the SoC (one of: ${Object.keys(table.soc_mbn).join(', ')})`);
    if (!(soc in table.soc_mbn)) stop(`unknown SoC ${soc}`);
    if (!untested && forWrite) stop('"Other device" is for testers: tick "Tester mode (untested)"');
    return { id: 'other', name: `unlisted ${soc} device`, soc, mbn: table.soc_mbn[soc], validated: 'none',
             memory: memory || 'ufs', msmId: null };
  }
  const d = table.devices[device];
  if (!d) stop(`unknown device ${device}`);
  if (soc && soc !== d.soc) stop(`the ${d.name} is ${d.soc}: for another SoC choose "Other device"`);
  return { id: device, name: d.name, soc: d.soc, mbn: d.mbn, validated: d.validated,
           memory: memory || d.memory || 'ufs', msmId: d.msm_id === null ? null : parseInt(d.msm_id, 16),
           loaderHint: d.loader_hint_web || d.loader_hint };
}

export const imageName = (soc) => `abl_signed-${soc.toUpperCase()}-ESP-r34.elf`;

/** sums: text of a .sha256 or SHA256SUMS file, or null. Returns the image sha256. */
export async function checkImage(dev, name, bytes, sums, log) {
  const h = await sha256hex(bytes);
  let listed = null;
  if (sums) {
    for (const line of sums.split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 2 && p[p.length - 1].replace(/^\*/, '').split('/').pop() === name) listed = p[0].toLowerCase();
    }
    if (listed === null) stop(`the checksum file does not list ${name}`);
    if (listed !== h) stop(`${name}: sha256 ${h} does not match the checksum file (${listed})`);
    log(`image sha256 OK (${h.slice(0, 16)}...)`);
  } else {
    log(`note: no checksum file given; image sha256 ${h}`);
  }
  const v = mbnVersion(bytes);
  if (v !== dev.mbn) stop(`${name} has signature format ${v}, the ${dev.name} needs v${dev.mbn}`);
  if (!name.includes(`-${dev.soc.toUpperCase()}-`)) stop(`${name} is not the ${dev.soc} image`);
  return h;
}

// --- steps ------------------------------------------------------------------
export async function check(fb, table, log) {
  await fb.connect();
  const v = {};
  for (const k of ['serialno', 'product', 'variant', 'unlocked', 'secure', 'current-slot', 'battery-voltage']) {
    v[k] = await fb.getVar(k).catch(() => null);
    log(`  ${k.padEnd(16)} ${v[k] || '-'}`);
  }
  if (v.unlocked !== 'yes') stop('the bootloader is locked. FreeABL images carry a test signature and need an unlocked bootloader');
  // a test signature only runs with secure boot off (fuse not blown); an update could turn it on
  if (v.secure !== 'no') stop(v.secure ? `secure boot is on (secure = ${v.secure}): this device only runs bootloaders signed by its maker, FreeABL would not start. Not flashing`
                                       : 'the bootloader does not say whether secure boot is off (getvar secure): not flashing');
  const slot = (v['current-slot'] || '').replace(/^_/, '');
  if (!SLOTS.includes(slot)) stop(`cannot read the active slot (current-slot = ${v['current-slot']})`);
  const mv = parseInt(v['battery-voltage'] || '0', 10) || 0;
  if (mv && mv < table.min_battery_mv) stop(`battery at ${mv} mV: charge above ${table.min_battery_mv} mV first (the bootloader does not charge)`);
  if (!mv) log('note: battery level unknown: make sure the battery is above 50%');
  if (!v.serialno) stop('the device did not report its serial number');
  return { serial: v.serialno, slot, product: v.product, variant: v.variant, time: new Date().toISOString() };
}

export async function edlConnect(edl, dev, loader, untested, log) {
  if (!loader) stop(`the ${dev.name} needs an EDL loader file${dev.loaderHint ? ` (${dev.loaderHint})` : ''}`);
  const { msmId } = await edl.connect(loader, dev.memory);
  if (msmId !== null && dev.msmId !== null && msmId !== dev.msmId) {
    if (!untested) stop(`EDL reports MSM ID 0x${msmId.toString(16)}, the ${dev.name} has 0x${dev.msmId.toString(16)}: wrong device? (testers: tester mode)`);
    log(`WARNING: MSM ID 0x${msmId.toString(16)} differs from the ${dev.name}'s 0x${dev.msmId.toString(16)} (tester mode)`);
  }
  if (msmId === null) log('note: MSM ID not available: SoC not checked');
  return msmId;
}

/** Reads abl_a and abl_b twice. Returns the backup archive and its description. */
export async function backup(edl, dev, state, msmId, log) {
  const info = { device: dev.id, soc: dev.soc, product: state.product || null, variant: state.variant || null,
                 serial: state.serial, slot: state.slot, msm_id: msmId === null ? null : `0x${msmId.toString(16)}`,
                 time: new Date().toISOString(), partitions: {} };
  const files = [];
  for (const s of SLOTS) {
    const part = `abl_${s}`;
    const a = await edl.read(part);
    const b = await edl.read(part);
    if (!a.length) stop(`EDL read of ${part} gave no data`);
    if (!sameBytes(a, b)) stop(`${part}: two reads differ: check the cable and try again`);
    const v = mbnVersion(a);
    const h = await sha256hex(a);
    info.partitions[part] = { sha256: h, mbn: v };
    files.push({ name: `${state.serial}/${part}.stock.img`, data: a });
    log(`${part}: ${v === 'empty' ? 'EMPTY (all zeros)' : v ? `signature v${v}` : 'NOT A SIGNED ABL'}  sha256 ${h.slice(0, 16)}...`);
  }
  const act = info.partitions[`abl_${state.slot}`].mbn;
  if (act !== dev.mbn) stop(`the active abl_${state.slot} has signature format ${act}, FreeABL for the ${dev.name} is v${dev.mbn}: not flashing this device`);
  const enc = new TextEncoder();
  files.push({ name: `${state.serial}/backup.json`, data: enc.encode(JSON.stringify(info, null, 1) + '\n') });
  files.push({ name: `${state.serial}/SHA256SUMS`, data: enc.encode(SLOTS.map((s) => `${info.partitions[`abl_${s}`].sha256}  abl_${s}.stock.img\n`).join('')) });
  const tar = makeTar(files);
  const report = dev.validated === 'current' ? null :
    `soc ${dev.soc}, MSM ID ${info.msm_id || 'not seen'}, stock signature v${act}, fastboot product ${state.product || '-'}, variant ${state.variant || '-'}, storage ${dev.memory}`;
  return { tar, tarName: `freeabl-backup-${state.serial}.tar`, info, report };
}

/** Parses and checks a backup archive. state: from check(), or null (EDL restore without fastboot). */
export async function loadBackup(tar, dev, state) {
  const files = readTar(tar);
  const jsonName = Object.keys(files).find((n) => n.endsWith('/backup.json'));
  if (!jsonName) stop('this is not a FreeABL backup (no backup.json)');
  const dir = jsonName.slice(0, -'backup.json'.length);
  const info = JSON.parse(new TextDecoder().decode(files[jsonName]));
  if (info.device !== dev.id || info.soc !== dev.soc) stop(`the backup was made for '${info.device}' (${info.soc}), not '${dev.id}' (${dev.soc})`);
  if (state && info.serial !== state.serial) stop(`the backup is for device ${info.serial}, the connected device is ${state.serial}`);
  if (state && info.slot !== state.slot) stop('the active slot changed since the backup: make a new backup');
  const parts = {};
  for (const s of SLOTS) {
    const p = `abl_${s}`;
    const d = files[`${dir}${p}.stock.img`];
    if (!d) stop(`the backup has no ${p}`);
    if ((await sha256hex(d)) !== info.partitions[p].sha256) stop(`${p} in the backup is damaged (sha256 mismatch)`);
    parts[p] = d;
  }
  return { info, parts };
}

async function writeVerified(edl, part, bytes) {
  await edl.write(part, bytes);
  return startsWith(await edl.read(part), bytes);
}

/** confirm(phrase, message) resolves to what the user typed. */
export async function flash({ via, edl, fb, dev, state, bk, image, imageSha, untested, confirm, log }) {
  const part = `abl_${state.slot}`;
  let warn = '';
  let phrase = `FLASH-${part.toUpperCase()}`;
  if (dev.validated === 'earlier') warn = `WARNING: the ${dev.name} was validated with an earlier FreeABL build only. This build was not run on it yet.`;
  if (dev.validated === 'none') warn = 'WARNING: FreeABL was never run on this device. If it does not boot, you need EDL without Android (button combination or test point) and your backup to recover.';
  if (dev.validated !== 'current') {
    if (!untested) stop(`the ${dev.name} is not validated with this build: tick "Tester mode (untested)"`);
    phrase = `FLASH-UNTESTED-${part.toUpperCase()}`;
  }
  const typed = await confirm(phrase, `About to write the image (sha256 ${imageSha.slice(0, 16)}...) to ${part} of the ${dev.name} ${state.serial} via ${via}. Nothing else is written.${warn ? '\n' + warn : ''}`);
  if (typed !== phrase) stop('aborted');
  if (via === 'edl') {
    if (await writeVerified(edl, part, image)) { log(`WRITE VERIFIED: ${part} holds FreeABL.`); return; }
    log(`READBACK MISMATCH: restoring the stock ${part}`);
    if (await writeVerified(edl, part, bk.parts[part])) stop(`stock ${part} restored and verified; FreeABL was not installed`);
    stop(`stock ${part} restore NOT verified: do not reboot; retry the restore`);
  }
  await fb.connect();
  const serial = await fb.getVar('serialno');
  if (serial !== state.serial) stop('the device in fastboot mode is not the one in the backup');
  try {
    await fb.flash(part, image);
  } catch (e) {
    if (/ritical/.test(String(e?.message || e))) stop('the stock bootloader refuses to write abl (critical partition): use EDL (no data loss)');
    throw e;
  }
  log(`FLASHED ${part}. fastboot cannot read it back.`);
}

export async function restore({ via, edl, fb, state, bk, confirm, log }) {
  const part = `abl_${state.slot}`;
  const stock = bk.parts[part];
  if (['empty', null].includes(mbnVersion(stock))) stop(`the backup of ${part} is not a signed ABL: refusing to write it`);
  const phrase = `RESTORE-${part.toUpperCase()}`;
  const typed = await confirm(phrase, `About to write the stock backup to ${part} of ${state.serial} via ${via}.`);
  if (typed !== phrase) stop('aborted');
  if (via === 'edl') {
    if (!(await writeVerified(edl, part, stock))) stop(`readback of ${part} does not match the backup: do not reboot; retry`);
    log(`RESTORE VERIFIED: ${part} is stock again.`);
    return;
  }
  await fb.connect();
  if ((await fb.getVar('serialno')) !== state.serial) stop('the device in fastboot mode is not the one in the backup');
  await fb.flash(part, stock);
  log(`RESTORED ${part}.`);
}
