// SPDX-License-Identifier: GPL-3.0-or-later
// Real USB drivers for the web flasher (WebUSB): fastboot through fastboot.js,
// EDL through qdl.js (see vendor/LICENSES.md).
import * as fastboot from './vendor/fastboot.min.mjs';
import { QdlEdl } from './vendor/edl-qdl.mjs';

export function fastbootDriver(log) {
  const dev = new fastboot.FastbootDevice();
  return {
    connect: async () => {
      if (!dev.isConnected) await dev.connect();
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

export function edlDriver(log) {
  return new QdlEdl(log);
}

export const webUsbAvailable = () => 'usb' in navigator;
