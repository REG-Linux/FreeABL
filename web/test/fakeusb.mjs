// SPDX-License-Identifier: GPL-3.0-or-later
// A phone behind a fake navigator.usb, for running the real USB code
// (vendor/fastboot.min.mjs, vendor/edl-qdl.mjs) in Node. It speaks the wire
// protocols byte by byte: fastboot, Sahara 2 or 3 and Firehose XML, over a
// partitioned storage with real GPTs, modelled on bkerler/edl's logs of the
// Pocket Max (SM8250) and Pocket S (SM8550).
//
// Like WebUSB, a pending transferIn() takes the next packet even after the
// caller stopped waiting for it. lag: { hello, configure, read, program } in
// ms delays those replies, for a slow loader or a busy computer.

import { vbmetaImage, buildProps, bootHeader } from '../sim.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = () => new Promise((r) => setTimeout(r, 0));

// --- GPT ---------------------------------------------------------------------
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ENTRIES = 32, ENTRY = 128;
function writeGpt(disk, ss, sectors, parts) {
  const entries = new Uint8Array(ENTRIES * ENTRY);
  parts.forEach((p, i) => {
    const e = new DataView(entries.buffer, i * ENTRY, ENTRY);
    for (let j = 0; j < 16; j++) { e.setUint8(j, 0x11 + j); e.setUint8(16 + j, (i * 16 + j) & 0xff); }
    e.setBigUint64(32, BigInt(p.start), true);
    e.setBigUint64(40, BigInt(p.start + p.sectors - 1), true);
    [...p.name].forEach((ch, j) => e.setUint16(56 + 2 * j, ch.charCodeAt(0), true));
  });
  const h = new Uint8Array(92), v = new DataView(h.buffer);
  h.set(enc.encode('EFI PART'));
  v.setUint32(8, 0x10000, true); v.setUint32(12, 92, true);
  v.setBigUint64(24, 1n, true); v.setBigUint64(32, BigInt(sectors - 1), true);
  v.setBigUint64(40, 6n, true); v.setBigUint64(48, BigInt(sectors - 6), true);
  v.setBigUint64(72, 2n, true); v.setUint32(80, ENTRIES, true); v.setUint32(84, ENTRY, true);
  v.setUint32(88, crc32(entries), true);
  v.setUint32(16, crc32(h), true);
  disk.set(h, ss);
  disk.set(entries, 2 * ss);
}

// --- USB device --------------------------------------------------------------
class FakeUsbDevice {
  constructor(phone, ids) {
    this.phone = phone;
    Object.assign(this, ids);
    this.opened = false;
    this.gone = false;
    this.inq = [];
    this.waiters = [];
    this.configurations = [{ interfaces: [{ claimed: false, alternates: [{
      interfaceClass: ids.classCode, interfaceSubclass: ids.subclassCode, interfaceProtocol: ids.protocolCode,
      endpoints: [{ endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 512 },
                  { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 512 }],
    }] }] }];
  }

  async open() { this.check(); this.opened = true; }
  async close() { this.opened = false; }
  async reset() { this.check(); }
  async forget() {}
  async selectConfiguration() { this.check(); }
  async claimInterface() {
    this.check();
    if (this.phone.busy) throw new Error("NetworkError: Failed to execute 'claimInterface' on 'USBDevice': Unable to claim interface.");
    this.configurations[0].interfaces[0].claimed = true;
    this.claimed();
  }
  claimed() {}
  check() { if (this.gone) throw new Error('NetworkError: device disconnected'); }

  send(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : enc.encode(bytes);
    const go = () => { this.inq.push(b); this.pump(); };
    if (this.lag) setTimeout(go, this.lag); else go();
  }

  pump() {
    while (this.inq.length && this.waiters.length) {
      const { len, resolve } = this.waiters.shift();
      let p = this.inq[0];
      if (p.length > len) { this.inq[0] = p.subarray(len); p = p.subarray(0, len); } else this.inq.shift();
      const copy = new Uint8Array(p);
      resolve({ status: 'ok', data: new DataView(copy.buffer) });
    }
    if (!this.inq.length) {
      this.printing = false;
      if (this.started) this.starting = false;
    }
  }

  transferIn(ep, len) {
    this.phone.transfersIn++;
    return new Promise((resolve, reject) => {
      if (this.gone) return reject(new Error('NetworkError: device disconnected'));
      this.waiters.push({ len, resolve, reject });
      this.pump();
    });
  }

  async transferOut(ep, data) {
    this.check();
    // a loader printing its log takes nothing until that is read (seen on the Portal)
    while ((this.starting || (this.printing && this.inq.length)) && !this.gone) {
      await new Promise((r) => setTimeout(r, 2));
    }
    this.check();
    const b = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    this.phone.log.push(b.length);
    await tick();
    await this.out(b);
    return { status: 'ok', bytesWritten: b.length };
  }

  unplug() {
    this.gone = true;
    for (const w of this.waiters.splice(0)) w.reject(new Error('NetworkError: device disconnected'));
  }
}

// --- fastboot ----------------------------------------------------------------
class FastbootUsb extends FakeUsbDevice {
  constructor(phone) {
    super(phone, { vendorId: 0x18d1, productId: 0xd00d, classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 });
    this.download = null;
  }

  async out(b) {
    const ph = this.phone;
    if (this.download) {
      this.download.parts.push(b);
      this.download.got += b.length;
      if (this.download.got >= this.download.size) {
        ph.downloaded = concat(this.download.parts).subarray(0, this.download.size);
        this.download = null;
        this.send('OKAY');
      }
      return;
    }
    const cmd = dec.decode(b);
    ph.fastbootCmds.push(cmd);
    let m;
    if ((m = /^getvar:(.*)$/.exec(cmd))) {
      const v = m[1] === 'max-download-size' ? '0x10000000' : ph.vars[m[1]];
      this.send(v === undefined ? 'FAILUnknown variable' : `OKAY${v}`);
    } else if ((m = /^download:([0-9a-fA-F]{8})$/.exec(cmd))) {
      this.download = { size: parseInt(m[1], 16), got: 0, parts: [] };
      this.send(`DATA${m[1]}`);
    } else if ((m = /^flash:(.+)$/.exec(cmd))) {
      if (ph.critical) return this.send('FAILFlashing is not allowed for Critical Partitions');
      if (!ph.part(m[1])) return this.send('FAILpartition not found');
      ph.writePart(m[1], ph.downloaded, 'fastboot');
      this.send('OKAY');
    } else if (cmd === 'reboot') {
      this.send('OKAY');
      setTimeout(() => ph.power('boot'), 5);
    } else {
      this.send('FAILunknown command');
    }
  }
}

// --- EDL: Sahara then Firehose ----------------------------------------------
const u32 = (...w) => { const b = new Uint8Array(4 * w.length), v = new DataView(b.buffer); w.forEach((x, i) => v.setUint32(4 * i, x, true)); return b; };

class EdlUsb extends FakeUsbDevice {
  constructor(phone) {
    super(phone, { vendorId: 0x05c6, productId: 0x9008, classCode: 0xff, subclassCode: 0xff, protocolCode: 0xff });
    this.want = null;
  }

  claimed() {
    if (this.phone.edl === 'pbl' && !this.helloSent) { this.helloSent = true; this.hello(); }
  }

  hello() {
    const ph = this.phone;
    this.lag = ph.lag.hello ?? 0;
    this.send(u32(0x01, 0x30, ph.sahara, 1, 0x400, 0, 0, 0, 0, 0, 0, 0));
  }

  async out(b) {
    this.lag = 0;
    if (this.phone.edl === 'firehose') return this.firehose(b);
    return this.pbl(b);
  }

  // Sahara, as the boot ROM speaks it
  pbl(b) {
    const ph = this.phone;
    if (this.want) {
      this.want.parts.push(b);
      this.want.got += b.length;
      if (this.want.got < this.want.len) return;
      const got = concat(this.want.parts);
      ph.loaderSeen.set(got.subarray(0, this.want.len), this.want.off);
      this.want = null;
      return this.nextChunk();
    }
    if (b.length < 8) return;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const cmd = v.getUint32(0, true);
    if (cmd === 0x02) {                                   // HELLO_RSP
      ph.helloVersions.push(v.getUint32(8, true));
      const mode = v.getUint32(20, true);
      if (mode === 3) {
        if (!ph.commandMode) return this.send(u32(0x04, 0x10, 0, 0x14));
        this.send(u32(0x0b, 0x08));
      } else if (mode === 0) {
        this.off = 0;
        ph.loaderSeen = new Uint8Array(ph.loader.length);
        this.nextChunk();
      }
    } else if (cmd === 0x0d) {                            // EXECUTE_REQ
      const what = v.getUint32(8, true);
      const data = this.exec(what);
      if (!data) return this.send(u32(0x04, 0x10, 0, 0x01));
      this.pendingExec = data;
      this.send(u32(0x0e, 0x10, what, data.length));
    } else if (cmd === 0x0f) {                            // EXECUTE_DATA
      this.send(this.pendingExec);
    } else if (cmd === 0x0c) {                            // SWITCH_MODE
      this.hello();
    } else if (cmd === 0x05) {                            // DONE_REQ
      this.send(u32(0x06, 0x0c, 0));
      ph.edl = 'firehose';
      ph.loads += 1;
      // the SM8550 loader (Odin 2 Portal, 2026-10-13) prints its start-up log about 0.5 s
      // later, and takes nothing from the host until that log is read
      if (ph.startupLog) {
        this.starting = true;
        setTimeout(() => { if (!this.gone) { this.loaderLog(); this.started = true; } }, ph.startupLog);
      }
    }
  }

  exec(what) {
    const ph = this.phone;
    if (what === 0x01) return u32(ph.serial);
    if (what === 0x03) {   // OEM PK hash: the boot ROM repeats it to fill its buffer
      const h = Uint8Array.from(ph.pkHash.match(/../g), (x) => parseInt(x, 16));
      const r = new Uint8Array(h.length * 2); r.set(h); r.set(h, h.length);
      return r;
    }
    if (what === 0x02 && ph.sahara < 3 && !ph.chipIdFails) return u32(0x0000_0000, ph.msmId | (ph.hwidTop << 24));
    if (what === 0x0a && ph.sahara >= 3 && !ph.chipIdFails) {
      const r = new Uint8Array(48), d = new DataView(r.buffer);
      d.setUint32(0, 0x601, true); d.setUint32(36, ph.msmId, true); d.setUint16(40, 0x0051, true);
      return r;
    }
    return null;
  }

  nextChunk() {
    const ph = this.phone;
    const len = ph.loader.length;
    if (this.off >= len) {
      const ok = ph.loaderSeen.every((x, i) => x === ph.loader[i]);
      return this.send(u32(0x04, 0x10, 0x0d, ok ? 0 : 0x1c));
    }
    const n = this.off === 0 ? 52 : Math.min(0x1000, len - this.off);
    this.want = { off: this.off, len: n, got: 0, parts: [] };
    this.off += n;
    const p = new Uint8Array(0x20), d = new DataView(p.buffer);
    d.setUint32(0, 0x12, true); d.setUint32(4, 0x20, true);
    d.setBigUint64(8, 0x0dn, true); d.setBigUint64(16, BigInt(this.want.off), true); d.setBigUint64(24, BigInt(n), true);
    this.send(p);
  }

  // Firehose
  rsp(value, attrs = '') { this.send(`<?xml version="1.0" encoding="UTF-8" ?><data><response value="${value}"${attrs} /></data>`); }
  logline(text) { this.send(`<?xml version="1.0" encoding="UTF-8" ?><data><log value="${text}" /></data>`); }
  loaderLog() {
    this.printing = true;
    for (const l of ['Binary build date: Apr 26 2024 @ 07:33:11\n', 'Chip serial num (0x0) Chip ID (0x0)', 'Supported Functions (15):',
                     'program', 'read', 'nop', 'patch', 'configure', 'setbootablestoragedrive', 'erase', 'power', 'firmwarewrite',
                     'getstorageinfo', 'benchmark', 'emmc', 'ufs', 'fixgpt', 'getsha256digest', 'End of supported functions 15']) this.logline(`INFO: ${l}`);
  }

  firehose(b) {
    const ph = this.phone;
    if (this.programTo) {
      if (b.length === 0) return;
      const p = this.programTo;
      p.parts.push(b);
      p.got += b.length;
      if (p.got < p.len) return;
      this.programTo = null;
      this.lag = ph.lag.program ?? 0;
      const data = concat(p.parts).subarray(0, p.len);
      ph.writes.push({ lun: p.lun, start: p.start, sectors: p.len / ph.sectorSize, via: 'edl' });
      ph.luns[p.lun].set(ph.corrupt ? flip(data) : data, p.start * ph.sectorSize);
      return this.rsp('ACK', ' rawmode="false"');
    }
    if (b.length === 0) return;
    const text = dec.decode(b);
    const m = /<(\w+)\s*([^>]*?)\/>/.exec(text.replace(/<\?xml[^>]*\?>/, '').replace(/<\/?data>/g, ''));
    if (!m) return this.rsp('NAK');
    const [, tag, rest] = m;
    const a = {};
    for (const [, k, val] of rest.matchAll(/(\w+)="([^"]*)"/g)) a[k] = val;
    ph.firehoseCmds.push(tag);
    this.lag = ph.lag[tag] ?? 0;
    const ss = ph.sectorSize;
    if (tag === 'nop') {
      // as the SM8550 loader does (Odin 2 Portal, 2026-10-13): a log line per packet, then the ACK
      this.logline('INFO: Calling handler for nop');
      this.loaderLog();
      return this.rsp('ACK', ' rawmode="false"');
    }
    if (tag === 'configure') {
      if (ph.configureLogs) {
        this.logline('INFO: Binary build date: Jan 27 2026 @ 23:17:47');
        this.logline('INFO: Calling handler for configure');
      }
      const mem = ph.memory === 'emmc' ? 'eMMC' : 'UFS';
      const want = Number(a.MaxPayloadSizeToTargetInBytes);
      const info = ` MemoryName="${mem}" MaxPayloadSizeFromTargetInBytes="4096" MaxPayloadSizeToTargetInBytes="${ph.maxPayload}" MaxPayloadSizeToTargetInBytesSupported="${ph.maxPayload}" MaxXMLSizeInBytes="4096" Version="1"`;
      if (a.MemoryName !== mem) {
        this.logline(`ERROR: Failed to open the device:${a.MemoryName} slot:0 partition:0 error:0`);
        return this.rsp('NAK', info);
      }
      if (want > ph.maxPayload) return this.rsp('NAK', info);
      if (ph.configureLogs) this.logline(`INFO: Storage type set to value ${mem}`);
      ph.configured = { payload: want };
      return this.rsp('ACK', info);
    }
    if (!ph.configured) return this.rsp('NAK');
    if (tag === 'read' || tag === 'program') {
      const lun = Number(a.physical_partition_number), start = Number(a.start_sector), n = Number(a.num_partition_sectors);
      const disk = ph.luns[lun];
      if (Number(a.SECTOR_SIZE_IN_BYTES) !== ss || !disk || (start + n) * ss > disk.length) {
        this.logline(`ERROR: Failed to open LUN ${lun} or range ${start}+${n}`);
        return this.rsp('NAK');
      }
      if (tag === 'read') {
        ph.reads.push({ lun, start, n });
        this.rsp('ACK', ' rawmode="true"');
        this.send(disk.slice(start * ss, (start + n) * ss));
        return this.rsp('ACK', ' rawmode="false"');
      }
      this.programTo = { lun, start, len: n * ss, got: 0, parts: [] };
      return this.rsp('ACK', ' rawmode="true"');
    }
    if (tag === 'power') {
      this.rsp('ACK');
      setTimeout(() => ph.power(a.value === 'reset' ? 'boot' : 'off'), 5);
      return;
    }
    ph.forbidden.push(tag);
    return this.rsp('NAK');
  }
}

const flip = (d) => { const c = d.slice(); c[100] ^= 0xff; return c; };
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// --- phone -------------------------------------------------------------------
export class FakePhone {
  constructor({ sahara = 3, msmId = 0x1f20e1, hwidTop = 0, serial = 0x1056a040, chipIdFails = false, commandMode = true,
                memory = 'ufs', loader = new Uint8Array(9000).map((_, i) => (i * 7) & 0xff), maxPayload = 1048576,
                configureLogs = true, critical = false, corrupt = false, lag = {}, busy = false, android = { a: {}, b: {} },
                startupLog = 500, pkHash = '9823c68bf148113f5be92310de6cbc2e84e2aef962eeded50dc51717feebfae3', vars = {}, stockA, stockB } = {}) {
    Object.assign(this, { sahara, msmId, hwidTop, serial, chipIdFails, commandMode, memory, loader, maxPayload,
                          configureLogs, critical, corrupt, lag, busy, startupLog, pkHash });
    this.vars = { serialno: 'FAKE1234', unlocked: 'yes', secure: 'no', product: 'kalama', variant: 'SGP UFS', 'current-slot': 'a',
                  'battery-voltage': '4100', 'has-slot:abl': 'yes', ...vars };
    this.sectorSize = memory === 'emmc' ? 512 : 4096;
    const ss = this.sectorSize, abl = (1 << 20) / ss;
    this.luns = [];
    this.layout = {};
    const lun = (n, sectors, parts) => {
      const d = new Uint8Array(sectors * ss);
      writeGpt(d, ss, sectors, parts);
      this.luns[n] = d;
      for (const p of parts) this.layout[p.name] = { lun: n, ...p };
    };
    if (memory === 'emmc') {
      lun(0, 64 + 2 * abl + 128, [{ name: 'sbl1', start: 34, sectors: 16 }, { name: 'abl_a', start: 64, sectors: abl },
                                  { name: 'abl_b', start: 64 + abl, sectors: abl }, { name: 'userdata', start: 64 + 2 * abl, sectors: 64 }]);
    } else {
      lun(0, 64, [{ name: 'userdata', start: 6, sectors: 50 }]);
      lun(1, 32, [{ name: 'xbl_a', start: 6, sectors: 16 }]);
      lun(2, 32, [{ name: 'xbl_b', start: 6, sectors: 16 }]);
      this.luns[3] = new Uint8Array(32 * ss);                   // no GPT
      const vb = (64 * 1024) / ss, at = 16 + 2 * abl;
      lun(4, at + 4 * vb + 2 + 16, [{ name: 'xbl_config_a', start: 6, sectors: 8 }, { name: 'abl_a', start: 16, sectors: abl },
                                    { name: 'abl_b', start: 16 + abl, sectors: abl },
                                    { name: 'vbmeta_a', start: at, sectors: vb }, { name: 'vbmeta_b', start: at + vb, sectors: vb },
                                    { name: 'vbmeta_system_a', start: at + 2 * vb, sectors: vb }, { name: 'vbmeta_system_b', start: at + 3 * vb, sectors: vb },
                                    { name: 'boot_a', start: at + 4 * vb, sectors: 1 }, { name: 'boot_b', start: at + 4 * vb + 1, sectors: 1 }]);
      for (const sl of ['a', 'b']) {
        const pr = buildProps(android[sl]);
        this.part(`vbmeta_${sl}`).set(vbmetaImage(pr.vbmeta));
        this.part(`vbmeta_system_${sl}`).set(vbmetaImage(pr.system));
        this.part(`boot_${sl}`).set(bootHeader('13', '2023-06'));
      }
      // LUN 5 absent: reads are refused
    }
    if (stockA) this.part('abl_a').set(stockA);
    if (stockB) this.part('abl_b').set(stockB);
    this.writes = [];
    this.reads = [];
    this.forbidden = [];
    this.fastbootCmds = [];
    this.firehoseCmds = [];
    this.helloVersions = [];
    this.log = [];
    this.loads = 0;
    this.transfersIn = 0;
    this.state = 'fastboot';
    this.edl = 'pbl';
    this.dev = null;
    this.usb = {
      getDevices: async () => [],
      requestDevice: async ({ filters }) => {
        const d = this.dev;
        const hit = d && !d.gone && filters.some((f) => Object.entries(f).every(([k, v]) => d[k] === v));
        if (!hit) throw new Error('NotFoundError: No device selected.');
        return d;
      },
      addEventListener() {},
    };
    this.plug('fastboot');
  }

  /** Put the phone in a mode and on the bus: 'fastboot', 'edl' or 'boot' (off the bus). */
  plug(mode) {
    this.dev?.unplug();
    this.state = mode;
    if (mode === 'fastboot') this.dev = new FastbootUsb(this);
    else if (mode === 'edl') this.dev = new EdlUsb(this);
    else this.dev = null;
    return this;
  }

  power(to) {
    this.edl = 'pbl';
    this.configured = null;
    this.plug(to);
    this.booted = (this.booted || 0) + 1;
  }

  part(name) {
    const p = this.layout[name];
    if (!p) return null;
    return this.luns[p.lun].subarray(p.start * this.sectorSize, (p.start + p.sectors) * this.sectorSize);
  }

  writePart(name, data, via) {
    const p = this.layout[name];
    this.writes.push({ lun: p.lun, start: p.start, sectors: Math.ceil(data.length / this.sectorSize), via, name });
    this.part(name).set(data);
  }

  /** Name of the partition a write landed in, or a description of where it went. */
  where(w) {
    for (const [name, p] of Object.entries(this.layout)) {
      if (p.lun === w.lun && w.start >= p.start && w.start + w.sectors <= p.start + p.sectors) return name;
    }
    return `LUN ${w.lun} sector ${w.start}`;
  }
}
