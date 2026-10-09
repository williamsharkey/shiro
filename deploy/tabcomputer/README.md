# tabcomputer.com

The Unix edition of Shiro (desktop UI, see `src/ui-mode.ts`) runs on its own
DigitalOcean droplet, `tabcomputer` (s-1vcpu-2gb-amd, nyc1; the plain
s-1vcpu-2gb size is retired). shiro.computer and its
droplet are not involved.

- **Setup:** the droplet was created with `cloud-init.yaml` as its user data.
  On first boot it installs node 22, nginx and certbot, and enables three
  systemd units: `tabcomputer` (server.mjs on :3000 behind nginx), the
  `tabcomputer-deploy.timer` and the `tabcomputer-cert.timer`.
- **Settings and build steps** live in this directory: `release.sh` builds a
  release and `profiles/tabcomputer/server.env` is the server's environment (TCP relay on, GitHub
  sign-in off for now). Both ship with the commit, so changing them is a push.
- **Deploy:** push a commit to the `deploy/tabcomputer` branch:
  `git push origin <commit>:refs/heads/deploy/tabcomputer`. Within about 2
  minutes the droplet notices, runs `npm ci && npm run build`, and switches
  `/opt/tabcomputer/current` to the new release; building takes several
  minutes on this size. `https://tabcomputer.com/deployed.txt` shows the live
  commit. A commit whose build fails is recorded in `/opt/tabcomputer/FAILED_SHA`
  and skipped; the previous release keeps serving. The last 3 releases are kept.
- **TLS:** `tabcomputer-cert` waits until tabcomputer.com and www resolve to
  the droplet, then runs `certbot --nginx --redirect` once. certbot's own
  timer renews it.
- **DNS** is at Porkbun: A records for `tabcomputer.com` and
  `*.tabcomputer.com` point at the droplet. Email forwarding (MX/SPF) is
  Porkbun's.
