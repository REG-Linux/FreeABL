// SPDX-License-Identifier: GPL-3.0-or-later
// Simulated device for the tests and for the page's demo mode (?sim=1).
// Same behaviour as test/flash/fakedev.py.

const SIZE = 1 << 20;

/** Minimal ELF32 with a hash segment whose MBN header has the given version. */
export function signedElf(version, tag) {
  const d = new Uint8Array(0x1000);
  const v = new DataView(d.buffer);
  d.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  v.setUint16(16, 2, true); v.setUint16(18, 40, true); v.setUint32(20, 1, true);
  v.setUint32(0x1c, 52, true); v.setUint16(0x28, 52, true); v.setUint16(0x2a, 32, true); v.setUint16(0x2c, 1, true);
  v.setUint32(52 + 4, 0x100, true); v.setUint32(52 + 16, 0x40, true); v.setUint32(52 + 20, 0x40, true);
  v.setUint32(52 + 24, 2 << 24, true);
  v.setUint32(0x104, version, true);
  for (let i = 0x200; i < d.length; i++) d[i] = (tag.charCodeAt(i % tag.length) + i) & 0xff;
  return d;
}

/** An AVB vbmeta image (unsigned) holding property descriptors, padded to size. */
export function vbmetaImage(props, size = 64 * 1024) {
  const enc = new TextEncoder();
  const descs = Object.entries(props).map(([k, v]) => {
    const kb = enc.encode(k), vb = enc.encode(v);
    const n = Math.ceil((16 + kb.length + 1 + vb.length + 1) / 8) * 8;
    const d = new Uint8Array(16 + n), dv = new DataView(d.buffer);
    dv.setBigUint64(0, 0n); dv.setBigUint64(8, BigInt(n));
    dv.setBigUint64(16, BigInt(kb.length)); dv.setBigUint64(24, BigInt(vb.length));
    d.set(kb, 32); d.set(vb, 32 + kb.length + 1);
    return d;
  });
  const dsize = descs.reduce((n, d) => n + d.length, 0);
  const img = new Uint8Array(size), v = new DataView(img.buffer);
  img.set(enc.encode('AVB0'));
  v.setBigUint64(20, BigInt(dsize));              // auxiliary block: descriptors only
  v.setBigUint64(96, 0n); v.setBigUint64(104, BigInt(dsize));
  let o = 256;
  for (const d of descs) { img.set(d, o); o += d.length; }
  return img;
}

/**
 * Properties of an Android build as AOSP writes them into vbmeta and vbmeta_system.
 * gki: the boot side is init_boot (Pocket S); system: a newer system over the vendor's Android (Pocket Max).
 */
export function buildProps({ os = '13', patch = '2023-06-05', gki = false, system = null } = {}) {
  const boot = gki ? 'init_boot' : 'boot';
  const sys = system || { os, patch };
  return { vbmeta: { [`com.android.build.${boot}.os_version`]: os, [`com.android.build.${boot}.security_patch`]: patch,
                     'com.android.build.vendor.os_version': os, 'com.android.build.vendor.security_patch': patch },
           system: { 'com.android.build.system.os_version': sys.os, 'com.android.build.system.security_patch': sys.patch,
                     // the Pocket S build FreeABL was validated on, for the defaults
                     'com.android.build.system.fingerprint': sys.os === '13' && sys.patch === '2023-06-05'
                       ? 'qti/qssi/qssi:13/TKQ1.230811.002/2840:user/release-keys' : `AYN/kalama/kalama:${sys.os}/TKQ1.${sys.patch}/eng:user/release-keys` } };
}

/** A boot image v4 header page with os_version (A.B.C) and patch (YYYY-MM). */
export function bootHeader(os = '13', patch = '2023-06') {
  const h = new Uint8Array(4096), v = new DataView(h.buffer);
  h.set(new TextEncoder().encode('ANDROID!'));
  const [a = 0, b = 0, c = 0] = os.split('.').map(Number), [y, m] = patch.split('-').map(Number);
  v.setUint32(16, ((((a << 14) | (b << 7) | c) << 11) | ((y - 2000) << 4) | m) >>> 0, true);
  v.setUint32(40, 4, true);
  return h;
}

export class SimDevice {
  constructor({ stockA, stockB, vars = {}, msmId = 0x2520e1, critical = false, corrupt = false,
                android = { a: {}, b: {} }, chipSerial = '5e1a1234' } = {}) {
    this.chipSerial = chipSerial;
    this.vars = { serialno: 'SIM12345', unlocked: 'yes', secure: 'no', product: 'kalama', variant: 'SGP UFS',
                  'current-slot': 'a', 'battery-voltage': '4100', ...vars };
    this.msmId = msmId;
    this.critical = critical;
    this.corrupt = corrupt;
    this.parts = {};
    for (const [p, data] of [['abl_a', stockA], ['abl_b', stockB]]) {
      const b = new Uint8Array(SIZE);
      b.set(data);
      this.parts[p] = b;
    }
    for (const sl of ['a', 'b']) this.androidUpdate(sl, android[sl]);
    this.parts.xbl_a = new Uint8Array(8192).fill(0x5a);
    this.parts.xbl_b = new Uint8Array(8192).fill(0x5b);
    this.writes = [];
    this.edlLoaded = false;
  }

  /** What an Android update writes to a slot, as far as these checks see it; null: no vbmeta (older Android). */
  androidUpdate(slot, build) {
    if (build === null) { for (const p of ['vbmeta', 'vbmeta_system']) delete this.parts[`${p}_${slot}`]; return; }
    const pr = buildProps(build);
    this.parts[`vbmeta_${slot}`] = vbmetaImage(pr.vbmeta);
    this.parts[`vbmeta_system_${slot}`] = vbmetaImage(pr.system);
    this.parts[`boot_${slot}`] = bootHeader(build?.os, (build?.patch || '2023-06-05').slice(0, 7));
  }

  partitions() {
    const list = Object.entries(this.parts).map(([name, d], i) => ({ name, lun: 4, start: 16n + BigInt(i * 512), sectors: d.length / 4096, bytes: d.length }));
    return [...list, { name: 'userdata', lun: 0, start: 6n, sectors: 1 << 24, bytes: 2 ** 36 }];
  }

  write(part, bytes, corrupt) {
    this.writes.push(part);
    const b = this.parts[part];
    b.set(bytes);
    if (corrupt) b[100] ^= 0xff;
  }

  // a new driver each time, like usb.fastbootDriver(): unusable until connect()
  get fastboot() {
    let on = false;
    return {
      connect: async () => { on = true; },
      getVar: async (k) => (on && k in this.vars ? String(this.vars[k]) : null),
      flash: async (part, bytes) => {
        if (!on) throw new Error('not connected');
        if (this.critical) throw new Error("FAILED (remote: 'Flashing is not allowed for Critical Partitions')");
        this.write(part, bytes, false);
      },
      reboot: async () => { (this.reboots ||= []).push('android'); },
    };
  }

  // in Android with USB debugging: what the page reads, and the reboots it asks for
  get adb() {
    let on = false;
    return {
      connect: async () => { on = true; },
      props: async () => {
        if (!on) throw new Error('not connected');
        const a = this.androidProps || {};
        return { 'ro.serialno': 'ANDROID0001', 'ro.product.manufacturer': 'AYANEO', 'ro.product.model': 'Pocket S',
                 'ro.product.board': 'kalama', 'ro.build.version.release': '13', 'ro.build.version.security_patch': '2023-06-05',
                 'ro.system.build.fingerprint': 'qti/qssi/qssi:13/TKQ1.230811.002/2840:user/release-keys',
                 'ro.boot.slot_suffix': `_${this.vars['current-slot']}`, 'ro.boot.verifiedbootstate': 'orange',
                 'ro.boot.flash.locked': this.vars.unlocked === 'yes' ? '0' : '1', ...a };
      },
      reboot: async (mode) => { (this.reboots ||= []).push(mode); on = false; },
    };
  }

  // one EDL driver per device, like the page's session: it keeps what connect() read
  get edl() {
    if (this.edlDriver) return this.edlDriver;
    const drv = this.edlDriver = {
      chipSerial: null,
      connect: async () => {
        // like the boot ROM: chip ID and serial only before the loader runs
        const msmId = this.edlLoaded ? null : this.msmId;
        drv.chipSerial = this.edlLoaded ? null : this.chipSerial;
        this.edlLoaded = true;
        return { msmId, chipSerial: drv.chipSerial };
      },
      partitions: async () => this.partitions(),
      read: async (part, max = Infinity) => {
        if (!this.parts[part]) throw new Error(`EDL: partition ${part} not found`);
        return this.parts[part].slice(0, Math.min(this.parts[part].length, Math.ceil(max / 4096) * 4096));
      },
      write: async (part, bytes) => {
        if (this.failWrites > 0) {   // the USB transfer dies half way
          this.failWrites--;
          this.parts[part].set(bytes.subarray(0, bytes.length >> 1));
          throw new Error('NetworkError: A transfer error has occurred.');
        }
        this.write(part, bytes, this.corrupt);
      },
      reset: async () => { this.edlLoaded = false; },
    };
    return drv;
  }
}
