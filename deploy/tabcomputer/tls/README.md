# Wildcard certificate (encrypted)

`bundle.cms` is the Let's Encrypt certificate for `tabcomputer.com`,
`*.tabcomputer.com` and `*.web.tabcomputer.com` (fullchain.pem and privkey.pem
in a tar), encrypted with CMS to the droplet's own key. Only that droplet can
read it. `deploy/tabcomputer/tls-install.sh` installs it on deploy.

Renewing (every ~60 days; the certificate lasts 90): issue it again with DNS-01
off the droplet, fetch the droplet's recipient certificate from
`https://tabcomputer.com/_deploy/tls-recipient.crt`, then
`tar -c fullchain.pem privkey.pem | openssl cms -encrypt -binary -aes256 -outform PEM -out bundle.cms recipient.crt`
and push it to the deploy branch. A replaced droplet has a new key, so the
bundle has to be encrypted again for it.
