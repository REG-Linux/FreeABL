# Third-party licences

The FreeABL ABL images contain code from the projects below, linked into
LinuxLoader together with FreeABL's own code (GPL-3.0-or-later, see `LICENSE`).
The source of every image is the FreeABL repository and its `edk2` submodule,
at the commits named in `SOURCE.txt` next to the image.

| Component | Where in the source | Licence |
|---|---|---|
| TianoCore EDK2 (MdePkg, MdeModulePkg, ArmPkg, EmbeddedPkg) | `edk2/` | BSD-2-Clause-Patent |
| CodeLinaro / Qualcomm LinuxLoader (QcomModulePkg) | `edk2/QcomModulePkg` | BSD-3-Clause, BSD-3-Clause-Clear |
| Android Verified Boot (libavb) | `edk2/QcomModulePkg/Library/avb/libavb` | MIT (`avb_crc32.c`: Apache-2.0) |
| libfdt | `edk2/EmbeddedPkg/Library/FdtLib` | BSD-2-Clause (dual GPL-2.0-or-later / BSD) |
| libufdt (AOSP) | `edk2/EmbeddedPkg/Library/LibUfdt` | Apache-2.0 (`sysdeps/libufdt_sysdeps_vendor.c`: OpenBSD qsort, BSD-3-Clause) |
| Android sparse image format | `edk2/QcomModulePkg/Library/FastbootLib/SparseFormat.h` | Apache-2.0 |
| zlib | `edk2/QcomModulePkg/Library/zlib` | Zlib |

## Copyright notices

Collected from the headers of the source files of every library that can be
linked into LinuxLoader:

- Copyright (c) 1992, 1993 The Regents of the University of California. All rights reserved
- Copyright (C) 1995-2003, 2010 Mark Adler
- Copyright (C) 1995-2005, 2010 Mark Adler
- Copyright (C) 1995-2005, 2010, 2011, 2012 Jean-loup Gailly
- Copyright (C) 1995-2008, 2010, 2013 Mark Adler
- Copyright (C) 1995-2009 Mark Adler
- Copyright (C) 1995-2011 Mark Adler
- Copyright (C) 1995-2012 Mark Adler
- Copyright (C) 1995-2013 Jean-loup Gailly
- Copyright (C) 1995-2013 Jean-loup Gailly and Mark Adler
- Copyright (C) 1995-2013 Mark Adler
- Copyright (C) 2005, 2007 Olivier Gay <olivier.gay@a3.epfl.ch>
- Copyright (c) 2006 - 2008, Intel Corporation. All rights reserved
- Copyright (c) 2006 - 2009, Intel Corporation. All rights reserved
- Copyright (c) 2006 - 2010, Intel Corporation. All rights reserved
- Copyright (c) 2006 - 2012, Intel Corporation. All rights reserved
- Copyright (c) 2006 - 2014, Intel Corporation. All rights reserved
- Copyright (c) 2006 - 2015, Intel Corporation. All rights reserved
- Copyright (c) 2006 - 2016, Intel Corporation. All rights reserved
- Copyright (c) 2006 - 2018, Intel Corporation. All rights reserved
- Copyright (c) 2006 - 2019, Intel Corporation. All rights reserved
- Copyright (C) 2006 David Gibson, IBM Corporation
- Copyright (c) 2007 - 2017, Intel Corporation. All rights reserved
- Copyright (c) 2007 - 2018, Intel Corporation. All rights reserved
- Copyright (c) 2008 - 2009, Apple Inc. All rights reserved
- Copyright (c) 2008 - 2010, Apple Inc. All rights reserved
- Copyright (C) 2008 The Android Open Source Project
- Copyright (c) 2008 Travis Geiselbrecht
- Copyright (c) 2009 - 2010, Apple Inc. All rights reserved
- Copyright (c) 2009, Google Inc
- Copyright (c) 2009-2013, ARM Ltd.  All rights reserved
- Copyright (c) 2009-2021, The Linux Foundation. All rights reserved
- Copyright (C) 2010 The Android Open Source Project
- Copyright (c) 2010-2011, Linaro Limited
- Copyright (c) 2011 - 2013, ARM Limited. All rights reserved
- Copyright (c) 2011 - 2014, ARM Limited. All rights reserved
- Copyright (c) 2011 - 2014, ARM Ltd. All rights reserved
- Copyright (c) 2011 - 2016, ARM Limited. All rights reserved
- Copyright (c) 2011 - 2017, ARM Limited. All rights reserved
- Copyright (c) 2011 - 2017, Intel Corporation. All rights reserved
- Copyright (c) 2011 - 2018, Intel Corporation. All rights reserved
- Copyright (c) 2011 The Chromium OS Authors. All rights reserved
- Copyright (c) 2011, ARM Limited. All rights reserved
- Copyright (c) 2011, ARM. All rights reserved
- Copyright (c) 2011,2014-2015,2021 The Linux Foundation. All rights
- Copyright (c) 2011-2012, ARM Limited. All rights reserved
- Copyright (c) 2011-2013, ARM Limited. All rights reserved
- Copyright (c) 2011-2014, ARM Limited. All rights reserved
- Copyright (c) 2011-2015, ARM Limited. All rights reserved
- Copyright (c) 2011-2016, ARM Limited. All rights reserved
- Copyright (c) 2012 - 2016, Linaro Limited
- Copyright (C) 2012 David Gibson, IBM Corporation
- Copyright (c) 2012-2021, The Linux Foundation. All rights reserved
- Copyright (c) 2013 - 2016, Linaro Limited
- Copyright (c) 2013 - 2018, Intel Corporation. All rights reserved
- Copyright (c) 2013, ARM Ltd. All rights reserved
- Copyright (c) 2013, ARM. All rights reserved
- Copyright (c) 2013, Linaro Limited
- Copyright (c) 2013-2014, ARM Ltd. All rights reserved
- Copyright (c) 2014 - 2019, Intel Corporation. All rights reserved
- Copyright (C) 2014 David Gibson <david@gibson.dropbear.id.au>
- Copyright (c) 2014, ARM Limited
- Copyright (c) 2014, Linaro Ltd. All rights reserved
- Copyright (c) 2014-2019, 2021 The Linux Foundation. All rights reserved
- Copyright (c) 2015 - 2019, Intel Corporation. All rights reserved
- Copyright (c) 2015 - 2021, The Linux Foundation. All rights reserved
- Copyright (c) 2015 ARM Ltd
- Copyright (c) 2015 Oleksandr Tymoshenko <gonzo@FreeBSD.org>
- Copyright (c) 2015, 2017-2018, The Linux Foundation. All rights reserved
- Copyright (c) 2015, 2017-2021, The Linux Foundation. All rights reserved
- Copyright (c) 2015, The Linux Foundation. All rights reserved
- Copyright (c) 2015,2017,2019 The Linux Foundation. All rights reserved
- Copyright (c) 2015-2016, 2018 The Linux Foundation. All rights reserved
- Copyright (c) 2015-2016, The Linux Foundation. All rights reserved
- Copyright (c) 2015-2016,2018 The Linux Foundation. All rights reserved
- Copyright (c) 2015-2016,2019 The Linux Foundation. All rights reserved
- Copyright (c) 2015-2017, 2020-2021, The Linux Foundation
- Copyright (c) 2015-2017, The Linux Foundation. All rights reserved
- Copyright (c) 2015-2018, 2020 The Linux Foundation. All rights reserved
- Copyright (c) 2015-2018, 2020, The Linux Foundation. All rights reserved
- Copyright (c) 2015-2018, 2020-2021, The Linux Foundation
- Copyright (c) 2015-2018, 2020-2021, The Linux Foundation. All rights
- Copyright (c) 2015-2018, The Linux Foundation. All rights reserved
- Copyright (c) 2015-2020, The Linux Foundation. All rights reserved
- Copyright (c) 2015-2021, The Linux Foundation. All rights reserved
- Copyright (C) 2016 Free Electrons
- Copyright (C) 2016 NextThing Co
- Copyright (C) 2016 The Android Open Source Project
- Copyright (c) 2016, 2017, 2019, The Linux Foundation. All rights reserved
- Copyright (c) 2016, 2019-2020 The Linux Foundation. All rights reserved
- Copyright (c) 2016, Intel Corporation. All rights reserved
- Copyright (c) 2016, Linaro Limited
- Copyright (c) 2016, Linaro Limited. All rights reserved
- Copyright (c) 2016, Linaro Ltd. All rights reserved
- Copyright (c) 2016, The Linux Foundation. All rights reserved
- Copyright (c) 2016,2021, The Linux Foundation. All rights reserved
- Copyright (c) 2016-2017, 2021, The Linux Foundation. All rights reserved
- Copyright (c) 2016-2017, The Linux Foundation. All rights reserved
- Copyright (c) 2016-2018, 2021 The Linux Foundation. All rights reserved
- Copyright (c) 2016-2018, The Linux Foundation. All rights reserved
- Copyright (c) 2016-2019, The Linux Foundation. All rights reserved
- Copyright (c) 2016-2020, The Linux Foundation. All rights reserved
- Copyright (c) 2016-2021, The Linux Foundation. All rights reserved
- Copyright (c) 2017 - 2019, The Linux Foundation. All rights reserved
- Copyright (C) 2017 The Android Open Source Project
- Copyright (c) 2017, Pete Batard. All rights reserved
- Copyright (c) 2017, The Linux Foundation. All rights reserved
- Copyright (c) 2017,2019, 2020 The Linux Foundation. All rights reserved
- Copyright (c) 2017,2019, 2021 The Linux Foundation. All rights reserved
- Copyright (c) 2017,2019, The Linux Foundation. All rights reserved
- Copyright (c) 2017-2018, 2020, The Linux Foundation. All rights reserved
- Copyright (c) 2017-2018, The Linux Foundation. All rights reserved
- Copyright (c) 2017-2018,2021 The Linux Foundation. All rights reserved
- Copyright (c) 2017-2019, The Linux Foundation. All rights reserved
- Copyright (c) 2017-2021 The Linux Foundation. All rights reserved
- Copyright (c) 2017-2021, The Linux Foundation. All rights reserved
- Copyright (C) 2018 - 2019, Intel Corporation. All rights reserved
- Copyright (c) 2018, 2020, The Linux Foundation. All rights reserved
- Copyright (c) 2018, Dell Technologies. All rights reserved
- Copyright (C) 2018, Intel Corporation. All rights reserved
- Copyright (c) 2018, Intel Corporation. All rights reserved
- Copyright (c) 2018, Linaro Limited. All rights reserved
- Copyright (c) 2018, Microsoft Corporation
- Copyright (c) 2018, Pete Batard. All rights reserved
- Copyright (C) 2018, Red Hat, Inc
- Copyright (c) 2018, The Linux Foundation. All rights reserved
- Copyright (c) 2018-2019, 2021 The Linux Foundation. All rights reserved
- Copyright (c) 2018-2021, The Linux Foundation. All rights reserved
- Copyright (c) 2019, 2021 The Linux Foundation. All rights reserved
- Copyright (c) 2019, 2021, The Linux Foundation. All rights reserved
- Copyright (c) 2019, Linaro Ltd. All rights reserved
- Copyright (c) 2019, NVIDIA Corporation. All rights reserved
- Copyright (c) 2019, Pete Batard. All rights reserved
- Copyright (c) 2019, The Linux Foundation. All rights reserved
- Copyright (c) 2019-2021, The Linux Foundation. All rights reserved
- Copyright (c) 2020 The Linux Foundation. All rights reserved
- Copyright (c) 2020, 2021, The Linux Foundation. All rights reserved
- Copyright (c) 2020, The Linux Foundation. All rights reserved
- Copyright (c) 2020-2021, The Linux Foundation. All rights reserved
- Copyright (c) 2021 - 2023 Qualcomm Innovation Center, Inc. All rights
- Copyright (C) 2021 The Android Open Source Project
- Copyright (c) 2021, The Linux Foundation. All rights reserved
- Copyright (c) 2021-2024 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2022 - 2023 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2022 - 2024 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2022 - 2025 Qualcomm Innovation Center, Inc. All rights
- Copyright (c) 2022 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2022, 2023, Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2022, 2024 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2022, 2025 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2022-2023 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2022-2023, 2025 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2022-2024 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2022-2025 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2023 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2023, 2025, Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2024 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2024-2025 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright (c) 2025 Qualcomm Innovation Center, Inc. All rights reserved
- Copyright 1995-2013 Mark Adler ";
- Copyright 2015 Hewlett-Packard Development Company, L.P
- Copyright 2020 The Android Open Source Project
- Portions copyright (c) 2008 - 2009, Apple Inc. All rights reserved
- Portions Copyright (c) 2008-2015 Travis Geiselbrecht
- Portions copyright (c) 2011 - 2013, ARM Limited. All rights reserved
- Portions copyright (c) 2011 - 2013, ARM Ltd. All rights reserved
- Portions Copyright (c) 2011 - 2013, ARM Ltd. All rights reserved
- Portions copyright (c) 2011 - 2014, ARM Ltd. All rights reserved
- Portions copyright (c) 2011, ARM Limited. All rights reserved

## Licence texts

### BSD-2-Clause-Patent (TianoCore EDK2, `edk2/License.txt`)

```text
Copyright (c) 2019, TianoCore and contributors.  All rights reserved.

SPDX-License-Identifier: BSD-2-Clause-Patent

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

Subject to the terms and conditions of this license, each copyright holder
and contributor hereby grants to those receiving rights under this license
a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable
(except for failure to satisfy the conditions of this license) patent
license to make, have made, use, offer to sell, sell, import, and otherwise
transfer this software, where such license applies only to those patent
claims, already acquired or hereafter acquired, licensable by such copyright
holder or contributor that are necessarily infringed by:

(a) their Contribution(s) (the licensed copyrights of copyright holders and
    non-copyrightable additions of contributors, in source or binary form)
    alone; or

(b) combination of their Contribution(s) with the work of authorship to
    which such Contribution(s) was added by such copyright holder or
    contributor, if, at the time the Contribution is added, such addition
    causes such combination to be necessarily infringed. The patent license
    shall not apply to any other combinations which include the
    Contribution.

Except as expressly stated above, no rights or licenses from any copyright
holder or contributor is granted under this license, whether expressly, by
implication, estoppel or otherwise.

DISCLAIMER

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

### BSD-3-Clause

```text
Copyright (c) <year> <owner>. 

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD-3-Clause-Clear

```text
The Clear BSD License

Copyright (c) [xxxx]-[xxxx] [Owner Organization]
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted (subject to the limitations in the disclaimer below) provided that the following conditions are met:

     * Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

     * Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

     * Neither the name of [Owner Organization] nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

NO EXPRESS OR IMPLIED LICENSES TO ANY PARTY'S PATENT RIGHTS ARE GRANTED BY THIS LICENSE. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD-2-Clause

```text
Copyright (c) <year> <owner> 

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### MIT

```text
MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Zlib

```text
zlib License

This software is provided 'as-is', without any express or implied warranty.  In no event will the authors be held liable for any damages arising from the use of this software.

Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:

     1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.

     2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.

     3. This notice may not be removed or altered from any source distribution.
```

### Apache-2.0

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

