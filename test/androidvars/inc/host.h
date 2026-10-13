/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Host stand-ins for the EDK2 library calls of AndroidBuildVars.c (see stubs.c). */
#ifndef HOST_H
#define HOST_H
#include <Base.h>
#include <string.h>
#include <stdlib.h>
#define CopyMem(d, s, n) memcpy (d, s, n)
#define CompareMem(a, b, n) memcmp (a, b, n)
#define AllocatePool(n) malloc (n)
#define FreePool(p) free (p)
#define MultU64x32(a, b) ((UINT64)(a) * (UINT32)(b))
UINTN AsciiSPrint (CHAR8 *Buf, UINTN Size, CONST CHAR8 *Fmt, ...);
UINTN UnicodeSPrint (CHAR16 *Buf, UINTN Size, CONST CHAR16 *Fmt, ...);
typedef struct { UINT32 MediaId; UINT32 BlockSize; UINT64 LastBlock; } EFI_BLOCK_IO_MEDIA;
typedef struct EFI_BLOCK_IO_PROTOCOL EFI_BLOCK_IO_PROTOCOL;
struct EFI_BLOCK_IO_PROTOCOL {
  EFI_BLOCK_IO_MEDIA *Media;
  EFI_STATUS (*ReadBlocks) (EFI_BLOCK_IO_PROTOCOL *, UINT32, UINT64, UINTN, VOID *);
  const char *Path;
};
typedef struct { VOID *RootDeviceType; CHAR16 *PartitionLabel; CHAR16 *VolumeName; } PartiSelectFilter;
typedef struct { EFI_HANDLE Handle; EFI_BLOCK_IO_PROTOCOL *BlkIo; VOID *BlkIo2; VOID *Ext; } HandleInfo;
#define BLK_IO_SEL_PARTITIONED_MBR 1
#define BLK_IO_SEL_PARTITIONED_GPT 2
#define BLK_IO_SEL_MEDIA_TYPE_NON_REMOVABLE 4
#define BLK_IO_SEL_MATCH_PARTITION_LABEL 8
EFI_STATUS GetBlkIOHandles (UINT32 Attr, PartiSelectFilter *F, HandleInfo *H, UINT32 *Count);
#endif
