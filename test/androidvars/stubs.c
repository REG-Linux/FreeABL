/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Host stand-ins for the UEFI services AndroidBuildVars.c uses: partitions are files DIR/<name>.img. */
#include <stdio.h>
#include <stdarg.h>
#include <sys/stat.h>
#include "host.h"
#include "libavb/libavb.h"
#include "AndroidBuildVars.h"

static const char *Dir;

UINTN AsciiSPrint (CHAR8 *Buf, UINTN Size, CONST CHAR8 *Fmt, ...) {
  char f[128]; size_t j = 0;
  for (size_t i = 0; Fmt[i] && j < sizeof (f) - 2; i++) {   /* %a is %s in EDK2 */
    f[j++] = Fmt[i];
    if (Fmt[i] == '%' && Fmt[i + 1] == 'a') { f[j++] = 's'; i++; }
    else if (Fmt[i] == 'x' && j >= 2) f[j - 1] = 'X';   /* EDK2's %x is upper case */
  }
  f[j] = 0;
  va_list ap; va_start (ap, Fmt); int n = vsnprintf (Buf, Size, f, ap); va_end (ap);
  return n;
}

/* only L"<prefix>%s" with a CHAR16 suffix is used */
UINTN UnicodeSPrint (CHAR16 *Buf, UINTN Size, CONST CHAR16 *Fmt, ...) {
  va_list ap; va_start (ap, Fmt); CONST CHAR16 *Arg = va_arg (ap, CONST CHAR16 *); va_end (ap);
  UINTN n = 0, max = Size / 2 - 1;
  for (; *Fmt && n < max; Fmt++) {
    if (Fmt[0] == '%' && Fmt[1] == 's') { for (CONST CHAR16 *a = Arg; *a && n < max; a++) Buf[n++] = *a; Fmt++; }
    else Buf[n++] = *Fmt;
  }
  Buf[n] = 0;
  return n;
}

static EFI_STATUS Read (EFI_BLOCK_IO_PROTOCOL *B, UINT32 Id, UINT64 Lba, UINTN Bytes, VOID *Out) {
  FILE *f = fopen (B->Path, "rb");
  if (!f) return 1;
  memset (Out, 0, Bytes);
  fseek (f, Lba * B->Media->BlockSize, SEEK_SET);
  size_t got = fread (Out, 1, Bytes, f);
  (void)got;
  fclose (f);
  return 0;
}

EFI_STATUS GetBlkIOHandles (UINT32 Attr, PartiSelectFilter *F, HandleInfo *H, UINT32 *Count) {
  static char path[512]; static EFI_BLOCK_IO_MEDIA m; static EFI_BLOCK_IO_PROTOCOL b;
  char name[64]; size_t i = 0;
  for (; F->PartitionLabel[i] && i < sizeof (name) - 1; i++) name[i] = (char)F->PartitionLabel[i];
  name[i] = 0;
  snprintf (path, sizeof (path), "%s/%s.img", Dir, name);
  struct stat st;
  if (stat (path, &st) != 0) { *Count = 0; return 0; }
  m.BlockSize = 4096; m.LastBlock = (st.st_size + 4095) / 4096 - 1;
  b.Media = &m; b.ReadBlocks = Read; b.Path = path;
  H[0].BlkIo = &b; *Count = 1;
  return 0;
}

int main (int argc, char **argv) {
  Dir = argv[1];
  CHAR16 suffix[4] = { '_', (CHAR16)argv[2][0], 0 };
  ANDROID_BUILD_VARS v;
  ReadAndroidBuildVars (suffix, &v);
  printf ("{\"os_version\":\"%s\",\"patch\":\"%s\",\"vbmeta_sha256\":\"%s\"}\n", v.OsVersion, v.SecurityPatch, v.VbmetaSha256);
  return 0;
}
