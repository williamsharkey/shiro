#!/usr/bin/env python3
"""Build public/gui/apps.json: Debian bookworm amd64 GUI apps for Shiro.

For each app, resolve its Depends closure from the Packages index, unpack
the closure, and keep only what the app needs to start:

  - the ELF closure: DT_NEEDED of the app's binaries and of the toolkit
    plugins it always loads (Qt's xcb platform plugin, gdk-pixbuf loaders),
    resolved through the unpacked libraries, mapped back to packages;
  - architecture-independent data packages (Architecture: all) of the
    closure: themes, icons, fonts, schemas, X data;
  - per-app extras below.

Libraries only reached through dlopen of optional modules (CUPS print
backends, Mesa/LLVM through libglvnd, ...) are left out, so they are never
downloaded. Packages are content addressed by the .deb sha256 from the
Packages index; the browser verifies it (src/gui/apps.ts).

usage: gen-apps.py Packages DEB_CACHE_DIR WORK_DIR public/gui/apps.json
(Packages: http://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Packages.xz, decompressed)
"""
import json, os, subprocess, sys, urllib.request, hashlib, shutil

SUITE = 'bookworm'

# Never install: maintainer-script/system packages Shiro provides itself or doesn't need.
SKIP = set('''debconf perl-base dpkg init-system-helpers libc-bin tar coreutils man-db sysvinit-utils lsb-base
adduser passwd login systemd systemd-sysv dbus dbus-daemon dbus-system-bus-common dbus-session-bus-common dbus-bin
dbus-user-session libpam-systemd perl perl-modules-5.36 libperl5.36 python3 python3.11 python3-minimal
python3.11-minimal libpython3.11-stdlib libpython3.11-minimal ucf sensible-utils debianutils base-files bash
dconf-service xdg-user-dirs ncurses-base mount util-linux procps libpam-modules libpam-runtime'''.split())

APPS = {
    # name: (packages, binaries, plugin globs, extra packages, description, category)
    'xterm': (['xterm'], ['/usr/bin/xterm'], [], [], 'Terminal emulator for X', 'x11'),
    'xeyes': (['x11-apps'], ['/usr/bin/xeyes'], [], [], 'Eyes that follow the pointer', 'x11'),
    'xclock': (['x11-apps'], ['/usr/bin/xclock'], [], [], 'Analog/digital clock', 'x11'),
    'xcalc': (['x11-apps'], ['/usr/bin/xcalc'], [], [], 'Scientific calculator', 'x11'),
    'xedit': (['x11-apps'], ['/usr/bin/xedit'], [], [], 'Simple Athena text editor', 'x11'),
    'l3afpad': (['l3afpad'], ['/usr/bin/l3afpad'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'],
                ['libglib2.0-bin', 'shared-mime-info'], 'Lightweight GTK3 text editor', 'gtk3'),
    'mousepad': (['mousepad'], ['/usr/bin/mousepad'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'],
                 ['libglib2.0-bin', 'shared-mime-info'], 'Xfce GTK3 text editor', 'gtk3'),
    'ristretto': (['ristretto'], ['/usr/bin/ristretto'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'],
                  ['libglib2.0-bin', 'shared-mime-info'], 'Xfce GTK3 image viewer', 'gtk3'),
    'gpicview': (['gpicview'], ['/usr/bin/gpicview'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'],
                 ['shared-mime-info'], 'LXDE image viewer (GTK)', 'gtk2'),
    'featherpad': (['featherpad'], ['/usr/bin/featherpad'], ['usr/lib/x86_64-linux-gnu/qt5/plugins/platforms/libqxcb.so',
                   'usr/lib/x86_64-linux-gnu/qt5/plugins/imageformats/*.so'], [], 'Qt5 text editor', 'qt5'),
    'lximage-qt': (['lximage-qt'], ['/usr/bin/lximage-qt'], ['usr/lib/x86_64-linux-gnu/qt5/plugins/platforms/libqxcb.so',
                   'usr/lib/x86_64-linux-gnu/qt5/plugins/imageformats/*.so'], [], 'LXQt image viewer (Qt5)', 'qt5'),
}

# Kept whenever they are in the closure: glibc dlopens libgcc_s; fontconfig needs /etc/fonts.
ALWAYS = {'libgcc-s1', 'fontconfig-config'}

LIBDIRS = ['lib/x86_64-linux-gnu', 'usr/lib/x86_64-linux-gnu', 'lib', 'usr/lib', 'lib64']


def load_index(path):
    db, prov, cur = {}, {}, {}
    def flush():
        if cur.get('Package'):
            db[cur['Package']] = dict(cur)
            for p in cur.get('Provides', '').split(','):
                p = p.strip().split(' ')[0]
                if p: prov.setdefault(p, cur['Package'])
    for line in open(path, encoding='utf-8', errors='replace'):
        if line == '\n':
            flush(); cur.clear(); continue
        if line[0] in ' \t': continue
        k, _, v = line.partition(':'); cur[k] = v.strip()
    flush()
    return db, prov


def closure(db, prov, roots):
    seen, todo = [], list(roots)
    while todo:
        n = todo.pop()
        n = n if n in db else prov.get(n, n)
        if n in seen or n in SKIP or n not in db: continue
        seen.append(n)
        for f in ('Pre-Depends', 'Depends'):
            for alt in db[n].get(f, '').split(','):
                alt = alt.strip()
                if alt: todo.append(alt.split('|')[0].strip().split(' ')[0].split(':')[0])
    return seen


def fetch(db, name, cache):
    fn = db[name]['Filename']
    dst = os.path.join(cache, os.path.basename(fn))
    if not os.path.exists(dst):
        urllib.request.urlretrieve('http://deb.debian.org/debian/' + fn, dst)
    h = hashlib.sha256(open(dst, 'rb').read()).hexdigest()
    if h != db[name]['SHA256']: raise SystemExit(f'sha256 mismatch for {name}')
    return dst


def unpack(deb, root):
    """Unpack a .deb; return the list of regular files/symlinks it contains (relative paths)."""
    out = subprocess.run(['dpkg-deb', '-c', deb], capture_output=True, text=True, check=True).stdout
    files = []
    for line in out.splitlines():
        p = line.split(None, 5)[5].split(' -> ')[0]
        p = p[2:] if p.startswith('./') else p
        if not line.startswith('d') and p: files.append(p)
    subprocess.run(['dpkg-deb', '-x', deb, root], check=True)
    return files


def needed(path):
    try:
        out = subprocess.run(['readelf', '-d', path], capture_output=True, text=True).stdout
    except Exception:
        return []
    return [l.split('[')[1].split(']')[0] for l in out.splitlines() if '(NEEDED)' in l]


def main():
    index, cache, work, out = sys.argv[1:5]
    db, prov = load_index(index)
    os.makedirs(cache, exist_ok=True)
    packages = {}
    apps = {}
    for app, (roots, bins, plugins, extra, desc, kind) in APPS.items():
        names = closure(db, prov, roots + extra)
        root = os.path.join(work, app)
        shutil.rmtree(root, ignore_errors=True)
        os.makedirs(root)
        owner = {}
        for n in names:
            for f in unpack(fetch(db, n, cache), root):
                owner.setdefault(f, n)
        # ELF closure
        import glob
        starts = [b.lstrip('/') for b in bins]
        for g in plugins:
            starts += [os.path.relpath(p, root) for p in glob.glob(os.path.join(root, g))]
        need, seen_files, todo = set(), set(), list(starts)
        while todo:
            f = todo.pop()
            if f in seen_files: continue
            seen_files.add(f)
            real = os.path.realpath(os.path.join(root, f))
            rel = os.path.relpath(real, root)
            for p in (f, rel):
                if p in owner: need.add(owner[p])
            for lib in needed(real):
                for d in LIBDIRS:
                    cand = os.path.join(d, lib)
                    if os.path.lexists(os.path.join(root, cand)):
                        todo.append(cand); break
        data = [n for n in names if db[n].get('Architecture') == 'all']
        keep = [n for n in names if n in need or n in data or n in roots or n in extra or n in ALWAYS]
        dropped = [n for n in names if n not in keep]
        apps[app] = {
            'description': desc, 'toolkit': kind, 'bin': bins[0], 'packages': keep,
            'size': sum(int(db[n]['Size']) for n in keep),
            'closureSize': sum(int(db[n]['Size']) for n in names),
            'dropped': dropped,
        }
        for n in keep:
            d = db[n]
            packages[n] = {'version': d['Version'], 'filename': d['Filename'], 'sha256': d['SHA256'], 'size': int(d['Size'])}
        print(f"{app:12s} keep {len(keep):3d} pkgs {apps[app]['size']/1e6:6.1f} MB (closure {len(names)} / {apps[app]['closureSize']/1e6:.1f} MB); dropped: {' '.join(dropped)}", file=sys.stderr)
    json.dump({'suite': SUITE, 'arch': 'amd64', 'mirror': 'https://deb.debian.org/debian/',
               'snapshot': 'https://snapshot.debian.org/archive/debian/20260712T000000Z/',
               'packages': packages, 'apps': apps}, open(out, 'w'), indent=1, sort_keys=True)


main()
