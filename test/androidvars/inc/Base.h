/* SPDX-License-Identifier: GPL-3.0-or-later */
/* UEFI base types for compiling AndroidBuildVars.c and libavb on the host (run.sh). */
#ifndef HOST_BASE_H
#define HOST_BASE_H
#include <stdint.h>
#include <stddef.h>

typedef uint8_t UINT8; typedef uint16_t UINT16; typedef uint32_t UINT32; typedef uint64_t UINT64;
typedef int32_t INT32; typedef int64_t INT64; typedef size_t UINTN; typedef long INTN;
typedef char CHAR8; typedef uint16_t CHAR16; typedef unsigned char BOOLEAN; typedef void VOID;
typedef UINTN EFI_STATUS; typedef void *EFI_HANDLE;
#define TRUE 1
#define FALSE 0
#define IN
#define OUT
#define OPTIONAL
#define CONST const
#define STATIC static
#define EFI_SUCCESS 0
#define EFI_ERROR(s) ((s) != 0)
#define ARRAY_SIZE(a) (sizeof (a) / sizeof ((a)[0]))
#define DEBUG(x)
#define EFI_D_INFO 0
#define EFI_D_ERROR 0
#endif
