# Tests

Shiro's unit and integration tests live in the **windwalker** repo:

```bash
cd ../windwalker
npm install
npm run test:shiro
```

Windwalker uses **linkedom** for DOM polyfills, which eliminates the
`window is not defined` errors that occurred when running tests in bare Node.js.

Test files: `windwalker/tests/shiro-vitest/`

## What's here

The `interactive/` subdirectory contains browser-based tests that run
via skyeyes (not vitest). See `interactive/README.md`.
