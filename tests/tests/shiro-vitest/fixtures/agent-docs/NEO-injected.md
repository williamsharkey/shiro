# NEO.md

This Shiro instance was spawned from a host page.

- Mode: seed blob injection
- Host page: https://example.com/feed
- Host origin: https://example.com
- Host title: Example
- Host DOM bridge: available via `hc outer`
- Same-origin parent DOM access: yes

Start with:

1. Run `hc outer`
2. Then use `hc s`, `hc look`, `hc q <selector>`, `hc @0`

Notes:

- `hc live` inspects Shiro's own DOM, not the host page
- Prefer `hc outer` for host-page inspection even in blob mode
- Machine-readable details are in `/home/user/.shiro-context.json`
