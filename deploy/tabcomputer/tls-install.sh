#!/bin/bash
# Install the wildcard certificate for *.tabcomputer.com and *.web.tabcomputer.com
# (browse origins, docs/BROWSER.md). It is issued off the droplet (DNS-01; the
# DNS keys never come here) and committed as deploy/tabcomputer/tls/bundle.cms,
# encrypted to this droplet's own key (made at first boot by cloud-init; its
# certificate is public at /_deploy/tls-recipient.crt). Called by release.sh;
# never fails the release.
#   tls-install.sh <src checkout>
set -u
src=$1
bundle=$src/deploy/tabcomputer/tls/bundle.cms
key=/etc/tabcomputer/tls-recipient.key
crt=/var/www/tabdeploy/tls-recipient.crt
dest=/etc/tabcomputer/tls
[ -f "$bundle" ] && [ -f "$key" ] || { echo "tls: no bundle or no recipient key; skipped"; exit 0; }
want=$(sha256sum "$bundle" | cut -d' ' -f1)
[ "$want" != "$(cat $dest/BUNDLE_SHA 2>/dev/null)" ] || exit 0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if ! openssl cms -decrypt -binary -inform PEM -in "$bundle" -inkey "$key" -recip "$crt" | tar -x -C "$tmp"; then
  echo "tls: bundle is not for this droplet's key; skipped"; exit 0
fi
openssl x509 -in "$tmp/fullchain.pem" -noout -checkend 86400 || { echo "tls: certificate expired or invalid; skipped"; exit 0; }
[ "$(openssl x509 -in "$tmp/fullchain.pem" -noout -pubkey | sha256sum)" = "$(openssl pkey -in "$tmp/privkey.pem" -pubout | sha256sum)" ] || { echo "tls: key does not match certificate; skipped"; exit 0; }
mkdir -p "$dest.new" && install -m 0644 "$tmp/fullchain.pem" "$dest.new/" && install -m 0600 "$tmp/privkey.pem" "$dest.new/"
echo "$want" > "$dest.new/BUNDLE_SHA"
rm -rf "$dest.old"; [ -d "$dest" ] && mv "$dest" "$dest.old"; mv "$dest.new" "$dest"
cat > /etc/nginx/sites-available/tabcomputer-wild <<'NGINX'
# *.tabcomputer.com and *.web.tabcomputer.com (browse origins), with the
# wildcard certificate from tls-install.sh. Exact names (tabcomputer.com, www)
# stay on the certbot-managed block.
server {
  listen 80;
  listen [::]:80;
  server_name *.tabcomputer.com;
  return 301 https://$host$request_uri;
}
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  http2 on;
  server_name *.tabcomputer.com;
  ssl_certificate /etc/tabcomputer/tls/fullchain.pem;
  ssl_certificate_key /etc/tabcomputer/tls/privkey.pem;
  client_max_body_size 100m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/tabcomputer-wild /etc/nginx/sites-enabled/tabcomputer-wild
if nginx -t 2>&1; then systemctl reload nginx; echo "tls: installed certificate, expires $(openssl x509 -in $dest/fullchain.pem -noout -enddate | cut -d= -f2)"
else rm -f /etc/nginx/sites-enabled/tabcomputer-wild; echo "tls: nginx rejected the config; wildcard site disabled"; fi
