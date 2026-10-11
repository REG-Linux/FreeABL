// SPDX-License-Identifier: GPL-3.0-or-later
// EDL driver for the web flasher on top of comma.ai's qdl.js (MIT), bundled into
// web/vendor/edl-qdl.mjs by web/build-vendor.sh.
//
// Differences from qdl.js's own qdlDevice, after bkerler/edl (GPL-3.0):
// - the Sahara hello is answered with the version the device announced (newer
//   SoCs speak Sahara 3);
// - the MSM ID is read in command mode (MSM_HW_ID_READ, or READ_CHIP_ID_V3 on
//   Sahara 3), and failing to read it or the serial is not fatal;
// - storage type and sector size follow the device (UFS 4096, eMMC 512);
// - only partition read and write by name, and reset, are exposed: no GPT
//   write, no erase, no slot change.
import { Sahara } from "qdl/sahara";
import { Firehose } from "qdl/firehose";
import { GPT } from "qdl/gpt";
import { usbClass } from "qdl/usblib";
import { cmd_t, sahara_mode_t } from "qdl/saharaDefs";
import { packGenerator, runWithTimeout } from "qdl/utils";
import { toXml } from "qdl/xml";

const EXEC_MSM_HW_ID_READ = 0x02;
const EXEC_READ_CHIP_ID_V3 = 0x0a;
const CHUNK_SECTORS_BYTES = 64 * 1024;

class FreeablSahara extends Sahara {
  async connect() {
    let resp = await runWithTimeout(this.cdc.read(0xc * 0x4), 500).catch(() => new Uint8Array());
    if (resp.length >= 12 && resp[0] === cmd_t.SAHARA_HELLO_REQ) {
      this.helloVersion = new DataView(resp.buffer, resp.byteOffset).getUint32(8, true);
      return "sahara";
    }
    if (resp.length > 1 && resp[0] === cmd_t.SAHARA_END_TRANSFER) return "sahara";
    if (resp.length > 1 && new TextDecoder().decode(resp).includes("<?xml")) return "firehose";
    if (resp.length <= 1) {
      try {
        await runWithTimeout(this.cdc.write(new TextEncoder().encode(toXml("nop"))), 1000);
        resp = await runWithTimeout(this.cdc.read(), 2000).catch(() => new Uint8Array());
      } catch {
        resp = new Uint8Array();
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
        if (r instanceof Uint8Array && r.length >= 8) return new DataView(r.buffer, r.byteOffset).getUint32(4, true);
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
      await this.connect();
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

  // qdl.js insists on "Storage type set to value UFS" in the loader's log
  async configure() {
    try {
      return await super.configure();
    } catch (e) {
      if (!/storage type not set/.test(String(e?.message || e)) || this.cfg.MemoryName === "UFS") throw e;
      this.luns = Array.from({ length: this.cfg.maxlun }, (_, i) => i);
      return true;
    }
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
    this.cdc = new usbClass();
    await this.cdc.connect();
    const sahara = new FreeablSahara(this.cdc, loader.buffer.slice(loader.byteOffset, loader.byteOffset + loader.byteLength));
    let mode = await sahara.connect();
    if (mode === "sahara") {
      this.log(`Sahara version ${sahara.helloVersion ?? "?"}: uploading the loader`);
      mode = await sahara.uploadLoader();
    }
    if (mode !== "firehose") throw new Error(`EDL: unexpected mode ${mode}: reboot the device to EDL and try again`);
    this.firehose = new FreeablFirehose(this.cdc, memory);
    if (!(await this.firehose.configure())) throw new Error("EDL: the loader did not accept the configuration");
    return { msmId: sahara.msmId ?? null };
  }

  async locate(name) {
    if (this.parts.has(name)) return this.parts.get(name);
    const ss = this.firehose.cfg.SECTOR_SIZE_IN_BYTES;
    for (const lun of this.firehose.luns) {
      try {
        const gpt = new GPT(ss);
        if (!gpt.parseHeader(await this.firehose.cmdReadBuffer(lun, 1n, 1), 1n)) continue;
        gpt.parsePartEntries(await this.firehose.cmdReadBuffer(lun, gpt.partEntriesStartLba, gpt.partEntriesSectors));
        const p = gpt.locatePartition(name);
        if (p) {
          const loc = { lun, start: BigInt(p.start), sectors: Number(p.sectors) };
          this.parts.set(name, loc);
          return loc;
        }
      } catch {
        // a LUN that does not answer: look at the next one
      }
    }
    throw new Error(`EDL: partition ${name} not found`);
  }

  async read(name) {
    const { lun, start, sectors } = await this.locate(name);
    const ss = this.firehose.cfg.SECTOR_SIZE_IN_BYTES;
    const per = Math.max(1, CHUNK_SECTORS_BYTES / ss);
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
