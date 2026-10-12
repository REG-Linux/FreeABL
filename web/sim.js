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

export class SimDevice {
  constructor({ stockA, stockB, vars = {}, msmId = 0x2520e1, critical = false, corrupt = false } = {}) {
    this.vars = { serialno: 'SIM12345', unlocked: 'yes', product: 'kalama', variant: 'SGP UFS',
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
    this.writes = [];
    this.edlLoaded = false;
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
      reboot: async () => {},
    };
  }

  get edl() {
    return {
      connect: async () => {
        const msmId = this.edlLoaded ? null : this.msmId;
        this.edlLoaded = true;
        return { msmId };
      },
      read: async (part) => this.parts[part].slice(),
      write: async (part, bytes) => this.write(part, bytes, this.corrupt),
      reset: async () => { this.edlLoaded = false; },
    };
  }
}
