/**
 * The node suites with node as a kernel guest in a Worker (the default in
 * the browser where the page can; vitest has no Worker of its own, so the
 * main config runs node in the page). `npm run test:worker`.
 */
import base from './vitest.config';

// (spelled out, not mergeConfig: that would add these lists to the base config's)
export default {
  ...base,
  test: {
    ...base.test,
    setupFiles: [...(base.test?.setupFiles as string[]), './tests/shiro-vitest/worker-mode-setup.ts'],
    include: [
      'tests/shiro-vitest/node-*.test.ts',
      'tests/shiro-vitest/npm-*.test.ts',
      'tests/shiro-vitest/phase16-npm-packages.test.ts',
      'tests/shiro-vitest/agent-*.test.ts',
      'tests/shiro-vitest/claude-*.test.ts',
      'tests/shiro-vitest/compat-dev.test.ts',
    ],
    // (the page's own runtime: scripts overlapping in its globals, which a guest doesn't share)
    exclude: [...(base.test?.exclude ?? []), 'tests/shiro-vitest/node-overlap.test.ts'],
  },
};
