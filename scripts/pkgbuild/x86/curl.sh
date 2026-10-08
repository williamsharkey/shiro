#!/usr/bin/env bash
# curl 8.22 (curl license, MIT-like) with OpenSSL and zlib -> static x86-64 curl
# Certificates: /etc/ssl/certs/ca-certificates.crt (pkg install ca-certificates)
. "$(dirname "$0")/common.sh"
setup_musl
deps_curl
install_bin "$PKG_WORK/build/curl-$CURL_VERSION/src/curl" curl/bin/curl
