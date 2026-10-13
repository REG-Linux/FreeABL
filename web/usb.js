// SPDX-License-Identifier: GPL-3.0-or-later
// Real USB drivers for the web flasher (WebUSB): fastboot through fastboot.js,
// EDL through qdl.js (see vendor/LICENSES.md).
import * as fastboot from './vendor/fastboot.min.mjs';
import { QdlEdl } from './vendor/edl-qdl.mjs';
import { WebAdb } from './vendor/adb.mjs';

// the device is open in another program: say which ones usually do it
function inUse(e, edl) {
  // qdl.js puts the browser's error in the cause
  const m = [e, e?.cause].filter(Boolean).map((x) => x.message ?? x).join(': ');
  if (!/claimInterface|claim interface|LIBUSB_ERROR_BUSY/i.test(m)) return e;
  return new Error('Another program is using the device. Close it, unplug and replug the device, and try again: '
    + (edl ? 'on Linux the qcserial driver (sudo modprobe -r qcserial), ' : '')
    + `the adb server (adb kill-server), fastboot, QFIL, or another flasher tab. (${m})`);
}

export function fastbootDriver(log) {
  const dev = new fastboot.FastbootDevice();
  return {
    connect: async () => {
      if (!dev.isConnected) await dev.connect().catch((e) => { throw inUse(e, false); });
    },
    getVar: async (name) => {
      try {
        return await dev.getVariable(name);
      } catch {
        return null;
      }
    },
    flash: async (part, bytes) => {
      await dev.flashBlob(part, new Blob([bytes]), (p) => log?.(`  ${Math.round(p * 100)}%`, true));
    },
    reboot: async () => dev.reboot(''),
  };
}

export function adbDriver(log) {
  const adb = new WebAdb(log);
  const connect = adb.connect.bind(adb);
  adb.connect = () => connect().catch((e) => { throw inUse(e, false); });
  return adb;
}

export function edlDriver(log) {
  const edl = new QdlEdl(log);
  const connect = edl.connect.bind(edl);
  edl.connect = (loader, memory) => connect(loader, memory).catch((e) => { throw inUse(e, true); });
  return edl;
}

export const webUsbAvailable = () => 'usb' in navigator;
