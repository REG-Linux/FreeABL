// SPDX-License-Identifier: GPL-3.0-or-later
// ADB driver for the web flasher on top of Tango's ya-webadb (MIT), bundled into
// web/vendor/adb.mjs by web/build-vendor.sh. For a device in Android with USB
// debugging on, it only reads properties and reboots to fastboot or EDL.
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";

// what the page shows and checks, read with getprop
export const PROPS = [
  "ro.serialno", "ro.product.manufacturer", "ro.product.model", "ro.product.board",
  "ro.build.version.release", "ro.build.version.security_patch", "ro.system.build.fingerprint",
  "ro.build.fingerprint", "ro.boot.slot_suffix", "ro.boot.verifiedbootstate", "ro.boot.flash.locked",
];

export class WebAdb {
  /** credentialStore: where the USB debugging key is kept (the browser's IndexedDB by default) */
  constructor(log = () => {}, credentialStore = null) {
    this.log = log;
    this.credentialStore = credentialStore;
    this.adb = null;
  }

  async connect() {
    const manager = new AdbDaemonWebUsbDeviceManager(navigator.usb);
    const device = await manager.requestDevice();
    if (!device) throw new Error("ADB: no device chosen");
    const connection = await device.connect();
    this.log("If the device asks to allow USB debugging from this computer, allow it.");
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore: this.credentialStore ?? new AdbWebCredentialStore("FreeABL"),
    });
    this.adb = new Adb(transport);
  }

  /** { property: value } for PROPS */
  async props() {
    const out = {};
    for (const p of PROPS) out[p] = (await this.adb.getProp(p)).trim();
    return out;
  }

  /** "bootloader" (fastboot) or "edl" */
  async reboot(mode) {
    if (!["bootloader", "edl"].includes(mode)) throw new Error(`ADB: no reboot to ${mode}`);
    await this.adb.power.reboot(mode).catch(() => {});   // the device goes away while answering
    await this.adb.close().catch(() => {});
    this.adb = null;
  }
}
