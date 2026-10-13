# Flashing FreeABL

FreeABL replaces your device's bootloader (ABL). Done right it is reversible;
done wrong the device may no longer reach Android or fastboot, and only EDL
(Qualcomm's emergency download mode) can bring it back. Read this page to the
end before you start, and read the [disclaimer](README.md#disclaimer).

`tools/freeabl-flash.py` does the steps below with checks at each one. It:

- writes one partition only: the ABL of the **active** slot (`abl_a` or `abl_b`);
- never writes the partition table, never changes the active slot, never touches
  the other slot;
- refuses to flash before it has saved and verified a backup of the stock ABL;
- refuses an image whose signature format differs from the stock ABL's, or whose
  checksum does not match;
- over EDL, reads the partition back after writing and puts the stock ABL back
  if the copy does not match.

## Supported devices

| `-d` | Device | SoC | Status | EDL loader |
|---|---|---|---|---|
| `odin` | AYN Odin | sdm845 | validated | picked by the edl tool |
| `odin2portal` | AYN Odin 2 Portal | sm8550 | validated | `xbl_s_devprg_ns.melf` (from the AYANEO Pocket S firmware package; works on this device) |
| `pockets` | AYANEO Pocket S | sm8550 | validated | `xbl_s_devprg_ns.melf` from the AYANEO Pocket S firmware package |
| `pocketmax` | Mangmi Pocket Max | sm8250 | earlier build only | `prog_firehose_ddr.elf` from the Mangmi firmware package |
| `airx` | Mangmi Air X (MQ66) | sm6115 | earlier build only | the firehose loader from the Mangmi firmware package |

"Earlier build only": FreeABL ran on this device, but not the current code yet.
Flashing it needs `--untested` (see below). The sm8650 and sm8750 images build
but were never run on a device.

`./tools/freeabl-flash.py devices` prints this list.

A web version of this tool, with the same checks, is in [`web/`](web/README.md).
It has not been run on a device yet: use the command-line tool for now.
Backups are interchangeable: extract the web flasher's `freeabl-backup-SERIAL.tar`
into `~/FreeABL-backups/`, or pack a tool backup for the web page with
`tar -cf freeabl-backup-SERIAL.tar -C ~/FreeABL-backups SERIAL`.

## What you need

- **An unlocked bootloader.** FreeABL images carry a test signature: a locked
  device will not run them. Unlocking erases all user data; follow your vendor's
  procedure (usually `fastboot flashing unlock` with the device in fastboot mode).
- **Secure boot off** (`fastboot getvar secure` says `no`). A test signature only
  runs when the maker has not turned secure boot on in the chip. Both flashers
  stop otherwise; nothing can change this from software.
- **Battery above 50%.** The bootloader does not charge.
- **A computer** (Linux, macOS or Windows) and a USB cable that carries data.
- **Python 3.8 or later.**
- **Android platform-tools** (`fastboot`, `adb`):
  <https://developer.android.com/tools/releases/platform-tools>.
- **The edl tool**, at the version we test with:
  `pip install git+https://github.com/bkerler/edl@9fab1fe3e7cd6f8dfa1e8e28e634aaeaf5b46b17`
  (a virtual environment, `python3 -m venv`, keeps it apart from system packages).
  - On Linux, install its udev rules or run it with `sudo`.
  - On macOS, install libusb first: `brew install libusb`.
  - On Windows, EDL needs the WinUSB driver: in EDL mode the device shows up as
    `QUSB__BULK` or `Qualcomm HS-USB QDLoader 9008`; install WinUSB on it with
    [Zadig](https://zadig.akeo.ie/).
- **The EDL loader for your device** (table above). The tool does not ship
  loaders: they are vendor files. Take them from your device's firmware package.
- **The FreeABL image for your SoC**, from the
  [release page](https://github.com/REG-Linux/FreeABL/releases), with its
  `.sha256` file (or `SHA256SUMS`) in the same folder.
- **The web flasher instead of the command line**, if you prefer:
  <https://reglinux.org/FreeABL/web/> in Chrome or Edge on a computer. Same
  steps and checks; it needs no Python, fastboot or edl tool.

## Know how to reach EDL before you flash

EDL is in the SoC's boot ROM: a bad ABL cannot remove it. But the easy way in,
`adb reboot edl`, needs Android to boot, which needs a working ABL. If FreeABL
does not boot, you need a way in that does not depend on it:

- **Mangmi devices:** with the device off, hold Volume Up and Volume Down and
  plug the USB cable in.
- **Other devices:** we have not verified a button combination. Find yours in
  your vendor's documentation or community before flashing. Some devices fall
  into EDL by themselves when the ABL fails to load; do not count on it.

## Steps

Run the tool from the folder that holds the image, or pass `-i IMAGE`. In a
release download the tool is `freeabl-flash.py`, next to the images. On Windows,
start it with `python freeabl-flash.py ...` (or `py freeabl-flash.py ...`)
instead of `./tools/freeabl-flash.py ...`.

1. **Check.** Boot the device to fastboot mode (`adb reboot bootloader`, or the
   device's key combination, often Volume Down + Power from off).

   ```sh
   ./tools/freeabl-flash.py check
   ```

   This reads `unlocked`, `secure`, the active slot and the battery, and stops if anything is
   wrong. The serial number and the active slot are saved for the next steps.

2. **Back up.** Boot the device to EDL. From fastboot: `fastboot reboot`, let
   Android start, then `adb reboot edl` (USB debugging on). The screen stays black
   in EDL.

   ```sh
   ./tools/freeabl-flash.py backup -d pockets --loader xbl_s_devprg_ns.melf
   ```

   Both `abl_a` and `abl_b` are read twice and compared. The tool also reads which
   Android build the device runs (version and security patch, from `vbmeta`) and
   saves the backup in a folder of that build:
   `~/FreeABL-backups/<serial>/android<version>-<patch>-<id>/` (change the top
   folder with `--backup-dir`). An `abl_b` that is all zeros is normal on some
   devices. **Copy that folder somewhere safe:** it is the way back to your stock
   bootloader on this Android build.

   Recommended, read only: save the whole firmware too, every partition of both
   slots up to 128 MiB (bootloaders, `boot`, `vbmeta`…; not your data, not `super`):

   ```sh
   ./tools/freeabl-flash.py dump -d pockets --loader xbl_s_devprg_ns.melf
   ```

   It goes to `firmware/` in the same folder: up to a few GB (1.5 GB on an
   Odin 2 Portal). It holds this device's own data: keep it private. The web
   page saves it only where the browser can write a file as it goes (Chrome or
   Edge on a computer).

3. **Flash.** Still in EDL:

   ```sh
   ./tools/freeabl-flash.py flash -d pockets --loader xbl_s_devprg_ns.melf
   ```

   The tool shows what it is about to write and asks you to type `FLASH-ABL_A`
   (or `FLASH-ABL_B`).

4. **Reboot.**

   ```sh
   ./tools/freeabl-flash.py reset -d pockets --loader xbl_s_devprg_ns.melf
   ```

   (or hold Power for 15 seconds). FreeABL shows its menu with the chipset, the
   memory and the storage type. Android starts as before; Linux starts from an SD
   card that holds `\EFI\BOOT\BOOTAA64.EFI`.

## Updating FreeABL

FreeABL's own fastboot can write the ABL, so a new release does not need EDL:

```sh
./tools/freeabl-flash.py check
./tools/freeabl-flash.py flash -d pockets --via fastboot -i abl_signed-SM8550-ESP-r34.elf
```

The backup from the first install is reused. fastboot cannot read the partition
back, so the copy is not verified; use EDL if you want that.

Stock bootloaders often refuse to write `abl` over fastboot ("Critical
Partitions"). `fastboot flashing unlock_critical` lifts that but erases user
data again. Use the EDL steps instead.

## Android updates

An Android update installs the other slot, with a new stock bootloader, and
switches to it. FreeABL stays on the old slot, unused: Android starts as stock.
To get FreeABL back, run the steps again (`check`, `backup`, `flash`). The new
backup goes to a new folder, for the new Android build; keep the older ones.
FreeABL left on the old slot is recognised and marked in the new backup, and
never restored.

- After an update Android may ask again to allow USB debugging: accept it on
  the device, or `adb reboot edl` does not work.
- If an update refuses to install, put the stock bootloader back first (below),
  update, then install FreeABL again.
- A backup is refused while FreeABL runs on the active slot: it would save
  FreeABL, not the stock bootloader. Keep the backup from before the first
  install; to change FreeABL builds, use the update steps above.

The flashers check the Android build:

- **Going back to stock** writes only a backup made on the Android build the
  device runs now. A stock bootloader from another build may not start it.
  Over EDL the tool reads the build from the device; over fastboot, FreeABL
  reports it (`fastboot getvar android-security-patch`; earlier FreeABL
  builds do not, and the tool then warns and uses your latest backup).
- **Flashing** on an Android build FreeABL was not run on yet needs
  `--untested` (tester mode on the web page), once builds are recorded for the
  device in `devices.json`. If Android then does not start, FreeABL's menu and
  fastboot still do: go back to stock over fastboot.
- **Secure boot:** both flashers stop if `fastboot getvar secure` is not `no`.
- **A write that stops half way** (cable, hub, computer asleep): the flashers
  put the stock bootloader back. If that fails too they say so: **do not
  reboot**. The device stays in EDL; reconnect it, ideally to a USB port of the
  computer itself, and go back to stock over EDL.

## Going back to stock

From FreeABL's fastboot, or over EDL if the device no longer reaches fastboot:

```sh
./tools/freeabl-flash.py restore -d pockets --via fastboot
./tools/freeabl-flash.py restore -d pockets --loader xbl_s_devprg_ns.melf    # EDL
```

If you need EDL because the device does not boot, `check` cannot run. The state
from the last `check` is still in the backup folder (`current-device.json`), so
`restore` works as long as the device and the active slot are the same. The tool
picks the backup folder of the Android build it reads from the device, and stops
if there is none: then use your vendor's firmware package.

## Devices not in the list (testers)

If you have a device we don't, you can help add it. `--untested` lets the tool
through where it would otherwise stop:

- `-d other --soc SOC` for a device that is not in the list (SoC: `sdm845`,
  `sm6115`, `sm8250`, `sm8550`, `sm8650` or `sm8750`);
- a listed device whose chip (MSM) ID differs from the one we recorded;
- a device validated with an earlier build only.

```sh
./tools/freeabl-flash.py check
./tools/freeabl-flash.py backup -d other --soc sm8650 --untested --loader LOADER [--memory ufs|emmc]
./tools/freeabl-flash.py flash  -d other --soc sm8650 --untested --loader LOADER
```

The confirmation then reads `FLASH-UNTESTED-ABL_A`. What `--untested` does
**not** skip: the unlocked, secure boot and battery checks, the verified backup of the stock
ABL, the checksum, and the signature format check. If your stock ABL is signed
in another format than the FreeABL image for that SoC, the device would not run
it, and the tool stops whatever the flags.

Before you flash an untested device, make sure you can reach EDL without Android
(button combination or test point): if FreeABL does not start, that is the only
way back.

`backup` prints a tester report (SoC, MSM ID, signature format, fastboot product
and variant, storage). Open an issue with it and whether Android, fastboot and
the SD card boot worked, and we'll add the device to the list.

## SD card

Some Qualcomm firmware rejects FAT32 volumes made by `mkfs.fat` (seen on the
Mangmi Pocket Max). If the card is not seen, format it with mtools:
`mformat -i /dev/sdX1 -F ::` (replace `/dev/sdX1` with the card's partition).

## Never

- `edl setactiveslot`: it rewrites partition attributes and has soft-bricked a
  device. The active slot is chosen by Android, not by this tool.
- Writing the partition table (`edl gpt`, `sgdisk` on the device's storage).
- Flashing an image for another SoC.
