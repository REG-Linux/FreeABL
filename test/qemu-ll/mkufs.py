#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""mkufs.py <img> [--active a|b] [--boot-b android|empty] [--dtbo-b valid|erased] [--stock DIR]
Odin-like UFS LUN image: devinfo, misc, boot_a/b, dtbo_a/b, vbmeta_a/b, system_a/b,
vendor_a/b, userdata. A/B attributes: active slot marked active+successful, retry count 3.
--stock DIR: real Odin boot_a/dtbo_a/vbmeta_a (DIR/<name>.stock.img) and the real
partition UUIDs from DIR/gpt.txt, so AVB's cmdline matches the device's.
--factory DIR: a vendor factory / flat-build image dir (boot.img, dtbo.img, vbmeta.img and,
if present, vbmeta_system/recovery/init_boot/vendor_boot .img; gpt_both<N>.bin or
gpt_main<N>.bin; e.g. Mangmi Air X): images go to slot a, partitions sized
from the images, UUIDs from the GPTs.
--dump DIR: a raw EDL dump of a device (boot_a.img, dtbo_a.img, vbmeta_a.img and,
if present, vbmeta_system_a.img / recovery_a.img; printgpt.txt for the UUIDs, e.g. Mangmi
Pocket Max): partitions sized from the images, images go to slot a."""
import argparse, subprocess, struct, os, re
ap=argparse.ArgumentParser(); ap.add_argument('img'); ap.add_argument('--active',default='b')
ap.add_argument('--boot-b',default='android'); ap.add_argument('--dtbo-b',default='erased')
ap.add_argument('--stock'); ap.add_argument('--factory'); ap.add_argument('--dump')
a=ap.parse_args()
img=a.img
def imgpath(name):
    """The image for partition name_a: DIR/name_a.img (--dump) or DIR/name.img (--factory)."""
    if a.dump: return os.path.join(a.dump, name+'_a.img')
    if a.factory: return os.path.join(a.factory, name+'.img')
    return ''
def dsz(name, default):
    """Partition size: the image's size (KiB) when it exists."""
    fn=imgpath(name)
    if fn and os.path.exists(fn):
        return f'{(os.path.getsize(fn)+1023)//1024}K'
    return default
def gptnames():
    names=set()
    if a.dump and os.path.exists(os.path.join(a.dump,'printgpt.txt')):
        names|={l.split(':')[0] for l in open(os.path.join(a.dump,'printgpt.txt')) if ':' in l}
    if a.factory:
        for fn in sorted(os.listdir(a.factory)):
            if re.match(r'gpt_(both|main)\d+\.bin$',fn):
                d=open(os.path.join(a.factory,fn),'rb').read()
                for bs in (4096,512):
                    if d[bs:bs+8]==b'EFI PART': break
                else: continue
                num,esz=struct.unpack_from('<II',d,bs+80)
                for i in range(num):
                    e=d[2*bs+i*esz:2*bs+(i+1)*esz]
                    if len(e)==esz and e[:16]!=b'\0'*16: names.add(e[56:128].decode('utf-16le').rstrip('\0'))
    return names
parts=[('devinfo','4K'),('abl_a','1M'),('abl_b','1M'),('misc','1M'),
       ('boot_a',dsz('boot','64M')),('boot_b',dsz('boot','64M')),('dtbo_a',dsz('dtbo','8M')),('dtbo_b',dsz('dtbo','8M')),
       ('vbmeta_a','64K'),('vbmeta_b','64K')]
if a.dump or a.factory:
    have=gptnames()
    for n in ('vbmeta_system','recovery','init_boot','vendor_boot'):
        if os.path.exists(imgpath(n)) or (n+'_a') in have:
            parts+=[(n+'_a',dsz(n,'64M')),(n+'_b',dsz(n,'64M'))]
    # Dynamic partitions: the ABL decides from the presence of "super".
    if 'super' in have:
        parts+=[('super','4M')]
parts+=[('system_a','8M'),('system_b','1M'),('vendor_a','1M'),('vendor_b','1M'),('userdata','0')]
subprocess.run(['truncate','-s','1G' if (a.dump or a.factory) else '512M',img],check=True)
args=['sgdisk','-o']
ANDROID_BOOT='BB499290-B57A-49F2-9FA7-1EE1BC9A6A6F'  # generic type; CLO matches by name
for i,(n,sz) in enumerate(parts,1):
    args+=[f'-n{i}:0:{"+"+sz if sz!="0" else "0"}', f'-c{i}:{n}', f'-t{i}:{ANDROID_BOOT if n.startswith("boot") else ("82ACC91F-357C-4A68-9C8F-689E1B1A23A1" if n=="misc" else "8300")}']
subprocess.run(args+[img],check=True,stdout=subprocess.DEVNULL)
if a.dump and os.path.exists(os.path.join(a.dump,'printgpt.txt')):
    uu={}
    for l in open(os.path.join(a.dump,'printgpt.txt')):
        m=l.split()
        if m and m[0].endswith(':') and 'UUID' in m:   # edl printgpt: 4th group byte-swapped
            g=m[m.index('UUID')+1].rstrip(',').split('-'); g[3]=g[3][2:4]+g[3][0:2]; uu[m[0][:-1]]='-'.join(g)
    for i,(n,_) in enumerate(parts,1):
        if n in uu:
            subprocess.run(['sgdisk',f'-u{i}:{uu[n]}',img],check=True,stdout=subprocess.DEVNULL)
if a.factory:
    import uuid as _uuid
    uu={}
    for fn in sorted(os.listdir(a.factory)):
        if not re.match(r'gpt_(both|main)\d+\.bin$',fn): continue
        fn=os.path.join(a.factory,fn)
        if not os.path.exists(fn): continue
        d=open(fn,'rb').read()
        for bs in (4096,512):
            if d[bs:bs+8]==b'EFI PART': break
        else: continue
        num,esz=struct.unpack_from('<II',d,bs+80)
        for i in range(num):
            e=d[2*bs+i*esz:2*bs+(i+1)*esz]
            if len(e)==esz and e[:16]!=b'\0'*16:
                uu[e[56:128].decode('utf-16le').rstrip('\0')]=str(_uuid.UUID(bytes_le=e[16:32]))
    for i,(n,_) in enumerate(parts,1):
        if n in uu:
            subprocess.run(['sgdisk',f'-u{i}:{uu[n]}',img],check=True,stdout=subprocess.DEVNULL)
if a.stock:
    # gpt.txt (edl printgpt) prints the 4th UUID group byte-swapped: fix it.
    uu={}
    for l in open(os.path.join(a.stock,'gpt.txt')):
        m=l.split()
        if m and m[0].endswith(':') and 'UUID' in m:
            g=m[m.index('UUID')+1].rstrip(',').split('-'); g[3]=g[3][2:4]+g[3][0:2]; uu[m[0][:-1]]='-'.join(g)
    for i,(n,_) in enumerate(parts,1):
        if n in uu:
            subprocess.run(['sgdisk',f'-u{i}:{uu[n]}',img],check=True,stdout=subprocess.DEVNULL)
# slot attributes (CLO bits: 48-49 priority, 50 active, 51-53 retry, 54 successful, 55 unbootable)
for i,(n,_) in enumerate(parts,1):
    if n.startswith('boot_'):
        s=n[-1]; act=(s==a.active)
        attr=(3<<48 if act else 1<<48)|(1<<50 if act else 0)|(3<<51)|(1<<54 if act else 0)
        subprocess.run(['sgdisk',f'-A{i}:=:{attr:016x}',img],check=True,stdout=subprocess.DEVNULL)
def start(name):
    out=subprocess.run(['sgdisk','-i',str([p[0] for p in parts].index(name)+1),img],capture_output=True,text=True).stdout
    return int([l for l in out.splitlines() if l.startswith('First sector')][0].split()[2])*512
def bootimg():
    h=bytearray(4096); h[0:8]=b'ANDROID!'; struct.pack_into('<IIIIIIIIII',h,8,0x1000,0x8000,0,0x1000000,0,0xf00000,0x100,4096,2,0)
    return bytes(h)+b'\0'*8192
def system_vbmeta():
    """Unsigned vbmeta (algorithm NONE) with the hashtree descriptor of the Odin's
    system_a, values from the stock cmdline: dm="1 vroot none ro 1,0 9288120 verity 1
    ... 4096 4096 1161015 1161015 sha1 <digest> <salt> 10 ... fec_roots 2
    fec_blocks 1170158 fec_start 1170158"."""
    name=b'system'; salt=bytes.fromhex('5f1de04e3d4aacf6e4534214cb2d47fbed5bd80d')
    digest=bytes.fromhex('82fee16560096e4b0a6ab683a02e0e30c7b594ce')
    img=1161015*4096; fec=1170158*4096
    body=struct.pack('>IQQQIIIQQ',1,img,img,fec-img,4096,4096,2,fec,0)
    body+=b'sha1'.ljust(32,b'\0')+struct.pack('>IIII',len(name),len(salt),len(digest),0)+b'\0'*60
    body+=name+salt+digest
    body+=b'\0'*((-len(body))%8)
    desc=struct.pack('>QQ',1,len(body))+body
    aux=desc+b'\0'*((-len(desc))%64)
    hdr=b'AVB0'+struct.pack('>IIQQI',1,0,0,len(aux),0)
    hdr+=struct.pack('>QQQQQQQQQQQ',0,0,0,0,0,0,0,0,0,len(desc),0)   # hash,sig,pk,pkmd,descriptors
    hdr+=struct.pack('>II',0,0)+b'avbtool 1.1.0 (qemu-ll test)'.ljust(48,b'\0')+b'\0'*80
    assert len(hdr)==256
    return hdr+aux
def dtbo(): return struct.pack('>IIII',0xd7b7ab1e,32+32,32,32)+b'\0'*4080
with open(img,'r+b') as f:
    for n,data in [('boot_a',bootimg()),('dtbo_a',dtbo()),
                   ('boot_b',bootimg() if a.boot_b=='android' else b'\0'*4096),
                   ('dtbo_b',dtbo() if a.dtbo_b=='valid' else b'\0'*4096)]:
        f.seek(start(n)); f.write(data)
    if a.stock:
        for n in ('boot_a','dtbo_a','vbmeta_a'):
            f.seek(start(n)); f.write(open(os.path.join(a.stock,n+'.stock.img'),'rb').read())
        # system_a: the real one carries its own (chained) vbmeta in an AVB footer.
        # Rebuild it, unsigned, with the hashtree values of the stock cmdline's dm=
        # (unlocked: AVB reports a verification error and goes on, as on the device).
        vb=system_vbmeta(); f.seek(start('system_a')); f.write(vb)
        foot=b'AVBf'+struct.pack('>IIQQQ',1,0,4755517440,0,len(vb))+b'\0'*28
        f.seek(start('system_a')+8*1024*1024-64); f.write(foot)
    if a.dump:
        # Both slots when the dump has them (e.g. Air X running from slot b).
        for n in ('boot','dtbo','vbmeta','vbmeta_system','recovery','init_boot','vendor_boot'):
            for sl in ('a','b'):
                fn=os.path.join(a.dump,f'{n}_{sl}.img')
                if os.path.exists(fn) and f'{n}_{sl}' in [q[0] for q in parts]:
                    f.seek(start(f'{n}_{sl}')); f.write(open(fn,'rb').read())
    if a.factory:
        for n in ('boot','dtbo','vbmeta','vbmeta_system','recovery','init_boot','vendor_boot'):
            fn=imgpath(n)
            if os.path.exists(fn):
                f.seek(start(n+'_a')); f.write(open(fn,'rb').read())
print(f'{img}: active={a.active} boot_b={a.boot_b} dtbo_b={a.dtbo_b} stock={a.stock} factory={a.factory} dump={a.dump}')
