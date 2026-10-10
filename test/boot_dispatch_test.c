/* Host unit test for QcomModulePkg/Library/BootLib/BootDispatch.c.
   Models LinuxLoader's routing flow across reboots and checks safety
   invariants for every input combination.
   Build: cc -DESP_HOST_TEST -I<edk2>/QcomModulePkg/Include/Library \
            boot_dispatch_test.c <edk2>/QcomModulePkg/Library/BootLib/BootDispatch.c */
#include <stdio.h>
#include <string.h>
#include "BootDispatch.h"

typedef struct {
  int FastbootKey, CardHasEfi, MenuLinux, BootMagic, DtboExists, DtboValid, SetVarFails;
} INPUT;

typedef enum { OUT_GRUB, OUT_ANDROID, OUT_FASTBOOT, OUT_REBOOT } OUTCOME;
static const char *Name[] = { "GRUB", "ANDROID", "FASTBOOT", "REBOOT" };

/* Persistent NV state across simulated reboots. */
static int OneShotVar;
static int AndroidPathEntered;   /* LoadImageAndAuth reached */
static int SdInitBeforeAndroid;  /* SD init ran in the same boot as Android */

/* One boot, mirroring LinuxLoaderEntry's dispatch block. */
static OUTCOME Boot (const INPUT *In)
{
  int SdInit = 0;
  if (In->FastbootKey) return OUT_FASTBOOT;            /* goto fastboot before one-shot */
  int OneShot = OneShotVar; OneShotVar = 0;            /* TakeOneShotAndroid: read+clear */
  int MenuLinux = OneShot ? 0 : In->MenuLinux;
  BOOLEAN Bootable = EspSlotBootable (In->BootMagic, In->DtboExists, In->DtboValid);

  if (EspFirstAction (FALSE, OneShot, MenuLinux) == ESP_ACT_LINUX) {
    SdInit = 1;
    if (In->CardHasEfi) return OUT_GRUB;               /* GRUB runs (if it returns: fastboot) */
    int Set = 0;
    if (Bootable && !In->SetVarFails) { OneShotVar = 1; Set = 1; }
    if (EspAfterLinuxAction (FALSE, Bootable, Set) == ESP_ACT_REBOOT_ANDROID) return OUT_REBOOT;
    return OUT_FASTBOOT;
  }
  if (EspAndroidAction (Bootable) != ESP_ACT_ANDROID) return OUT_FASTBOOT;
  AndroidPathEntered = 1;
  if (SdInit) SdInitBeforeAndroid = 1;
  return OUT_ANDROID;
}

static int Failures;
#define CHECK(c, ...) do { if (!(c)) { Failures++; printf ("FAIL: " __VA_ARGS__); printf ("\n"); } } while (0)

/* Run boots until a terminal outcome; returns it and the number of boots. */
static OUTCOME Run (const INPUT *In, int *Boots)
{
  OneShotVar = 0; AndroidPathEntered = 0; SdInitBeforeAndroid = 0;
  OUTCOME O = OUT_REBOOT;
  for (*Boots = 0; *Boots < 5 && O == OUT_REBOOT; (*Boots)++) O = Boot (In);
  return O;
}

static void Scenario (const char *Desc, INPUT In, OUTCOME Expect)
{
  int Boots; OUTCOME O = Run (&In, &Boots);
  printf ("%-58s -> %-8s (%d boot%s)%s\n", Desc, Name[O], Boots, Boots > 1 ? "s" : "",
          O == Expect ? "" : "   <-- UNEXPECTED");
  CHECK (O == Expect, "%s: expected %s got %s", Desc, Name[Expect], Name[O]);
}

int main (void)
{
  int n = 0;
  /* Exhaustive invariants over all 2^7 input combinations. */
  for (int m = 0; m < 128; m++, n++) {
    INPUT In = { m & 1, (m >> 1) & 1, (m >> 2) & 1, (m >> 3) & 1, (m >> 4) & 1, (m >> 5) & 1, (m >> 6) & 1 };
    int Bootable = In.BootMagic && (!In.DtboExists || In.DtboValid);
    int Boots; OUTCOME O = Run (&In, &Boots);
    CHECK (O != OUT_REBOOT, "combo %d: no terminal outcome after 5 boots (loop)", m);
    CHECK (Boots <= 2, "combo %d: needed %d boots", m, Boots);
    CHECK (!(AndroidPathEntered && !Bootable), "combo %d: Android path on non-bootable slot", m);
    CHECK (!SdInitBeforeAndroid, "combo %d: SD init ran before Android in same boot", m);
    CHECK ((O == OUT_GRUB) == (!In.FastbootKey && In.MenuLinux && In.CardHasEfi),
           "combo %d: GRUB outcome mismatch", m);
    if (In.FastbootKey) CHECK (O == OUT_FASTBOOT, "combo %d: fastboot key ignored", m);
    if (O == OUT_ANDROID) CHECK (Bootable, "combo %d: Android on non-bootable slot", m);
    CHECK (OneShotVar == 0 || O == OUT_FASTBOOT,
           "combo %d: one-shot flag left set after Android/GRUB", m);
  }
  printf ("exhaustive: %d combinations checked\n\n", n);

  /* Named AYN Odin scenarios (slot a = stock Android, slot b = Linux, dtbo_b erased). */
  Scenario ("slot b, SD with GRUB, menu Linux",           (INPUT){0,1,1, 1,1,0, 0}, OUT_GRUB);
  Scenario ("slot b, no SD, menu Linux",                  (INPUT){0,0,1, 1,1,0, 0}, OUT_FASTBOOT);
  Scenario ("slot b, menu Android (dtbo_b erased)",       (INPUT){0,1,0, 1,1,0, 0}, OUT_FASTBOOT);
  Scenario ("slot b, boot_b empty, menu Android",         (INPUT){0,0,0, 0,1,0, 0}, OUT_FASTBOOT);
  Scenario ("slot a stock, SD with GRUB, menu Linux",     (INPUT){0,1,1, 1,1,1, 0}, OUT_GRUB);
  Scenario ("slot a stock, no SD, menu Linux",            (INPUT){0,0,1, 1,1,1, 0}, OUT_ANDROID);
  Scenario ("slot a stock, menu Android",                 (INPUT){0,1,0, 1,1,1, 0}, OUT_ANDROID);
  Scenario ("slot a stock, no SD, NV write fails",        (INPUT){0,0,1, 1,1,1, 1}, OUT_FASTBOOT);
  Scenario ("any slot, vol-down held",                    (INPUT){1,1,1, 1,1,1, 0}, OUT_FASTBOOT);
  Scenario ("no dtbo partition, valid boot, menu Android",(INPUT){0,0,0, 1,0,0, 0}, OUT_ANDROID);

  printf ("\n%s (%d failure%s)\n", Failures ? "FAILED" : "ALL PASS", Failures, Failures == 1 ? "" : "s");
  return Failures != 0;
}
