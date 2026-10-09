#!/usr/bin/env bash
# OpenSSH 10.6p1 (BSD) client tools with OpenSSL 3.5 and zlib -> static x86-64
# ssh, scp, sftp, ssh-keygen, ssh-agent, ssh-add, ssh-keyscan
. "$(dirname "$0")/common.sh"
VERSION=10.6p1
SRC=$(unpack "$(fetch https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/openssh-$VERSION.tar.gz a9dc9565dffe8640f64d863cd29a32bc4a3dbdec0566a7fc44c5d6ee767d5f39)" openssh-$VERSION)
setup_musl
deps_zlib
deps_openssl
# The client finds its config in /etc/ssh; keys and known_hosts in ~/.ssh
configure_make "$SRC" --sysconfdir=/etc/ssh --with-ssl-dir="$SYSROOT" --with-zlib="$SYSROOT" --without-pam --without-selinux \
  --without-pie --without-kerberos5 --without-libedit --without-security-key-builtin --disable-strip --disable-lastlog --disable-utmp \
  --disable-utmpx --disable-wtmp --disable-wtmpx --with-privsep-path=/var/empty --with-pid-dir=/run \
  CPPFLAGS="-I$SYSROOT/include" LDFLAGS="-L$SYSROOT/lib -static -no-pie"
rm -rf "$PKG_OUT/openssh"
for p in ssh scp sftp ssh-keygen ssh-agent ssh-add ssh-keyscan; do install_bin "$SRC/$p" openssh/bin/$p; done

# Manual pages (man, from pkg install mandoc)
install_man openssh "$SRC/ssh.1" "$SRC/scp.1" "$SRC/sftp.1" "$SRC/ssh-keygen.1" "$SRC/ssh-agent.1" "$SRC/ssh-add.1" "$SRC/ssh-keyscan.1" "$SRC/ssh_config.5"
