#!/usr/bin/env python3
"""Fetch a Debian bookworm package closure and unpack it into a rootfs dir (dev/probe tool).

usage: SKIP=pkg,pkg debfetch.py Packages(.xz-decoded index) DEB_CACHE_DIR ROOTFS_DIR pkg...
Get the index: curl -O http://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Packages.xz && xz -dk Packages.xz
"""
# usage: debfetch.py Packages outdir rootfs pkg...   resolves Depends/Pre-Depends closure, downloads, extracts
import sys, os, re, subprocess, urllib.request, json
pk, outdir, rootfs, *want = sys.argv[1:]
db = {}; prov = {}
cur = {}
def flush():
    if cur.get('Package'):
        db[cur['Package']] = dict(cur)
        for p in cur.get('Provides','').split(','):
            p = p.strip().split(' ')[0]
            if p: prov.setdefault(p, cur['Package'])
for line in open(pk, encoding='utf-8', errors='replace'):
    if line == '\n': flush(); cur = {}; continue
    if line[0] in ' \t': continue
    k, _, v = line.partition(':'); cur[k] = v.strip()
flush()
SKIP = set(os.environ.get('SKIP','').split(','))
seen = []; todo = list(want)
while todo:
    n = todo.pop()
    n = n if n in db else prov.get(n, n)
    if n in seen or n in SKIP: continue
    if n not in db: print('missing', n, file=sys.stderr); continue
    seen.append(n)
    for f in ('Pre-Depends', 'Depends'):
        for alt in db[n].get(f, '').split(','):
            alt = alt.strip()
            if not alt: continue
            name = alt.split('|')[0].strip().split(' ')[0].split(':')[0]
            todo.append(name)
os.makedirs(outdir, exist_ok=True); os.makedirs(rootfs, exist_ok=True)
tot = 0
for n in seen:
    fn = db[n]['Filename']; dst = os.path.join(outdir, os.path.basename(fn))
    tot += int(db[n]['Size'])
    if not os.path.exists(dst):
        urllib.request.urlretrieve('http://deb.debian.org/debian/' + fn, dst)
    subprocess.run(['dpkg-deb', '-x', dst, rootfs], check=True)
print(json.dumps({'packages': seen, 'debBytes': tot}))
