# FreeABL

A free (GPL-3.0) Qualcomm Android bootloader (ABL, the edk2 LinuxLoader) that
boots Linux from the SD card through an EFI loader such as GRUB, next to the device's
unchanged Android.

```
power on → XBL → FreeABL ─┬─ Linux (SD card): \EFI\BOOT\BOOTAA64.EFI → GRUB → kernel
                          ├─ Android: stock boot/dtbo/vbmeta from UFS/eMMC
                          └─ Fastboot (USB)
```

- Boot menu at every power-on (Volume keys + Power, 4 s timeout). Linux is the
  default when a card with an EFI loader is present, otherwise Android.
- Never writes the GPT and never changes the A/B slot state.
- Reads the card's FAT partition directly when the firmware FAT driver refuses
  it (RawFat).
- Makes the memory handed to EFI apps executable on firmwares that map it
  execute-never (SDM845), so GRUB and the kernel EFI stub can run.
- USB debug commands: `fastboot oem esp-log` (RAM log of every DEBUG() and
  console message), `oem esp-blkio`, `oem esp-peek <blkio#> <lba>`,
  `oem esp-memmap`.

Based on CodeLinaro edk2 `uefi.lnx.5.0.r34-rel`, in the
[edk2-freeabl](https://github.com/REG-Linux/edk2-freeabl) submodule.

## Supported SoCs

| SoC | Signing (qtestsign) | Validated on device | Also tested in QEMU |
|---|---|---|---|
| sdm845 | v5 | AYN Odin | Odin UFS/SD layouts, stock Android |
| sm6115 | v6 | Mangmi Air X (MQ66) | MQ66 and MQ65 factory images |
| sm8250 | v6 | Mangmi Pocket Max | Pocket Max dump |
| sm8550 | v7 | AYANEO Pocket S (G3x Gen 2), AYN Odin 2 Portal (QCS8550) | AYANEO Pocket S build |
| sm8650 | v7 | - | build only |
| sm8750 | v7 | - | build only |

All four were validated with the current code.

The signature is a test signature: the device's bootloader must be unlocked
(no secure boot fused).

## Build

Host (Ubuntu 24.04): `clang-18 lld llvm-18 gcc-aarch64-linux-gnu build-essential
uuid-dev python3 python3-cryptography device-tree-compiler`.

```sh
git clone --recursive https://github.com/REG-Linux/FreeABL.git
cd FreeABL
./build.sh sdm845          # → out/abl_signed-SDM845-ESP-r34.elf
./build-all.sh             # every SoC, logs in logs/
ESP_DEBUG_SCREEN=TRUE ./build.sh sdm845   # debug build: DEBUG() on screen
```

`tools/mktoolbin.sh` (run by the build scripts) links the clang/lld tools into
`toolbin/`; set `CLANG_VER` / `LLD_VER` to use other versions.

## Reproducible builds

`build.sh` sets `SOURCE_DATE_EPOCH` to the edk2 commit time, so the same commit
built in the same directory with the same toolchain gives byte-identical
signed images (CI included: build in `/home/runner/work/FreeABL/FreeABL` to
match its artifacts). Source paths end up in the image, so builds made in other
directories differ. Compare two images with `sha256sum`.

## Flash

See [FLASHING.md](FLASHING.md). `tools/freeabl-flash.py` backs up the stock ABL
over EDL, flashes the active slot only and verifies the copy:

```sh
./tools/freeabl-flash.py check                                  # fastboot mode
./tools/freeabl-flash.py backup -d pockets --loader LOADER      # EDL mode
./tools/freeabl-flash.py flash  -d pockets --loader LOADER
./tools/freeabl-flash.py restore -d pockets --loader LOADER     # back to stock
```

A web flasher with the same checks runs at <https://reg-linux.github.io/FreeABL/web/> (Chrome or Edge; source in [`web/`](web/README.md)). It was run in Chrome on every listed device (AYN Odin, AYN Odin 2 Portal, AYANEO Pocket S, Mangmi Pocket Max, Mangmi Air X): install, update, firmware dump, back to stock over fastboot and EDL.

## SD card

- A FAT16/FAT32 partition with `\EFI\BOOT\BOOTAA64.EFI`.
- The kernel, initrd and device tree come from the card, loaded by GRUB.
- If the card is not seen, format it with mtools (`mformat`): some firmware rejects
  FAT32 volumes made by `mkfs.fat` (see [FLASHING.md](FLASHING.md#sd-card)).

## Tests (no device needed)

`test/run-all.sh`:
1. host unit test of the boot routing logic (`BootDispatch.c`, every input combination);
2. QEMU (AAVMF): the ESP boot code up to GRUB, on cards formatted by mformat and mkfs.fat;
3. QEMU: the real LinuxLoader on UFS/SD disks laid out like the Odin's, through
   `QemuQcomShim` (the Qualcomm protocols the firmware would provide);
4. to 6. the same for sm8250, sm6115 and sm8550 on stock images from those devices,
   which are not in the repository: the scenarios are skipped when the images are absent
   (paths in each `test/qemu-ll/test-*.sh`);
7. `tools/freeabl-flash.py` against a simulated device (`test/flash/`);
8. the web flasher's steps and page against a simulated device (`web/test/`, Node and headless Chrome).

Needs `qemu-system-aarch64`, `qemu-efi-aarch64` (AAVMF), `mtools`, `gdisk`,
`grub-efi-arm64-bin` / `grub-mkstandalone`.

## Disclaimer

**Flash at your own risk.** FreeABL replaces your device's bootloader (ABL).
A wrong or broken bootloader can leave a device unable to boot and recoverable
only through Qualcomm EDL mode, or not at all.

- Use it only on the devices listed under "Supported SoCs" as validated, with an
  unlocked bootloader. Other devices with the same SoC may not work.
- Back up the stock `abl_a` / `abl_b` first and make sure you can restore them
  (EDL loader for your device).
- FreeABL is provided "as is", without warranty of any kind, and its authors are not
  liable for any damage or data loss, as stated in sections 15 and 16 of the
  GNU GPL v3 (see [LICENSE](LICENSE)).

FreeABL is not affiliated with Qualcomm, CodeLinaro or any device maker.
Snapdragon and the device names are trademarks of their owners.

## AI-assisted development

FreeABL was developed with the help of AI coding tools. Every change was
reviewed, built and tested by the maintainer (unit tests, QEMU scenarios and the
devices listed above), and the maintainer is responsible for the code. FreeABL
is built on CodeLinaro's open-source edk2: the first commit of `edk2` is the
unmodified CodeLinaro release, and `edk2/FREEABL.md` and the commit history
show what FreeABL changed and added.

## Credits

- Base: CodeLinaro/Qualcomm edk2 LinuxLoader and TianoCore EDK2.
- Signing: [qtestsign](https://github.com/msm8916-mainline/qtestsign) by Stephan Gerhold.

## Licence

FreeABL's own code is GPL-3.0-or-later ([LICENSE](LICENSE)). Files from
CodeLinaro/Qualcomm and TianoCore EDK2 keep their original licences (BSD
variants, plus MIT, Zlib and Apache-2.0 for libavb, zlib and libufdt), see
`edk2/FREEABL.md`. The copyright notices and licence texts of everything linked
into the images are in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md); CI
ships it with every image, together with `LICENSE` and `SOURCE.txt` (the exact
source commits). `tools/qtestsign` is
[qtestsign](https://github.com/msm8916-mainline/qtestsign) (GPL-2.0-only),
used as a separate program.
