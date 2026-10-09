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
                  ['libglib2.0-bin', 'shared-mime-info', 'libmagic-mgc'], 'Xfce GTK3 image viewer', 'gtk3'),
    'gpicview': (['gpicview'], ['/usr/bin/gpicview'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'],
                 ['shared-mime-info'], 'LXDE image viewer (GTK)', 'gtk2'),
    'gimp': (['gimp'], ['/usr/bin/gimp-2.10'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so',
             'usr/lib/x86_64-linux-gnu/babl-0.1/*.so', 'usr/lib/gimp/2.0/modules/*.so'],
             ['shared-mime-info', 'libglib2.0-bin'], 'GNU Image Manipulation Program (GTK 2)', 'gtk2'),
    'featherpad': (['featherpad'], ['/usr/bin/featherpad'], ['usr/lib/x86_64-linux-gnu/qt5/plugins/platforms/libqxcb.so',
                   'usr/lib/x86_64-linux-gnu/qt5/plugins/imageformats/*.so'], [], 'Qt5 text editor', 'qt5'),
    'lximage-qt': (['lximage-qt'], ['/usr/bin/lximage-qt'], ['usr/lib/x86_64-linux-gnu/qt5/plugins/platforms/libqxcb.so',
                   'usr/lib/x86_64-linux-gnu/qt5/plugins/imageformats/*.so'], [], 'LXQt image viewer (Qt5)', 'qt5'),
    'netsurf': (['netsurf-gtk'], ['/usr/bin/netsurf-gtk'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'],
                ['libglib2.0-bin', 'shared-mime-info'], 'Small web browser (GTK3)', 'gtk3'),
    'dillo': (['dillo'], ['/usr/bin/dillo'], ['usr/lib/x86_64-linux-gnu/dillo/dpi/*/*.dpi', 'usr/libexec/dillo/dpid'],
              ['ca-certificates'], 'Tiny web browser (FLTK)', 'fltk'),
    'inkscape': (['inkscape'], ['/usr/bin/inkscape'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'],
                 ['libglib2.0-bin', 'shared-mime-info'], 'Vector graphics editor (GTK3)', 'gtk3'),
    # scoreboard candidates (docs/GUI_SCORE.md)
    'gedit': (['gedit'], ['/usr/bin/gedit'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'], ['libglib2.0-bin', 'shared-mime-info'], 'GNOME text editor (GTK3)', 'gtk3'),
    'evince': (['evince'], ['/usr/bin/evince'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'], ['libglib2.0-bin', 'shared-mime-info'], 'GNOME document viewer (GTK3)', 'gtk3'),
    'eog': (['eog'], ['/usr/bin/eog'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'], ['libglib2.0-bin', 'shared-mime-info'], 'GNOME image viewer (GTK3)', 'gtk3'),
    'pcmanfm': (['pcmanfm'], ['/usr/bin/pcmanfm'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'], ['libglib2.0-bin', 'shared-mime-info'], 'LXDE file manager', 'gtk2'),
    'thunar': (['thunar'], ['/usr/bin/thunar'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'], ['libglib2.0-bin', 'shared-mime-info'], 'Xfce file manager (GTK3)', 'gtk3'),
    'galculator': (['galculator'], ['/usr/bin/galculator'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'], ['libglib2.0-bin', 'shared-mime-info'], 'Scientific calculator (GTK3)', 'gtk3'),
    'gnumeric': (['gnumeric'], ['/usr/bin/gnumeric'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'], ['libglib2.0-bin', 'shared-mime-info'], 'Spreadsheet (GTK3)', 'gtk3'),
    'abiword': (['abiword'], ['/usr/bin/abiword'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'], ['libglib2.0-bin', 'shared-mime-info'], 'Word processor (GTK3)', 'gtk3'),
    'firefox-esr': (['firefox-esr'], ['/usr/lib/firefox-esr/firefox-esr'], ['usr/lib/firefox-esr/*.so', 'usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'],
                    ['libglib2.0-bin', 'shared-mime-info'], 'Web browser (GTK3)', 'gtk3'),
    'libreoffice-writer': (['libreoffice-writer', 'libreoffice-gtk3'], ['/usr/lib/libreoffice/program/soffice.bin'],
                           ['usr/lib/libreoffice/program/*.so', 'usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'], ['libglib2.0-bin', 'shared-mime-info'], 'Word processor (LibreOffice)', 'gtk3'),
    'vlc': (['vlc'], ['/usr/bin/vlc'], ['usr/lib/x86_64-linux-gnu/vlc/plugins/gui/libqt_plugin.so', 'usr/lib/x86_64-linux-gnu/qt5/plugins/platforms/libqxcb.so', 'usr/lib/x86_64-linux-gnu/qt5/plugins/imageformats/*.so'], [], 'Media player (Qt5)', 'qt5'),
    'audacity': (['audacity'], ['/usr/bin/audacity'], ['usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/*.so'], ['libglib2.0-bin', 'shared-mime-info'], 'Audio editor (wxWidgets/GTK3)', 'gtk3'),
    'blender': (['blender'], ['/usr/bin/blender'], [], [], '3D creation suite (OpenGL)', 'gl'),
    'krita': (['krita'], ['/usr/bin/krita'], ['usr/lib/x86_64-linux-gnu/qt5/plugins/platforms/libqxcb.so', 'usr/lib/x86_64-linux-gnu/qt5/plugins/imageformats/*.so'], [], 'Painting program (Qt5)', 'qt5'),
    'qterminal': (['qterminal'], ['/usr/bin/qterminal'], ['usr/lib/x86_64-linux-gnu/qt5/plugins/platforms/libqxcb.so', 'usr/lib/x86_64-linux-gnu/qt5/plugins/imageformats/*.so'], [], 'Terminal emulator (Qt5)', 'qt5'),
    'qpdfview': (['qpdfview'], ['/usr/bin/qpdfview'], ['usr/lib/x86_64-linux-gnu/qt5/plugins/platforms/libqxcb.so', 'usr/lib/x86_64-linux-gnu/qt5/plugins/imageformats/*.so'], [], 'PDF viewer (Qt5)', 'qt5'),
    'kcalc': (['kcalc'], ['/usr/bin/kcalc'], ['usr/lib/x86_64-linux-gnu/qt5/plugins/platforms/libqxcb.so', 'usr/lib/x86_64-linux-gnu/qt5/plugins/imageformats/*.so'], [], 'KDE calculator (Qt5)', 'qt5'),
    'keepassxc': (['keepassxc'], ['/usr/bin/keepassxc'], ['usr/lib/x86_64-linux-gnu/qt5/plugins/platforms/libqxcb.so', 'usr/lib/x86_64-linux-gnu/qt5/plugins/imageformats/*.so'], [], 'Password manager (Qt5)', 'qt5'),
}

# Kept whenever they are in the closure: glibc dlopens libgcc_s; fontconfig needs /etc/fonts.
ALWAYS = {'libgcc-s1', 'fontconfig-config'}

# Plug-ins kept only when the startup set already has their libraries; the
# others are deleted at install (GIMP queries every plug-in on first start).
# Settings written into the user's home before a launch, when the file isn't there
# (the user's own settings win). GIMP: its PNG icon theme; the SVG ones (Symbolic,
# Color) fill every icon with a gradient, which librsvg draws blank in the x86
# engine for now (docs/GUI_SCORE.md). Its system gimprc's icon-theme isn't used.
HOME_FILES = {'gimp': {'.config/GIMP/2.10/gimprc': '(icon-theme "Legacy")\n'}}

OPTIONAL = {'gimp': ['usr/lib/gimp/2.0/plug-ins/*/*', 'usr/lib/x86_64-linux-gnu/gegl-0.4/*.so'],
            'vlc': ['usr/lib/x86_64-linux-gnu/vlc/plugins/*/*.so'],
            'gnumeric': ['usr/lib/gnumeric/*/plugins/*/*.so', 'usr/lib/x86_64-linux-gnu/goffice/*/plugins/*/*.so'],
            'abiword': ['usr/lib/x86_64-linux-gnu/abiword-3.0/plugins/*.so']}

LIBDIRS = ['lib/x86_64-linux-gnu', 'usr/lib/x86_64-linux-gnu', 'lib', 'usr/lib', 'lib64', 'usr/lib/x86_64-linux-gnu/inkscape',
           'usr/lib/firefox-esr', 'usr/lib/libreoffice/program', 'usr/lib/x86_64-linux-gnu/gedit', 'usr/lib/x86_64-linux-gnu/eog',
           'usr/lib/x86_64-linux-gnu/thunar', 'usr/lib/gnumeric/1.12.55', 'usr/lib/x86_64-linux-gnu/blender']


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


def elf_deps(path):
    """An ELF's DT_NEEDED names and its RUNPATH/RPATH directories (as written, $ORIGIN unexpanded)"""
    try:
        out = subprocess.run(['readelf', '-d', path], capture_output=True, text=True).stdout
    except Exception:
        return [], []
    needed = [l.split('[')[1].split(']')[0] for l in out.splitlines() if '(NEEDED)' in l]
    runpath = [d for l in out.splitlines() if '(RUNPATH)' in l or '(RPATH)' in l for d in l.split('[')[1].split(']')[0].split(':')]
    return needed, runpath


def needed(path):
    return elf_deps(path)[0]


# Libraries Debian only puts on the search path with update-alternatives (a postinst
# symlink /usr/lib/x86_64-linux-gnu/NAME -> DIR/NAME): found here, the link is recorded
# in the app's `links` and made by the installer
ALT_DIRS = ['usr/lib/x86_64-linux-gnu/blas', 'usr/lib/x86_64-linux-gnu/lapack', 'usr/lib/x86_64-linux-gnu/openblas-pthread']


def resolve(root, elf_rel, lib, links):
    """Where the dynamic linker finds `lib` for the ELF at `elf_rel` (relative to root): its
    RUNPATH, the standard directories, then alternatives (recording the link). None if absent."""
    _, runpath = elf_deps(os.path.join(root, elf_rel))
    origin = os.path.dirname(elf_rel)
    for d in runpath:
        d = os.path.normpath(d.replace('$ORIGIN', '/' + origin).replace('${ORIGIN}', '/' + origin)).lstrip('/')
        if os.path.lexists(os.path.join(root, d, lib)): return os.path.join(d, lib)
    for d in LIBDIRS:
        if os.path.lexists(os.path.join(root, d, lib)): return os.path.join(d, lib)
    for d in ALT_DIRS:
        if os.path.lexists(os.path.join(root, d, lib)):
            links['/usr/lib/x86_64-linux-gnu/' + lib] = '/' + os.path.join(d, lib)
            return os.path.join(d, lib)
    return None


def app_icon(root, binary, out_dir, app):
    """The app's icon (its .desktop file's Icon=) for the desktop's Apps sheet and
    dock: public/gui/icons/APP.(png|svg), or None (x11-apps have none)."""
    apps_dir = os.path.join(root, 'usr/share/applications')
    name = None
    if os.path.isdir(apps_dir):
        for d in sorted(os.listdir(apps_dir)):
            text = open(os.path.join(apps_dir, d), errors='replace').read()
            execs = [l.split('=', 1)[1].split()[0] for l in text.splitlines() if l.startswith('Exec=')]
            icons = [l.split('=', 1)[1].strip() for l in text.splitlines() if l.startswith('Icon=')]
            if icons and any(os.path.basename(e) == os.path.basename(binary) for e in execs):
                name = icons[0]; break
    if not name: return None
    name = name[:-4] if name.endswith(('.png', '.svg', '.xpm')) else name
    base = os.path.join(root, 'usr/share/icons/hicolor')
    for sub, ext, limit in (('128x128', 'png', 40000), ('scalable', 'svg', 40000), ('256x256', 'png', 40000),
                            ('96x96', 'png', 40000), ('64x64', 'png', 40000), ('48x48', 'png', 40000)):
        f = os.path.join(base, sub, 'apps', f'{name}.{ext}')
        if os.path.isfile(f) and os.path.getsize(f) <= limit:
            os.makedirs(out_dir, exist_ok=True)
            shutil.copyfile(f, os.path.join(out_dir, f'{app}.{ext}'))
            return f'gui/icons/{app}.{ext}'
    f = os.path.join(root, 'usr/share/pixmaps', f'{name}.png')
    if os.path.isfile(f) and os.path.getsize(f) <= 40000:
        os.makedirs(out_dir, exist_ok=True)
        shutil.copyfile(f, os.path.join(out_dir, f'{app}.png'))
        return f'gui/icons/{app}.png'
    return None


def main():
    index, cache, work, out = sys.argv[1:5]
    db, prov = load_index(index)
    os.makedirs(cache, exist_ok=True)
    packages = {}
    apps = {}
    for app, (roots, bins, plugins, extra, desc, kind) in APPS.items():
        # GTK icon themes (Adwaita's symbolic icons, GIMP's theme) are SVG: their pixbuf loader comes too
        if kind in ('gtk2', 'gtk3') and 'librsvg2-common' not in extra: extra = extra + ['librsvg2-common']
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
        links = {}
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
                hit = resolve(root, rel, lib, links)
                if hit: todo.append(hit)
        # Data packages (Architecture: all) only when a kept package depends on them
        core = {n for n in names if n in need or n in roots or n in extra or n in ALWAYS}
        def deps(n):
            for f in ('Pre-Depends', 'Depends'):
                for alt in db[n].get(f, '').split(','):
                    alt = alt.strip()
                    if alt:
                        d = alt.split('|')[0].strip().split(' ')[0].split(':')[0]
                        yield d if d in db else prov.get(d, d)
        data, todo3 = set(), list(core)
        while todo3:
            for d in deps(todo3.pop()):
                if d in names and d not in core and d not in data and db[d].get('Architecture') == 'all':
                    data.add(d); todo3.append(d)
        keep = [n for n in names if n in core or n in data]
        remove = []
        for g in OPTIONAL.get(app, []):
            for path in sorted(glob.glob(os.path.join(root, g))):
                rel = os.path.relpath(path, root)
                if not os.path.isfile(path) or os.path.islink(path): continue
                ok, seen2, todo2 = True, set(), [rel]
                while todo2 and ok:
                    f = todo2.pop()
                    if f in seen2: continue
                    seen2.add(f)
                    real = os.path.realpath(os.path.join(root, f))
                    o = owner.get(os.path.relpath(real, root)) or owner.get(f)
                    if o and o not in keep: ok = False; break
                    for lib in needed(real):
                        hit = resolve(root, os.path.relpath(real, root), lib, links)
                        if hit is None: ok = False; break
                        todo2.append(hit)
                if not ok: remove.append('/' + os.path.dirname(rel) if g.endswith('/*/*') else '/' + rel)
        dropped = [n for n in names if n not in keep]
        apps[app] = {
            'description': desc, 'toolkit': kind, 'bin': bins[0], 'pkg': roots[0], 'packages': keep,
            'size': sum(int(db[n]['Size']) for n in keep),
            'closureSize': sum(int(db[n]['Size']) for n in names),
            'dropped': dropped,
            **({'icon': icon} if (icon := app_icon(root, bins[0], os.path.join(os.path.dirname(out), 'icons'), app)) else {}),
            **({'remove': sorted(set(remove))} if remove else {}),
            **({'links': sorted([k, v] for k, v in links.items())} if links else {}),
            **({'home': HOME_FILES[app]} if app in HOME_FILES else {}),
        }
        for n in keep:
            d = db[n]
            packages[n] = {'version': d['Version'], 'filename': d['Filename'], 'sha256': d['SHA256'], 'size': int(d['Size'])}
        if remove: print(f"{app}: {len(set(remove))} optional plug-ins removed (their libraries are not in the startup set)", file=sys.stderr)
        print(f"{app:12s} keep {len(keep):3d} pkgs {apps[app]['size']/1e6:6.1f} MB (closure {len(names)} / {apps[app]['closureSize']/1e6:.1f} MB); dropped: {' '.join(dropped)}", file=sys.stderr)
    # Overlays: files a postinst would generate, built here once (architecture independent).
    # GLib's content-type sniffing (gdk-pixbuf picks image loaders by it) needs mime.cache;
    # update-mime-database itself would need libxml2 + ICU (10 MB) in the browser.
    overlays = []
    mime_app = next((a for a in apps if 'shared-mime-info' in apps[a]['packages']), None)
    if mime_app:
        src = os.path.join(work, mime_app, 'usr/share/mime')
        tmp = os.path.join(work, '_mime')
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.copytree(src, tmp)
        subprocess.run(['update-mime-database', tmp], check=True)
        data = open(os.path.join(tmp, 'mime.cache'), 'rb').read()
        h = hashlib.sha256(data).hexdigest()
        os.makedirs(os.path.join(os.path.dirname(out), 'overlay'), exist_ok=True)
        open(os.path.join(os.path.dirname(out), 'overlay', h), 'wb').write(data)
        overlays.append({'path': '/usr/share/mime/mime.cache', 'sha256': h, 'size': len(data), 'when': 'shared-mime-info'})
    # GTK reads a theme's icon-theme.cache instead of scanning its directories
    # (~0.7 s of every GTK 3 start in Blink); update-icon-caches makes it from
    # adwaita-icon-theme's postinst trigger. Not hicolor: apps add icons there.
    icon_app = next((a for a in apps if 'adwaita-icon-theme' in apps[a]['packages']), None)
    if icon_app:
        tmp = os.path.join(work, '_icons')
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.copytree(os.path.join(work, icon_app, 'usr/share/icons/Adwaita'), tmp, symlinks=True)
        subprocess.run(['gtk-update-icon-cache', '--force', '--quiet', tmp], check=True)
        data = open(os.path.join(tmp, 'icon-theme.cache'), 'rb').read()
        h = hashlib.sha256(data).hexdigest()
        open(os.path.join(os.path.dirname(out), 'overlay', h), 'wb').write(data)
        overlays.append({'path': '/usr/share/icons/Adwaita/icon-theme.cache', 'sha256': h, 'size': len(data), 'when': 'adwaita-icon-theme'})
    # The CA bundle update-ca-certificates builds from ca-certificates' Mozilla
    # certificates (its postinst): libcurl/OpenSSL read only the bundle.
    ca_app = next((a for a in apps if 'ca-certificates' in apps[a]['packages']), None)
    if ca_app:
        moz = os.path.join(work, ca_app, 'usr/share/ca-certificates/mozilla')
        data = b''.join(open(os.path.join(moz, f), 'rb').read().rstrip(b'\n') + b'\n' for f in sorted(os.listdir(moz)) if f.endswith('.crt'))
        h = hashlib.sha256(data).hexdigest()
        open(os.path.join(os.path.dirname(out), 'overlay', h), 'wb').write(data)
        overlays.append({'path': '/etc/ssl/certs/ca-certificates.crt', 'sha256': h, 'size': len(data), 'when': 'ca-certificates'})
        # ... and its hashed-name links (`openssl rehash`), for OpenSSL users that
        # only look certificates up by subject hash in /etc/ssl/certs (Dillo):
        # a tar overlay of symlinks, unpacked like a package.
        import io, tarfile
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w', format=tarfile.USTAR_FORMAT) as tar:
            seen = {}
            for f in sorted(os.listdir(moz)):
                if not f.endswith('.crt'): continue
                pem = f[:-4] + '.pem'
                hsh = subprocess.run(['openssl', 'x509', '-subject_hash', '-noout', '-in', os.path.join(moz, f)],
                                     check=True, capture_output=True, text=True).stdout.strip()
                n = seen.get(hsh, 0); seen[hsh] = n + 1
                for name, target in ((f'etc/ssl/certs/{pem}', f'/usr/share/ca-certificates/mozilla/{f}'), (f'etc/ssl/certs/{hsh}.{n}', pem)):
                    ti = tarfile.TarInfo(name); ti.type = tarfile.SYMTYPE; ti.linkname = target; ti.mode = 0o777
                    tar.addfile(ti)
        data = buf.getvalue()
        h = hashlib.sha256(data).hexdigest()
        open(os.path.join(os.path.dirname(out), 'overlay', h), 'wb').write(data)
        overlays.append({'path': '/', 'tar': True, 'sha256': h, 'size': len(data), 'when': 'ca-certificates'})
    # gdk-pixbuf's loaders.cache for libgdk-pixbuf-2.0-0's own loaders (the only
    # ones any app here has): gdk-pixbuf-query-loaders dlopen()s each loader, so
    # it is made in Blink (`gui install gpicview`, then copy
    # /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders.cache) and kept in
    # scripts/gui/overlays/. Regenerate it when libgdk-pixbuf-2.0-0 changes.
    lc = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'overlays', 'gdk-pixbuf-loaders.cache')
    if os.path.exists(lc) and any('libgdk-pixbuf-2.0-0' in a['packages'] for a in apps.values()):
        data = open(lc, 'rb').read()
        h = hashlib.sha256(data).hexdigest()
        open(os.path.join(os.path.dirname(out), 'overlay', h), 'wb').write(data)
        overlays.append({'path': '/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders.cache', 'sha256': h, 'size': len(data), 'when': 'libgdk-pixbuf-2.0-0'})
    # ... and with librsvg2-common's SVG loader too, applied after it when that package comes
    # (same way: `gui install inkscape`, then copy the file)
    lc = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'overlays', 'gdk-pixbuf-loaders-svg.cache')
    if os.path.exists(lc) and any('librsvg2-common' in a['packages'] for a in apps.values()):
        data = open(lc, 'rb').read()
        h = hashlib.sha256(data).hexdigest()
        open(os.path.join(os.path.dirname(out), 'overlay', h), 'wb').write(data)
        overlays.append({'path': '/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders.cache', 'sha256': h, 'size': len(data), 'when': 'librsvg2-common'})
    json.dump({'suite': SUITE, 'overlays': overlays, 'arch': 'amd64', 'mirror': 'https://deb.debian.org/debian/',
               'snapshot': 'https://snapshot.debian.org/archive/debian/20260712T000000Z/',
               'packages': packages, 'apps': apps}, open(out, 'w'), indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
