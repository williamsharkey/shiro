#!/usr/bin/env bash
# Vim 9.2 (Vim license, GPL-compatible) -> static x86-64 vim (huge features, no GUI/X11)
# plus its runtime files (syntax, ftplugin, indent, colors, doc) under share/vim/vim92.
. "$(dirname "$0")/common.sh"
TAG=v9.2.0000
SRC=$(fetch_git https://github.com/vim/vim.git $TAG e7e21018fc0b60c153c8e668f696d95e574cc5a4 vim-${TAG#v})
setup_musl
deps_ncurses
cd "$SRC"
# configure's cross-compile checks need answers it can't run
export vim_cv_toupper_broken=no vim_cv_terminfo=yes vim_cv_tgetent=zero vim_cv_tty_group=world \
  vim_cv_getcwd_broken=no vim_cv_stat_ignores_slash=no vim_cv_memmove_handles_overlap=yes \
  vim_cv_bcopy_handles_overlap=yes vim_cv_memcpy_handles_overlap=no \
  vim_cv_timer_create=no vim_cv_timer_create_with_lrt=no ac_cv_sizeof_int=4 ac_cv_small_wchar_t=no
./configure --host=$HOST --prefix=/usr --with-features=huge --enable-multibyte \
  --disable-gui --without-x --disable-xsmp --disable-netbeans --disable-channel --disable-gpm \
  --disable-sysmouse --disable-canberra --disable-libsodium --disable-selinux --disable-smack \
  --with-tlib=ncursesw --with-compiledby=shiro \
  LIBS="-lncursesw" >configure.log
make -j"$(nproc)" >make.log
install_bin src/vim vim/bin/vim
# The runtime: what :syntax on, filetype plugins, :help and colorschemes read
RT="$PKG_OUT/vim/share/vim/vim92"
rm -rf "$RT" && mkdir -p "$RT"
(cd runtime && cp -r autoload colors compiler doc ftplugin indent keymap lang macros pack plugin print spell syntax tutor \
  defaults.vim evim.vim filetype.vim ftoff.vim ftplugin.vim ftplugof.vim indent.vim indoff.vim menu.vim \
  optwin.vim scripts.vim synmenu.vim delmenu.vim "$RT"/ 2>/dev/null || true)
rm -rf "$RT/spell"/*.{latin1,utf-8}.{spl,sug} "$RT/lang"/*.po 2>/dev/null || true
(cd "$PKG_OUT/vim" && "$SRC/src/vim" -u NONE -es -c 'helptags share/vim/vim92/doc' -c q >/dev/null 2>&1 || true)
