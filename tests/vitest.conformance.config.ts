import base from './vitest.config';

// Conformance suites (npm run conformance). Same environment as the unit
// suite; only the file set differs.
const config: any = { ...base, test: { ...(base as any).test } };
config.test.include = ['conformance/**/*.conf.ts'];
config.test.exclude = [];
config.test.testTimeout = 1_800_000;
export default config;
