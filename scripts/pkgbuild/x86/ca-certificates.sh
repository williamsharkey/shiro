#!/usr/bin/env bash
# Mozilla's CA certificate bundle, as extracted by the curl project (MPL-2.0)
# -> etc/ssl/certs/ca-certificates.crt
. "$(dirname "$0")/common.sh"
DATE=2026-09-25
PEM=$(fetch https://curl.se/ca/cacert-$DATE.pem a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505)
mkdir -p "$PKG_OUT/ca-certificates/etc/ssl/certs"
cp "$PEM" "$PKG_OUT/ca-certificates/etc/ssl/certs/ca-certificates.crt"
