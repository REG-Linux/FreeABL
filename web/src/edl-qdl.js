// SPDX-License-Identifier: GPL-3.0-or-later
// EDL driver for the web flasher on top of comma.ai's qdl.js (MIT), bundled into
// web/vendor/edl-qdl.mjs by web/build-vendor.sh.
//
// Differences from qdl.js's own qdlDevice, after bkerler/edl (GPL-3.0):
// - the Sahara hello is answered with the version the device announced (newer
//   SoCs speak Sahara 3);
// - the MSM ID is read in command mode (MSM_HW_ID_READ, or READ_CHIP_ID_V3 on
//   Sahara 3), and failing to read it or the serial is not fatal;
// - reconnecting to a loader that is still running (page reloaded) first
//   reads away what an earlier page left unread;
// - storage type and sector size follow the device (UFS 4096, eMMC 512);
// - configure accepts any ACK and, on a NAK that names the loader's own
//   payload size, retries with it (qdl.js wants specific log lines);
// - no reply is ever lost to a timeout (see PatientUsb), and a step waits for
//   30 s of silence before giving up, so a slow loader or a busy computer only
//   makes things slower;
// - only the partition list, partition read and write by name, and reset, are
//   exposed: no GPT write, no erase, no slot change.
import { Sahara } from "qdl/sahara";
import { Firehose } from "qdl/firehose";
import { GPT } from "qdl/gpt";
import { usbClass } from "qdl/usblib";
import { cmd_t, sahara_mode_t } from "qdl/saharaDefs";
import { packGenerator, runWithTimeout } from "qdl/utils";
import { toXml } from "qdl/xml";

const EXEC_MSM_HW_ID_READ = 0x02;
const EXEC_READ_CHIP_ID_V3 = 0x0a;
const CHUNK_BYTES = 1 << 20;   // per read command and per USB transfer
const SILENCE_S = 30;

// WebUSB cannot cancel a USB read: one that timed out still takes the next
// packet. qdl.js waits with such timeouts, so a reply that comes late is lost.
// Here a timed wait leaves the read running and keeps its packet for the next
// wait, and every timed wait of the EDL steps goes through next().
class PatientUsb extends usbClass {
  packets = [];
  transfer = null;
  error = null;

  /** The next packet (at most size bytes), or null after ms without one. */
  async next(ms, size = this.maxSize) {
    if (!this.packets.length && !this.error) {
      this.transfer ??= this.device.transferIn(this.epIn.endpointNumber, size)
        .then((r) => { this.packets.push(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength)); },
              (e) => { this.error = e; })
        .finally(() => { this.transfer = null; });
      let timer;
      await Promise.race([this.transfer, new Promise((r) => { timer = setTimeout(r, ms); })]);
      clearTimeout(timer);
    }
    if (this.packets.length) return this.packets.shift();
    if (this.error) throw this.error;
    return null;
  }

  // qdl.js's reads without a timeout (Sahara, raw data) come here too
  async read(length = 0) {
    if (length) return super.read(length);
    for (;;) {
      const p = await this.next(60_000);
      if (p) return p;
    }
  }

  /** length bytes, or an error after SILENCE_S without data. */
  async readExact(length) {
    const parts = [];
    let got = 0;
    while (got < length) {
      // asking for exactly what is left: the transfer cannot run into the reply after the data
      const p = await this.next(SILENCE_S * 1000, Math.min(length - got, CHUNK_BYTES));
      if (!p) throw new Error("EDL: the device stopped sending data");
      parts.push(p);
      got += p.length;
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

class FreeablSahara extends Sahara {
  async connect() {
    // the boot ROM sends its hello when the host opens the device: if it is
    // not there, ask with a nop (a loader already running answers it). A
    // late hello is not lost: the next read gets it.
    let resp = (await this.cdc.next(1000)) ?? new Uint8Array();
    if (resp.length >= 12 && resp[0] === cmd_t.SAHARA_HELLO_REQ) {
      this.helloVersion = new DataView(resp.buffer, resp.byteOffset).getUint32(8, true);
      return "sahara";
    }
    if (resp.length > 1 && resp[0] === cmd_t.SAHARA_END_TRANSFER) return "sahara";
    if (resp.length > 1 && new TextDecoder().decode(resp).includes("<?xml")) return "firehose";
    if (resp.length <= 1) {
      try {
        await runWithTimeout(this.cdc.write(new TextEncoder().encode(toXml("nop"))), 1000);
        resp = (await this.cdc.next(5000)) ?? new Uint8Array();
      } catch {
        resp = new Uint8Array();
      }
      if (resp.length >= 12 && resp[0] === cmd_t.SAHARA_HELLO_REQ) {
        this.helloVersion = new DataView(resp.buffer, resp.byteOffset).getUint32(8, true);
        return "sahara";
      }
      if (new TextDecoder().decode(resp).includes("<?xml")) return "firehose";
      if (resp[0] === cmd_t.SAHARA_END_TRANSFER) return "sahara";
    }
    return "error";
  }

  async cmdHello(mode, version = undefined, versionMin = 1, maxCmdLen = 0) {
    const v = version ?? Math.max(2, this.helloVersion || 2);
    await this.cdc.write(packGenerator([cmd_t.SAHARA_HELLO_RSP, 0x30, v, versionMin, maxCmdLen, mode, 1, 2, 3, 4, 5, 6]));
    return true;
  }

  async readMsmId() {
    try {
      if ((this.helloVersion || 2) >= 3) {
        const r = await this.cmdExec(EXEC_READ_CHIP_ID_V3);
        if (r instanceof Uint8Array && r.length >= 40) return new DataView(r.buffer, r.byteOffset).getUint32(36, true);
      } else {
        const r = await this.cmdExec(EXEC_MSM_HW_ID_READ);
        // the MSM ID is bits 32-55 of the 64-bit hardware ID
        if (r instanceof Uint8Array && r.length >= 8) return new DataView(r.buffer, r.byteOffset).getUint32(4, true) & 0xffffff;
      }
    } catch {
      // not fatal: the SoC is then not checked
    }
    return null;
  }

  async uploadLoader() {
    this.msmId = null;
    if (await this.enterCommandMode()) {
      this.msmId = await this.readMsmId();
      try { this.serial = await this.cmdGetSerialNum(); } catch { /* not needed */ }
      await this.cmdModeSwitch(sahara_mode_t.SAHARA_MODE_COMMAND);
      if ((await this.connect()) !== "sahara") throw new Error("EDL: the device did not restart Sahara after the chip ID read: reboot it to EDL and try again");
    }
    // loader upload, as in qdl.js's Sahara.uploadLoader (MIT, comma.ai)
    await this.cmdHello(sahara_mode_t.SAHARA_MODE_IMAGE_TX_PENDING);
    const prog = new Uint8Array(this.programmer);
    for (;;) {
      const resp = await this.getResponse();
      if (!resp || !("cmd" in resp)) throw new Error("EDL: no answer while uploading the loader. Wrong loader for this device?");
      const { cmd, data: pkt } = resp;
      if (cmd === cmd_t.SAHARA_64BIT_MEMORY_READ_DATA) {
        if (pkt.image_id < 0xc) throw new Error(`EDL: unexpected image id ${pkt.image_id}`);
        const chunk = new Uint8Array(pkt.data_len);
        if (pkt.data_offset < prog.length) chunk.set(prog.subarray(pkt.data_offset, Math.min(prog.length, pkt.data_offset + pkt.data_len)));
        await this.cdc.write(chunk);
      } else if (cmd === cmd_t.SAHARA_END_TRANSFER) {
        if (pkt.image_tx_status !== 0) throw new Error(`EDL: the device refused the loader (status ${pkt.image_tx_status}). Wrong loader for this device?`);
        if (!(await this.cmdDone())) throw new Error("EDL: loader upload not acknowledged");
        return "firehose";
      } else {
        throw new Error(`EDL: unexpected Sahara command ${cmd} during the loader upload`);
      }
    }
  }
}

class FreeablFirehose extends Firehose {
  constructor(cdc, memory) {
    super(cdc);
    this.cfg.MemoryName = memory === "emmc" ? "eMMC" : "UFS";
    this.cfg.SECTOR_SIZE_IN_BYTES = memory === "emmc" ? 512 : 4096;
    if (memory === "emmc") this.cfg.maxlun = 1;
  }

  // replaces qdl.js's, which gives up after 1 to 3 s without data
  async waitForData() {
    const dec = new TextDecoder();
    let text = "";
    while (!text.includes("<response")) {
      const p = await this.cdc.next(SILENCE_S * 1000);
      if (!p) break;
      text += dec.decode(p);
    }
    return new TextEncoder().encode(text);
  }

  // qdl.js's cmdReadBuffer, with patient waits
  async cmdReadBuffer(lun, startSector, sectors) {
    await this.cdc.write(new TextEncoder().encode(toXml("read", {
      SECTOR_SIZE_IN_BYTES: this.cfg.SECTOR_SIZE_IN_BYTES,
      num_partition_sectors: sectors,
      physical_partition_number: lun,
      start_sector: startSector,
    })));
    let rsp = this.xml.getResponse(await this.waitForData());
    if (rsp.value !== "ACK") throw new Error("Failed to read buffer: negative response code");
    if (rsp.rawmode !== "true") throw new Error("Failed to read buffer: wrong mode");
    const buffer = await this.cdc.readExact(this.cfg.SECTOR_SIZE_IN_BYTES * sectors);
    rsp = this.xml.getResponse(await this.waitForData());
    if (rsp.value !== "ACK") throw new Error("Failed to read buffer: negative response code");
    return buffer;
  }

  async configure() {
    const enc = new TextEncoder();
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.cdc.write(enc.encode(toXml("configure", {
        MemoryName: this.cfg.MemoryName,
        Verbose: 0,
        AlwaysValidate: 0,
        MaxDigestTableSizeInBytes: 2048,
        MaxPayloadSizeToTargetInBytes: this.cfg.MaxPayloadSizeToTargetInBytes,
        ZLPAwareHost: this.cfg.ZLPAwareHost,
        SkipStorageInit: this.cfg.SkipStorageInit,
        SkipWrite: this.cfg.SkipWrite,
      })), false);
      const data = await this.waitForData();
      const rsp = this.xml.getResponse(data);
      const logs = this.xml.getLog(data);
      if (rsp.value === "ACK") {
        const max = Number(rsp.MaxPayloadSizeToTargetInBytes);
        if (max > 0 && max < this.cfg.MaxPayloadSizeToTargetInBytes) this.cfg.MaxPayloadSizeToTargetInBytes = max;
        this.luns = Array.from({ length: this.cfg.maxlun }, (_, i) => i);
        return true;
      }
      if (!("value" in rsp)) throw new Error("EDL: no answer from the loader after the upload: reboot the device to EDL and try again");
      const max = Number(rsp.MaxPayloadSizeToTargetInBytesSupported || rsp.MaxPayloadSizeToTargetInBytes);
      if (max > 0 && max !== this.cfg.MaxPayloadSizeToTargetInBytes) {
        this.cfg.MaxPayloadSizeToTargetInBytes = max;
        continue;
      }
      const why = logs.filter((l) => /error|fail|not support/i.test(l)).slice(-2).join("; ");
      throw new Error(`EDL: the loader refused the configuration for ${this.cfg.MemoryName}${why ? ` (${why})` : ""}: check the storage type`);
    }
    throw new Error("EDL: the loader kept refusing the configuration");
  }
}

export class QdlEdl {
  constructor(log = () => {}) {
    this.log = log;
    this.cdc = null;
    this.firehose = null;
    this.parts = new Map();
  }

  async connect(loader, memory) {
    this.cdc = new PatientUsb();
    await this.cdc.connect();
    const sahara = new FreeablSahara(this.cdc, loader.buffer.slice(loader.byteOffset, loader.byteOffset + loader.byteLength));
    let mode = await sahara.connect();
    if (mode === "sahara") {
      this.log(`Sahara version ${sahara.helloVersion ?? "?"}: uploading the loader`);
      mode = await sahara.uploadLoader();
    }
    if (mode !== "firehose") throw new Error(`EDL: unexpected mode ${mode}: reboot the device to EDL and try again`);
    await this.resync();
    this.firehose = new FreeablFirehose(this.cdc, memory);
    if (!(await this.firehose.configure())) throw new Error("EDL: the loader did not accept the configuration");
    return { msmId: sahara.msmId ?? null };
  }

  // A loader left running by an earlier page may still have replies queued,
  // and they would be taken for the answers to our commands: read them away,
  // then wait for the answer to a nop before the first command.
  async resync() {
    const quiet = async () => {
      for (let n = 0; n < 1 << 17 && (await this.cdc.next(300)); n++);
    };
    await quiet();
    await this.cdc.write(new TextEncoder().encode(toXml("nop")));
    const dec = new TextDecoder();
    let text = "";
    while (!text.includes("<response")) {
      const p = await this.cdc.next(SILENCE_S * 1000);
      if (!p) throw new Error("EDL: the loader does not answer: reboot the device to EDL and try again");
      text += dec.decode(p);
    }
    await quiet();
  }

  /** Every partition of every LUN: [{ name, lun, start, sectors, bytes }]. The first of two with one name wins. */
  async partitions() {
    if (this.list) return this.list;
    const ss = this.firehose.cfg.SECTOR_SIZE_IN_BYTES;
    const list = [];
    for (const lun of this.firehose.luns) {
      let found;
      try {
        const gpt = new GPT(ss);
        if (!gpt.parseHeader(await this.firehose.cmdReadBuffer(lun, 1n, 1), 1n)) continue;
        gpt.parsePartEntries(await this.firehose.cmdReadBuffer(lun, gpt.partEntriesStartLba, gpt.partEntriesSectors));
        found = gpt.getPartitions();
      } catch {
        continue;   // a LUN that does not answer: look at the next one
      }
      for (const p of found) {
        if (this.parts.has(p.name)) continue;
        const loc = { name: p.name, lun, start: BigInt(p.start), sectors: Number(p.sectors), bytes: Number(p.sectors) * ss };
        this.parts.set(p.name, loc);
        list.push(loc);
      }
    }
    this.list = list;
    return list;
  }

  async locate(name) {
    if (!this.parts.has(name)) await this.partitions();
    if (!this.parts.has(name)) throw new Error(`EDL: partition ${name} not found`);
    return this.parts.get(name);
  }

  /** The partition, or its first max bytes (rounded up to a sector). */
  async read(name, max = Infinity) {
    const { lun, start } = await this.locate(name);
    const ss = this.firehose.cfg.SECTOR_SIZE_IN_BYTES;
    const sectors = Math.min(this.parts.get(name).sectors, Math.ceil(max / ss));
    const per = Math.max(1, CHUNK_BYTES / ss);
    const out = new Uint8Array(sectors * ss);
    for (let s = 0; s < sectors; s += per) {
      const n = Math.min(per, sectors - s);
      const buf = await this.firehose.cmdReadBuffer(lun, start + BigInt(s), n);
      out.set(buf.subarray(0, n * ss), s * ss);
    }
    return out;
  }

  async write(name, bytes) {
    const { lun, start, sectors } = await this.locate(name);
    const ss = this.firehose.cfg.SECTOR_SIZE_IN_BYTES;
    if (Math.ceil(bytes.length / ss) > sectors) throw new Error(`EDL: image larger than ${name}`);
    if (!(await this.firehose.cmdProgram(lun, start, new Blob([bytes])))) throw new Error(`EDL: write of ${name} failed`);
  }

  async reset() {
    await this.firehose.cmdReset();
  }
}
