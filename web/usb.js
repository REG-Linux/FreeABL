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
  if (/state is in progress|transfer error|device (was )?disconnected|NetworkError: Device unavailable/i.test(m)) {
    return new Error(`the device is restarting or busy: wait until it is fully up (or in EDL), then try again (${m})`);
  }
  if (edl && /No device selected/i.test(m)) {
    return new Error('no device in EDL was chosen. Is it in EDL (black screen, shown as QUSB__BULK or 9008)? Put it in EDL first, then try again');
  }
  if (!/claimInterface|claim interface|LIBUSB_ERROR_BUSY/i.test(m)) return e;
  return new Error('Another program is using the device. Close it, unplug and replug the device, and try again: '
    + (edl ? 'on Linux the qcserial driver (sudo modprobe -r qcserial), ' : '')
    + `the adb server (adb kill-server), fastboot, QFIL, or another flasher tab. (${m})`);
}

export function fastbootDriver(log) {
  const dev = new fastboot.FastbootDevice();
  // fastboot.js grabs ANY device that appears on the bus, to reconnect after a reboot it waits
  // for: it took the device coming back in Android away from ADB. The page never waits for that.
  dev._registeredUsbListeners = true;
  return {
    connect: async () => {
      if (!dev.isConnected) {
        await dev.connect().catch(async (e) => {
          // a half-open device would fail every later transfer: close it for the next try
          await dev.device?.close().catch(() => {});
          throw inUse(e, false);
        });
      }
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
  edl.connect = (loader, memory) => connect(loader, memory).catch(async (e) => {
    await edl.cdc?.device?.close().catch(() => {});
    throw inUse(e, true);
  });
  return edl;
}

export const webUsbAvailable = () => typeof navigator !== 'undefined' && 'usb' in navigator;

// Two devices look alike in the browser's device list. Once the device's serial is
// known, every picker lists only that device (fastboot.js and ya-webadb ask with
// their own filters: the serial is added to each).
let wanted = null;
if (typeof navigator !== 'undefined' && 'usb' in navigator) {
  const request = navigator.usb.requestDevice.bind(navigator.usb);
  navigator.usb.requestDevice = (opts = {}) => {
    // not in EDL (05c6:9008): the boot ROM shows no serial; the chip serial is checked instead
    const edlPick = opts.filters?.some((f) => f.vendorId === 0x05c6);
    const filters = wanted && opts.filters && !edlPick ? opts.filters.map((f) => ({ ...f, serialNumber: wanted })) : opts.filters;
    return request({ ...opts, filters }).catch((e) => {
      if (filters !== opts.filters && /No device selected/i.test(String(e?.message || e))) {
        const was = wanted;
        wanted = null;
        throw new Error(`no device with serial ${was} in this mode: if it shows another serial here, click again to choose from all devices`);
      }
      throw e;
    });
  };
}
/** List only the device with this USB serial in the pickers (null: all). */
export function pinSerial(serial) { wanted = serial || null; }
