// SPDX-License-Identifier: GPL-3.0-or-later
// FreeABL web flasher: the checks and steps, independent of USB and of the page.
// Same rules as tools/freeabl-flash.py: one partition written (abl_<active slot>),
// never the partition table, never the active slot; no flash without a verified
// backup of the stock ABL; the image's signature format must match the stock ABL's.
//
// Drivers (real ones in usb.js, simulated ones in sim.js):
//   adb:      connect(), props() -> {name: value}, reboot('bootloader'|'edl')
//   fastboot: connect(), getVar(name) -> string|null, flash(part, bytes), reboot()
//   edl:      connect(loaderBytes, memory) -> {msmId: number|null}, partitions() ->
//             [{name, lun, start, sectors, bytes}], read(part, maxBytes?) -> bytes,
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
export const tarPad = (n) => new Uint8Array((512 - (n % 512)) % 512);
export const TAR_END = new Uint8Array(1024);

export function tarHeader(name, size) {
  const enc = new TextEncoder();
  const h = new Uint8Array(512);
  const put = (s, off, len) => h.set(enc.encode(s).subarray(0, len), off);
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(0, 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0' + '00', 257, 8);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

export function makeTar(files) {
  const parts = [];
  for (const { name, data } of files) parts.push(tarHeader(name, data.length), data, tarPad(data.length));
  parts.push(TAR_END);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Index of a tar in a Blob or File, without reading the file contents: { name: () => bytes }. */
export async function tarIndex(blob) {
  const dec = new TextDecoder();
  const files = {};
  for (let o = 0; o + 512 <= blob.size;) {
    const h = new Uint8Array(await blob.slice(o, o + 512).arrayBuffer());
    if (allZero(h)) break;
    const name = dec.decode(h.subarray(0, 100)).replace(/\0.*$/s, '');
    const size = parseInt(dec.decode(h.subarray(124, 136)).replace(/\0.*$/s, '').trim() || '0', 8);
    if (!name || Number.isNaN(size) || o + 512 + size > blob.size) stop('the backup file is damaged (not a complete tar archive)');
    const at = o + 512;
    files[name] = async () => new Uint8Array(await blob.slice(at, at + size).arrayBuffer());
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
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

// --- Android build -------------------------------------------------------------
// A stock ABL belongs to the Android build it came with: restoring it under
// another build, or running FreeABL on a build it was not tried on, may not
// boot. The version and security patch are read as the ABL itself does (CLO
// VerifiedBoot.c, GetOsVerAndSecPactchLevel): the com.android.build.boot.*
// properties of vbmeta_<slot>, else the boot image header. vbmeta_sha256 tells
// two builds apart: vbmeta holds the hashes of all the images.

/** The properties of an AVB vbmeta image, { key: value }; {} if it is not one. */
export function avbProps(d) {
  const props = {};
  if (!d || d.length < 256 || new TextDecoder().decode(d.subarray(0, 4)) !== 'AVB0') return props;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u64 = (o) => Number(v.getBigUint64(o, false));
  const dec = new TextDecoder();
  let o = 256 + u64(12) + u64(96);              // auxiliary block + descriptors offset
  const end = o + u64(104);
  if (end > d.length) return props;
  while (o + 16 <= end) {
    const tag = u64(o), n = u64(o + 8);
    if (tag === 0 && o + 32 <= end) {           // property descriptor: key\0value\0
      const kl = u64(o + 16), vl = u64(o + 24), k = o + 32;
      if (k + kl + 1 + vl <= end) props[dec.decode(d.subarray(k, k + kl))] = dec.decode(d.subarray(k + kl + 1, k + kl + 1 + vl));
    }
    o += 16 + n;
  }
  return props;
}

/** os_version and security patch (YYYY-MM) from a boot image header, or null. */
export function bootHeaderVersion(d) {
  if (!d || d.length < 48 || new TextDecoder().decode(d.subarray(0, 8)) !== 'ANDROID!') return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const raw = v.getUint32(v.getUint32(40, true) >= 3 ? 16 : 44, true);
  if (!raw) return null;
  const ver = raw >>> 11, lvl = raw & 0x7ff;
  const abc = [(ver >>> 14) & 127, (ver >>> 7) & 127, ver & 127];
  while (abc.length > 1 && abc[abc.length - 1] === 0) abc.pop();
  return { os_version: abc.join('.'), patch: `${2000 + (lvl >>> 4)}-${String(lvl & 15).padStart(2, '0')}` };
}

const missing = (e) => /not found/.test(String(e?.message || e));

/**
 * The Android build on a slot, over EDL (read only), or null when there is no
 * vbmeta nor version. os_version/patch: the boot side, what the ABL reads
 * (boot, or init_boot on GKI devices); system_*: what Android's Settings show.
 * They differ on devices whose vendor kept an older Android under a newer system.
 */
export async function androidBuild(edl, slot) {
  const get = (p, max) => edl.read(p, max).catch((e) => { if (missing(e)) return null; throw e; });
  const vb = await get(`vbmeta_${slot}`);
  const props = avbProps(vb);
  const sys = avbProps(await get(`vbmeta_system_${slot}`));
  const prop = (k) => props[`com.android.build.boot.${k}`] || props[`com.android.build.init_boot.${k}`] || null;
  let os = prop('os_version'), patch = prop('security_patch');
  if (!os || !patch) {
    const h = bootHeaderVersion(await get(`boot_${slot}`, 4096)) || bootHeaderVersion(await get(`init_boot_${slot}`, 4096));
    if (h) { os = h.os_version; patch = h.patch; }
  }
  os ||= props['com.android.build.vendor.os_version'] || null;
  patch ||= props['com.android.build.vendor.security_patch'] || null;
  if (!vb && !os) return null;
  return {
    os_version: os, patch,
    system_os_version: sys['com.android.build.system.os_version'] || null,
    system_patch: sys['com.android.build.system.security_patch'] || null,
    fingerprint: sys['com.android.build.system.fingerprint'] || prop('fingerprint') || props['com.android.build.vendor.fingerprint'] || null,
    vbmeta_sha256: vb ? await sha256hex(vb) : null,
  };
}

/** The Android build as FreeABL's fastboot reports it (FreeABL 0.2 and later), or null. */
export async function fastbootAndroid(fb) {
  const g = async (k) => (await fb.getVar(k).catch(() => null)) || null;
  const a = { os_version: await g('android-os-version'), patch: await g('android-security-patch'),
              fingerprint: null, vbmeta_sha256: await g('vbmeta-sha256') };
  return a.os_version || a.vbmeta_sha256 ? a : null;
}

export function androidLabel(a) {
  if (!a) return 'Android version not known';
  const os = a.system_os_version || a.os_version, patch = a.system_patch || a.patch;
  const user = `Android ${os || '?'}, security patch ${patch || '?'}`;
  return a.os_version && (a.os_version !== os || a.patch !== patch) ? `${user} (boot side: Android ${a.os_version}, ${a.patch || '?'})` : user;
}

// FreeABL's fastboot sends the first 32 hex digits (a reply holds 60 characters;
// FreeABL 0.2 sent 59, upper case): compare what both sides have, at least 32
export function sameDigest(x, y) {
  const a = x.toLowerCase(), b = y.toLowerCase(), n = Math.min(a.length, b.length);
  return n >= 32 && a.slice(0, n) === b.slice(0, n);
}

/** true or false when the two can be compared, null when they cannot. */
export function sameBuild(a, b) {
  if (!a || !b) return null;
  if (a.vbmeta_sha256 && b.vbmeta_sha256) return sameDigest(a.vbmeta_sha256, b.vbmeta_sha256);
  if (a.os_version && a.patch && b.os_version && b.patch) return a.os_version === b.os_version && a.patch === b.patch;
  return null;
}

const month = (p) => (p || '').slice(0, 7);
/**
 * listed: the device has validated Android versions in devices.json; ok: this
 * version and patch month is among them; exact: this very build (fingerprint) too.
 */
export function androidValidated(dev, a) {
  const list = dev.android || [];
  if (!list.length) return { listed: false, ok: false, exact: false, list };
  const same = list.filter((x) => !!a?.patch && String(x.os_version) === String(a.os_version) && month(x.patch) === month(a.patch));
  return { listed: true, ok: same.length > 0, exact: same.some((x) => x.fingerprint && x.fingerprint === a.fingerprint), list };
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
  return { id: device, name: d.name, soc: d.soc, mbn: d.mbn, validated: d.validated, android: d.android || [],
           memory: memory || d.memory || 'ufs', msmId: d.msm_id === null ? null : parseInt(d.msm_id, 16),
           loaderHint: d.loader_hint_web || d.loader_hint, loaderUrl: d.loader_url || null, loaderSha256: d.loader_sha256 || null,
           usbName: d.usb_name || null };
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
/**
 * A device in Android with USB debugging: say what it is and warn early (locked
 * bootloader, an Android build FreeABL was not run on). Nothing is written; the
 * fastboot check that follows is the one that counts.
 */
export async function androidCheck(adb, dev, log, table = null) {
  await adb.connect();
  // picked from the browser's list by its USB name: another listed device's is a wrong pick
  const usbName = adb.usbProduct || '';
  if (table && usbName) {
    const other = Object.values(table.devices).find((d) => d.usb_name && usbName.startsWith(d.usb_name) && d.name !== dev.name);
    if (other) stop(`the device picked (${usbName}) is an ${other.name}, but ${dev.name} is selected: pick the other one, or select ${other.name}`);
  }
  const p = await adb.props();
  log(`  ${p['ro.product.manufacturer'] || ''} ${p['ro.product.model'] || '?'} (${p['ro.product.board'] || '?'}), Android serial ${p['ro.serialno'] || '-'}`);
  // Qualcomm's USB product name ends with the chip serial the boot ROM reports in EDL
  const sn = /_SN:([0-9a-f]{8})$/i.exec(adb.usbProduct || '');
  const android = { os_version: p['ro.build.version.release'] || null, patch: p['ro.build.version.security_patch'] || null,
                    fingerprint: p['ro.system.build.fingerprint'] || null };
  log(`  ${androidLabel(android)}, slot ${(p['ro.boot.slot_suffix'] || '?').replace(/^_/, '')}, verified boot ${p['ro.boot.verifiedbootstate'] || '?'}`);
  if (p['ro.boot.flash.locked'] === '1') {
    log('WARNING: the bootloader is locked. FreeABL needs it unlocked, and unlocking erases all data: back up your files first, then follow your vendor\'s unlock procedure.');
  }
  const av = androidValidated(dev, android);
  if (!av.listed) log(`note: no validated Android versions recorded for the ${dev.name}`);
  else if (!av.ok) log(`WARNING: FreeABL was not run on this Android version on the ${dev.name} yet: flashing will need tester mode`);
  else if (!av.exact) log('note: FreeABL was run on this Android version and patch, not on this exact build');
  else log('FreeABL was run on this exact Android build.');
  return { props: p, android, serial: adb.usbSerial || p['ro.serialno'] || null, chipSerial: sn ? sn[1].toLowerCase() : null };
}

export async function check(fb, table, log) {
  await fb.connect();
  const v = {};
  for (const k of ['serialno', 'product', 'variant', 'unlocked', 'secure', 'current-slot', 'battery-voltage', 'freeabl', 'chip-serial']) {
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
  // FreeABL 0.2 and later says so; the bootloader running is the one on the active slot
  if (v.freeabl === 'yes') log(`FreeABL is running: abl_${slot} holds FreeABL, not the stock bootloader`);
  return { serial: v.serialno, slot, product: v.product, variant: v.variant, freeabl: v.freeabl === 'yes',
           chipSerial: v['chip-serial'] || null, time: new Date().toISOString() };
}

/** The release's FreeABL image for the device's SoC, fetched with get(url) and checked against release.json. */
export async function releaseImage(release, dev, get, log) {
  const i = release?.images?.[dev.soc];
  if (!i) stop(`no FreeABL ${release?.tag || ''} image for ${dev.soc}: tick "Expert / tester mode" and choose an image`);
  log(`Fetching FreeABL ${release.tag} for ${dev.soc} (${i.name})`);
  const bytes = await get(`../images/${release.tag}/${i.name}`);
  const sha = await checkImage(dev, i.name, bytes, `${i.sha256}  ${i.name}\n`, log);
  return { bytes, sha };
}

/** The EDL loader against the one validated on the device: a fetched one must match. */
export async function checkLoader(dev, bytes, fetched, log) {
  if (!dev.loaderSha256) return;
  const h = await sha256hex(bytes);
  if (h === dev.loaderSha256) { log(`EDL loader recognised (sha256 ${h.slice(0, 16)}...)`); return; }
  if (fetched) stop('the fetched EDL loader does not have the expected sha256: not using it');
  log(`WARNING: this EDL loader is not the one validated on the ${dev.name} (sha256 ${h.slice(0, 16)}..., expected ${dev.loaderSha256.slice(0, 16)}...)`);
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

// file names: which Android build a backup or firmware file is from
const buildTag = (a) => {
  const os = a?.system_os_version || a?.os_version, patch = a?.system_patch || a?.patch;
  return patch ? `-android${os || ''}-${patch}` : '';
};

/**
 * Two devices look the same in EDL. The chip serial number, read by the boot ROM
 * on a fresh EDL connection (edl.chipSerial) and reported by FreeABL's fastboot
 * (state.chipSerial), ties a backup to its device.
 */
export function sameDevice({ bk = null, edl = null, state = null }) {
  const chips = [['the backup', bk?.info.chip_serial], ['the device in EDL', edl?.chipSerial], ['the device in fastboot', state?.chipSerial],
                 ['the device seen in Android', state?.androidChipSerial]]
    .filter(([, c]) => c);
  for (const [what, c] of chips.slice(1)) {
    if (c !== chips[0][1]) stop(`${what} is chip ${c}, ${chips[0][0]} chip ${chips[0][1]}: not the same device. Connect only the device you mean, and start again`);
  }
}

/**
 * Reads abl_a and abl_b twice. Returns the backup archive and its description.
 * freeablImages: FreeABL images to recognise (the one chosen for the install):
 * a slot that holds one is marked so, and never restored from this backup.
 */
export async function backup(edl, dev, state, msmId, log, { freeablImages = [] } = {}) {
  sameDevice({ edl, state });
  const info = { device: dev.id, soc: dev.soc, product: state.product || null, variant: state.variant || null,
                 serial: state.serial, slot: state.slot, msm_id: msmId === null ? null : `0x${msmId.toString(16)}`,
                 chip_serial: edl.chipSerial || state.chipSerial || null, hwid: edl.chipInfo?.hwid || null,
                 pk_hash: edl.chipInfo?.pkHash || null, time: new Date().toISOString(), partitions: {} };
  if (!info.chip_serial) log('note: chip serial not read (EDL loader already running): this backup is not tied to the chip');
  const files = [];
  for (const s of SLOTS) {
    const part = `abl_${s}`;
    const a = await edl.read(part);
    const b = await edl.read(part);
    if (!a.length) stop(`EDL read of ${part} gave no data`);
    if (!sameBytes(a, b)) stop(`${part}: two reads differ: check the cable and try again`);
    const v = mbnVersion(a);
    const h = await sha256hex(a);
    const freeabl = (s === state.slot && state.freeabl) || freeablImages.some((img) => img.length && startsWith(a, img));
    if (freeabl && s === state.slot) {
      stop(`${part}, the active slot, holds FreeABL: a backup now would keep FreeABL, not the stock bootloader. `
           + 'Keep the backup you made before installing FreeABL; to put a new FreeABL build on, use Update. '
           + 'After an Android update the device runs its new stock bootloader again and can be backed up.');
    }
    info.partitions[part] = freeabl ? { sha256: h, mbn: v, freeabl: true } : { sha256: h, mbn: v };
    files.push({ name: `${state.serial}/${part}.stock.img`, data: a });
    if (freeabl) log(`${part} holds FreeABL (left from before an Android update?): it is kept in the file but never restored`);
    log(`${part}: ${v === 'empty' ? 'EMPTY (all zeros)' : v ? `signature v${v}` : 'NOT A SIGNED ABL'}  sha256 ${h.slice(0, 16)}...`);
  }
  const act = info.partitions[`abl_${state.slot}`].mbn;
  if (act !== dev.mbn) stop(`the active abl_${state.slot} has signature format ${act}, FreeABL for the ${dev.name} is v${dev.mbn}: not flashing this device`);
  info.android = await androidBuild(edl, state.slot);
  log(`slot ${state.slot}: ${androidLabel(info.android)}${info.android?.fingerprint ? ` (${info.android.fingerprint})` : ''}`);
  const enc = new TextEncoder();
  files.push({ name: `${state.serial}/backup.json`, data: enc.encode(JSON.stringify(info, null, 1) + '\n') });
  files.push({ name: `${state.serial}/SHA256SUMS`, data: enc.encode(SLOTS.map((s) => `${info.partitions[`abl_${s}`].sha256}  abl_${s}.stock.img\n`).join('')) });
  const tar = makeTar(files);
  const report = dev.validated === 'current' ? null :
    `soc ${dev.soc}, MSM ID ${info.msm_id || 'not seen'}, HWID ${info.hwid || '-'}, PK hash ${info.pk_hash || '-'}, stock signature v${act}, `
    + `fastboot product ${state.product || '-'}, variant ${state.variant || '-'}, storage ${dev.memory}, ${androidLabel(info.android)}`;
  return { tar, tarName: `freeabl-backup-${state.serial}${buildTag(info.android)}.tar`, info, report };
}

/** Parses and checks a backup or firmware archive (bytes, Blob or File). state: from check(), or null (EDL restore without fastboot). */
export async function loadBackup(tar, dev, state) {
  const files = await tarIndex(tar instanceof Blob ? tar : new Blob([tar]));
  const jsonName = Object.keys(files).find((n) => n.endsWith('/backup.json'));
  if (!jsonName) stop('this is not a FreeABL backup (no backup.json)');
  const dir = jsonName.slice(0, -'backup.json'.length);
  const info = JSON.parse(new TextDecoder().decode(await files[jsonName]()));
  if (info.device !== dev.id || info.soc !== dev.soc) stop(`the backup was made for '${info.device}' (${info.soc}), not '${dev.id}' (${dev.soc})`);
  if (state && info.serial !== state.serial) {
    stop(`the backup is for device ${info.serial}, the connected device is ${state.serial}. A vendor update can change the serial `
         + '(seen on the AYANEO Pocket S): if this is the same device, make a new backup on the Android build it runs now');
  }
  if (state && info.slot !== state.slot) stop('the active slot changed since the backup (an Android update?): make a new backup');
  const parts = {};
  for (const s of SLOTS) {
    const p = `abl_${s}`;
    const f = files[`${dir}${p}.stock.img`] || files[`${dir}firmware/${p}.img`];
    if (!f) stop(`the backup has no ${p}`);
    const d = await f();
    if ((await sha256hex(d)) !== info.partitions[p].sha256) stop(`${p} in the backup is damaged (sha256 mismatch)`);
    parts[p] = d;
  }
  return { info, parts };
}

/** true: written and read back; false: read back differs; throws when the USB transfer itself fails. */
async function writeVerified(edl, part, bytes) {
  await edl.write(part, bytes);
  return startsWith(await edl.read(part), bytes);
}

// a write that stopped half way leaves the partition broken: say so plainly
const DONT_REBOOT = 'Do NOT reboot the device: it stays in EDL. Reconnect it (same cable, a USB port on the computer itself) '
                    + 'and use Back to stock over EDL with your backup.';
const failed = (e) => String(e?.message || e);

/** confirm(phrase, message) resolves to what the user typed. */
export async function flash({ via, edl, fb, dev, state, bk, image, imageSha, untested, confirm, log }) {
  const part = `abl_${state.slot}`;
  let warn = '';
  let phrase = `FLASH-${part.toUpperCase()}`;
  if (dev.validated === 'earlier') warn = `WARNING: the ${dev.name} was validated with an earlier FreeABL build only. This build was not run on it yet.`;
  if (dev.validated === 'none') warn = 'WARNING: FreeABL was never run on this device. If it does not boot, you need EDL without Android (button combination or test point) and your backup to recover.';
  // the Android build: read just now over EDL (in the backup), or from FreeABL's fastboot
  if (via === 'fastboot') await fb.connect();
  const android = (via === 'fastboot' && (await fastbootAndroid(fb))) || bk.info.android || null;
  const av = androidValidated(dev, android);
  let androidUntested = false;
  if (!av.listed) log(`note: no validated Android versions recorded for the ${dev.name}; this one is ${androidLabel(android)}`);
  else if (av.ok && !av.exact && android?.fingerprint) {
    log(`note: this exact build (${android.fingerprint}) was not run on yet; FreeABL was on one with the same Android version and patch`);
  } else if (!av.ok) {
    androidUntested = true;
    const was = av.list.map((x) => `Android ${x.os_version} ${month(x.patch)}`).join(', ');
    warn += `${warn ? '\n' : ''}WARNING: FreeABL was not run on ${androidLabel(android)} on the ${dev.name} (validated: ${was}). If Android does not start, FreeABL's menu and fastboot still do: use Back to stock over fastboot.`;
  }
  if (dev.validated !== 'current' || androidUntested) {
    if (!untested) {
      stop(dev.validated !== 'current' ? `the ${dev.name} is not validated with this build: tick "Tester mode (untested)"`
                                       : `FreeABL was not run on ${androidLabel(android)} on the ${dev.name} yet: tick "Tester mode (untested)" to try it`);
    }
    phrase = `FLASH-UNTESTED-${part.toUpperCase()}`;
  }
  sameDevice({ bk, edl: via === 'edl' ? edl : null, state });
  const typed = await confirm(phrase, `About to write the image (sha256 ${imageSha.slice(0, 16)}...) to ${part} of the ${dev.name} ${state.serial} via ${via}. Nothing else is written.${warn ? '\n' + warn : ''}`);
  if (typed !== phrase) stop('aborted');
  if (via === 'edl') {
    let ok, why = 'the copy read back differs';
    try {
      ok = await writeVerified(edl, part, image);
    } catch (e) {
      ok = false;
      why = `the write stopped: ${failed(e)}`;
    }
    if (ok) { log(`WRITE VERIFIED: ${part} holds FreeABL.`); return; }
    log(`${why}: putting the stock ${part} back`);
    let back = false;
    try {
      back = await writeVerified(edl, part, bk.parts[part]);
    } catch (e) {
      log(`stock write failed too: ${failed(e)}`);
    }
    if (back) stop(`${why}; stock ${part} restored and verified, FreeABL was not installed`);
    stop(`${why}, and the stock ${part} could not be put back. ${DONT_REBOOT}`);
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
  if (bk.info.partitions[part]?.freeabl) stop(`the backup's ${part} is FreeABL, not stock: use a backup made on this Android build before FreeABL was installed, or your vendor's firmware package`);
  if (['empty', null].includes(mbnVersion(stock))) stop(`the backup of ${part} is not a signed ABL: refusing to write it`);
  // a stock ABL from another Android build may not start this one
  if (via === 'fastboot') await fb.connect();
  const was = bk.info.android || null;
  const now = via === 'edl' ? await androidBuild(edl, state.slot) : await fastbootAndroid(fb);
  const same = sameBuild(was, now);
  let note = '';
  if (same === false) {
    stop(`this backup was made on ${androidLabel(was)}; the device now runs ${androidLabel(now)} (an Android update since?). `
         + 'Its bootloader may not start this Android. Use the backup or firmware file you made on this Android build (your latest one).');
  }
  if (same === null) {
    note = !was ? '\nNote: this backup does not record its Android build (made by an earlier flasher): not checked.'
                : '\nNote: this FreeABL cannot tell the Android build. If Android was updated since this backup, cancel and restore over EDL, which checks it.';
    log(note.trim());
  } else log(`backup and device on the same Android build (${androidLabel(now)})`);
  sameDevice({ bk, edl: via === 'edl' ? edl : null, state });
  const phrase = `RESTORE-${part.toUpperCase()}`;
  const typed = await confirm(phrase, `About to write the stock backup to ${part} of ${state.serial} via ${via}.${note}`);
  if (typed !== phrase) stop('aborted');
  if (via === 'edl') {
    let ok;
    try {
      ok = await writeVerified(edl, part, stock);
    } catch (e) {
      stop(`the write of ${part} stopped: ${failed(e)}. ${DONT_REBOOT}`);
    }
    if (!ok) stop(`readback of ${part} does not match the backup. ${DONT_REBOOT}`);
    log(`RESTORE VERIFIED: ${part} is stock again.`);
    return;
  }
  await fb.connect();
  if ((await fb.getVar('serialno')) !== state.serial) stop('the device in fastboot mode is not the one in the backup');
  await fb.flash(part, stock);
  log(`RESTORED ${part}.`);
}

// --- firmware dump ---------------------------------------------------------------
// Everything of the boot chain and the system images up to DUMP_MAX_BYTES each,
// both slots, read only, into one tar the user keeps: it is also a backup.
export const DUMP_MAX_BYTES = 128 << 20;
const DUMP_SKIP = new Set(['userdata', 'super']);

/** What dump() will read: { parts, skipped, android, name, bytes }. */
export async function dumpPlan(edl, state) {
  const all = await edl.partitions();
  const parts = all.filter((p) => !DUMP_SKIP.has(p.name) && p.bytes <= DUMP_MAX_BYTES);
  const skipped = all.filter((p) => !parts.includes(p)).map((p) => `${p.name} (${Math.round(p.bytes / (1 << 20))} MiB)`);
  for (const s of SLOTS) if (!parts.some((p) => p.name === `abl_${s}`)) stop(`EDL: partition abl_${s} not found`);
  const android = await androidBuild(edl, state.slot);
  const name = `freeabl-firmware-${state.serial}${buildTag(android)}.tar`;
  return { parts, skipped, android, name, bytes: parts.reduce((n, p) => n + p.bytes, 0) };
}

/** Reads the planned partitions into sink.write(bytes) as a tar; loadBackup() takes it like a backup. */
export async function dump(edl, dev, state, msmId, plan, sink, log, { freeablImages = [] } = {}) {
  sameDevice({ edl, state });
  const info = { device: dev.id, soc: dev.soc, product: state.product || null, variant: state.variant || null,
                 serial: state.serial, slot: state.slot, msm_id: msmId === null ? null : `0x${msmId.toString(16)}`,
                 chip_serial: edl.chipSerial || state.chipSerial || null,
                 time: new Date().toISOString(), android: plan.android, partitions: {}, firmware: {} };
  const sums = [];
  let done = 0;
  for (const p of plan.parts) {
    const d = await edl.read(p.name);
    const h = await sha256hex(d);
    const file = `${state.serial}/firmware/${p.name}.img`;
    await sink.write(tarHeader(file, d.length));
    await sink.write(d);
    await sink.write(tarPad(d.length));
    info.firmware[p.name] = { lun: p.lun, start: Number(p.start), sectors: p.sectors, sha256: h };
    if (/^abl_[ab]$/.test(p.name)) {
      const freeabl = (p.name === `abl_${state.slot}` && state.freeabl) || freeablImages.some((img) => img.length && startsWith(d, img));
      info.partitions[p.name] = freeabl ? { sha256: h, mbn: mbnVersion(d), freeabl: true } : { sha256: h, mbn: mbnVersion(d) };
    }
    sums.push(`${h}  firmware/${p.name}.img\n`);
    done += d.length;
    log(`  ${p.name.padEnd(20)} ${String(Math.round(d.length / 1024)).padStart(7)} KiB  ${Math.round((100 * done) / plan.bytes)}%`, true);
  }
  const enc = new TextEncoder();
  for (const [n, data] of [[`${state.serial}/backup.json`, enc.encode(JSON.stringify(info, null, 1) + '\n')],
                           [`${state.serial}/SHA256SUMS`, enc.encode(sums.join(''))]]) {
    await sink.write(tarHeader(n, data.length));
    await sink.write(data);
    await sink.write(tarPad(data.length));
  }
  await sink.write(TAR_END);
  return info;
}
