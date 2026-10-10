# FreeABL

A Qualcomm Android bootloader (ABL, the edk2 LinuxLoader) that boots Linux
from the SD card through an EFI loader such as GRUB, next to the device's
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

| SoC | Signing (qtestsign) | Devices tested |
|---|---|---|
| sdm845 | v5 | AYN Odin (Linux + Android on the device) |
| sm6115 | v6 | QEMU on Mangmi Air X factory images |
| sm8250 | v6 | QEMU on a Mangmi Pocket Max dump |
| sm8550 | v7 | QEMU on an AYANEO Pocket S build |
| sm8650 | v7 | build only |
| sm8750 | v7 | build only |

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

1. Back up the stock `abl_a` and `abl_b` partitions (EDL, with the firehose loader
   for your device) and keep the copies safe.
2. With the device unlocked and in fastboot mode, flash the image for its SoC to
   the active slot, for example:

   ```sh
   fastboot flash abl_a out/abl_signed-SDM845-ESP-r34.elf
   ```

3. To go back to stock, flash the backed-up `abl_a` the same way (or write it
   over EDL if the device no longer reaches fastboot).

## SD card

- A FAT16/FAT32 partition with `\EFI\BOOT\BOOTAA64.EFI`.
- The kernel, initrd and device tree come from the card, loaded by GRUB.

## Tests (no device needed)

`test/run-all.sh`:
1. host unit test of the boot routing logic (`BootDispatch.c`, every input combination);
2. QEMU (AAVMF): the ESP boot code up to GRUB, on cards formatted by mformat and mkfs.fat;
3. QEMU: the real LinuxLoader on UFS/SD disks laid out like the Odin's, through
   `QemuQcomShim` (the Qualcomm protocols the firmware would provide);
4. to 6. the same for sm8250, sm6115 and sm8550 on stock images from those devices,
   which are not in the repository: the scenarios are skipped when the images are absent
   (paths in each `test/qemu-ll/test-*.sh`).

Needs `qemu-system-aarch64`, `qemu-efi-aarch64` (AAVMF), `mtools`, `gdisk`,
`grub-efi-arm64-bin` / `grub-mkstandalone`.

## Licence

FreeABL's own code is GPL-3.0-or-later ([LICENSE](LICENSE)). Files from
CodeLinaro/Qualcomm and TianoCore EDK2 keep their original licences (BSD
variants), see `edk2/FREEABL.md`. `tools/qtestsign` is
[qtestsign](https://github.com/msm8916-mainline/qtestsign) (GPL-2.0-only),
used as a separate program.
