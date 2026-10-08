# oils spec tests (vendored subset)

Shell conformance cases from [oils-for-unix/oils](https://github.com/oils-for-unix/oils)
`spec/`, commit `57d3f0d088c36340bc4b3038208e58ea02acf15c`, Apache-2.0
(LICENSE.txt). Only the POSIX/bash files listed in `FILES` and the
`spec/testdata` files they source are copied, unmodified.

`bash-baseline.json` lists the cases that real bash passes under our judge
(`tests/conformance/lib/oils-spec.mjs`); only those are scored for Shiro.
Regenerate it with `node scripts/conformance/oils-bash-baseline.mjs`
(needs bash and python3 on the host).
