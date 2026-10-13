/* SPDX-License-Identifier: GPL-3.0-or-later */
/* libavb system dependencies on the host. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libavb/avb_sysdeps.h"
int avb_memcmp(const void* a, const void* b, size_t n) { return memcmp(a, b, n); }
int avb_strcmp(const char* a, const char* b) { return strcmp(a, b); }
int avb_strncmp(const char* a, const char* b, size_t n) { return strncmp(a, b, n); }
void* avb_memcpy(void* d, const void* s, size_t n) { return memcpy(d, s, n); }
void* avb_memset(void* d, const int c, size_t n) { return memset(d, c, n); }
void avb_print(UINTN l, const char* m) { fprintf(stderr, "%s", m); }
void avb_printv(UINTN l, const char* m, ...) { fprintf(stderr, "%s", m); }
void avb_abort(void) { abort(); }
void* avb_malloc_(size_t n) { return malloc(n); }
void avb_free(void* p) { free(p); }
size_t avb_strlen(const char* s) { return strlen(s); }
uint32_t avb_div_by_10(uint64_t* d) { uint32_t r = *d % 10; *d /= 10; return r; }
