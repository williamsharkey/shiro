# oils spec tests (vendored subset)

Shell conformance cases from [oils-for-unix/oils](https://github.com/oils-for-unix/oils)
`spec/`, commit `57d3f0d088c36340bc4b3038208e58ea02acf15c`, Apache-2.0
(LICENSE.txt). Only the POSIX/bash files listed in `FILES` and the
`spec/testdata` files they source are copied, unmodified: the first 62 are
POSIX and core bash; the rest (from `var-op-bash` on) are the bash features
real scripts use (`${x@Q}`, namerefs, `declare -p`, trap DEBUG/ERR/RETURN,
BASH_SOURCE/FUNCNAME, extglob, pushd/popd, umask...). The ysh, OSH-only and
interactive files (completion, history, prompt, bind) are left out.

`bash-baseline.json` lists the cases that real bash passes under our judge
(`tests/conformance/lib/oils-spec.mjs`); only those are scored for Shiro.
Bash runs each case as a script file (`bash FILE`, outside the case's
directory), as Shiro's harness does: `bash -c` differs in FUNCNAME's "main"
frame, BASH_SOURCE and a few status codes.
Regenerate it with `node scripts/conformance/oils-bash-baseline.mjs`
(needs bash and python3 on the host).
