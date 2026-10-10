#!/bin/sh
# Builds public/gui/lib/libshiro-text-hook.so (x86-64, loaded by GTK apps in Blink).
# It may only need symbols Debian 12's glibc (2.36) has: checked below.
set -e
cd "$(dirname "$0")"
out=../../../public/gui/lib/libshiro-text-hook.so
mkdir -p "$(dirname "$out")"
gcc -shared -fPIC -O2 -Wall -Wextra -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 -fno-stack-protector \
  -Wl,--hash-style=both -Wl,-z,norelro -o "$out" shiro-text-hook.c -ldl
strip "$out"
objdump -T "$out" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 | awk '{ split($1, v, /[_.]/); if (v[2] > 2 || v[3] > 36) { print "needs " $1 " (Debian 12 has 2.36)"; exit 1 } else print "max " $1 }'
ls -l "$out"

# The Qt 5 one (libshiro-qt-text-hook.so) builds against Debian 12's own Qt
# 5.15 headers and libraries, fetched once (pinned by SHA-256) into $QT_DEV.
QT_DEV=${QT_DEV:-${TMPDIR:-/tmp}/shiro-qt-dev}
mkdir -p "$QT_DEV/debs" "$QT_DEV/root" "$QT_DEV/lib"
while read -r file sha; do
  deb="$QT_DEV/debs/$(basename "$file")"
  [ -f "$deb" ] || curl -sSfo "$deb" "https://deb.debian.org/debian/$file"
  echo "$sha  $deb" | sha256sum -c --quiet
  dpkg-deb -x "$deb" "$QT_DEV/root"
done <<'DEBS'
pool/main/q/qtbase-opensource-src/qtbase5-dev_5.15.8+dfsg-11+deb12u3_amd64.deb 2b50de948dd43dce43dcd58033ef3bfc4a549b33fc9f9a3818e35a26f979802b
pool/main/q/qtbase-opensource-src/libqt5core5a_5.15.8+dfsg-11+deb12u3_amd64.deb 47e82f69aa0724f33d0873294d66664ef13fe09c0bffb0a1d84f2ad3e2dab58e
pool/main/q/qtbase-opensource-src/libqt5gui5_5.15.8+dfsg-11+deb12u3_amd64.deb b67011ee1822232564543d94f221584895fc03f536c4394d830ce7c8e0345f0c
pool/main/q/qtbase-opensource-src/libqt5widgets5_5.15.8+dfsg-11+deb12u3_amd64.deb ea5d73c2935d0bd27d4da43572dabc95af9ffa0538bababd5eeb8f679e9eb335
DEBS
for n in Core Gui Widgets; do ln -sf "$QT_DEV/root/usr/lib/x86_64-linux-gnu/libQt5$n.so.5" "$QT_DEV/lib/libQt5$n.so"; done
Q="$QT_DEV/root/usr/include/x86_64-linux-gnu/qt5"
qout=../../../public/gui/lib/libshiro-qt-text-hook.so
g++ -shared -fPIC -O2 -Wall -Wextra -std=c++17 -fno-exceptions -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 -fno-stack-protector \
  -I"$Q" -I"$Q/QtCore" -I"$Q/QtGui" -I"$Q/QtWidgets" -Wl,--hash-style=both -Wl,-z,norelro -o "$qout" shiro-qt-text-hook.cpp \
  -L"$QT_DEV/lib" -lQt5Widgets -lQt5Gui -lQt5Core -ldl -Wl,--allow-shlib-undefined
strip "$qout"
objdump -T "$qout" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 | awk '{ split($1, v, /[_.]/); if (v[2] > 2 || v[3] > 36) { print "needs " $1 " (Debian 12 has 2.36)"; exit 1 } else print "max " $1 }'
ls -l "$qout"
