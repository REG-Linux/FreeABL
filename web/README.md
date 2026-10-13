# Web flasher

A static page that backs up, installs and removes FreeABL over WebUSB, with the
same checks as `tools/freeabl-flash.py` (see [FLASHING.md](../FLASHING.md)).
Chrome, Edge or another Chromium browser on a computer.

**Status: run on an AYN Odin 2 Portal (SM8550), not yet in a browser.** The
page's steps and USB code (`core.js`, `usb.js`, fastboot.js, qdl.js,
`src/edl-qdl.js`) did a fastboot check, an EDL backup, a restore to stock and
an install, each read back and verified, then the device booted Android and
FreeABL's fastboot (2026-10-13). They ran in Node with the `usb` package as
`navigator.usb`, the same WebUSB API without the browser. Every step is also
tested against a simulated device, and the USB code against a fake phone that
speaks fastboot, Sahara 2/3 and Firehose byte by byte (`test/fakeusb.mjs`,
modelled on bkerler/edl logs and the Portal's loader). On other devices, run
`spike.html` (read-only) first.

| File | |
|---|---|
| `index.html`, `app.js`, `style.css` | the page |
| `core.js` | the checks and steps, independent of USB (shared rules with the CLI) |
| `usb.js` | WebUSB drivers: fastboot through fastboot.js, EDL through qdl.js, ADB through ya-webadb |
| `src/adb-web.js` | ADB driver on ya-webadb (`src/adb/package-lock.json`): properties and reboot to fastboot or EDL only |
| `src/edl-qdl.js` | EDL driver on qdl.js: Sahara 3 hello, MSM ID, UFS/eMMC, partition list, read and write only |
| `sim.js` | simulated device (`index.html?sim=1`, tests) |
| `test/fakeusb.mjs` | fake phone behind `navigator.usb` for the USB tests |
| `spike.html` | read-only probe: fastboot variables, EDL connection, `abl_a`/`abl_b` read |
| `vendor/` | bundles built by `build-vendor.sh` from pinned commits; licences in `vendor/LICENSES.md` |
| `../devices.json` | the device table (kept equal to the CLI's by `test/flash/test-flash.py`) |

## Run locally

Serve the repository root (the page loads `../devices.json`) and open `/web/`:

```sh
python3 -m http.server 8000      # then http://localhost:8000/web/  (or /web/?sim=1)
```

WebUSB needs `localhost` or HTTPS.

## Tests

```sh
node --test web/test/core.test.mjs                     # steps on the simulated device
node --test web/test/usb.test.mjs                      # real USB code vs a fake phone
npm i --no-save --prefix web puppeteer-core@25.9.0
node web/test/ui-smoke.mjs                              # the page in headless Chrome, ?sim=1
web/build-vendor.sh && git diff --exit-code web/vendor # bundles up to date (needs bun)
```

## Why these libraries

- **fastboot.js** (MIT): the fastboot implementation behind GrapheneOS's web installer.
- **qdl.js** (MIT): comma.ai's EDL implementation behind flash.comma.ai. Proven on
  SDM845 UFS devices; `src/edl-qdl.js` adds what our devices need, after bkerler/edl.

The page never calls qdl.js's GPT, erase or slot functions: `src/edl-qdl.js` only
exposes the partition list, partition read and write by name, and reset.

## Android builds and the firmware file

The backup records the Android build of the active slot (`core.js`,
`androidBuild()`: vbmeta properties, else the boot header; the sha256 of
`vbmeta_<slot>` tells two builds apart) and its file name carries it. Back to
stock refuses a backup from another build, and `devices.json` can list the
builds FreeABL was validated on per device (`android`). "Also save the whole
firmware" streams every partition up to 128 MiB of both slots, except
`userdata` and `super`, into one tar (`showSaveFilePicker` where the browser
has it); Back to stock and Update accept it like a backup.
