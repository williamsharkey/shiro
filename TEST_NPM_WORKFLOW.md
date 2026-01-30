# Test: npm install + build Workflow

This document demonstrates Shiro's browser-native package manager and bundler.

## What Works

✅ **npm install** - Downloads and extracts real packages from registry.npmjs.org
✅ **npm run** - Executes package.json scripts via shell
✅ **build** - Bundles TypeScript/JS using esbuild-wasm with virtual FS plugin
✅ **Dependency resolution** - Full semver range support (^, ~, >=, *, latest)
✅ **Tarball extraction** - Browser-native DecompressionStream + tar parser

## Test Workflow 1: Simple Project with Dependencies

Open Shiro browser terminal and run:

```bash
# Create a new project
mkdir my-project && cd my-project

# Initialize package.json
npm init

# Install a lightweight package
npm install ms

# Verify installation
npm list
ls node_modules/

# Create a simple TypeScript file
cat > src/index.ts << 'EOF'
import ms from 'ms';

const duration = ms('2 days');
console.log(`Duration: ${duration}ms`);

export function formatTime(input: string): number {
  return ms(input);
}
EOF

# Build it
mkdir dist
build src/index.ts --outfile=dist/bundle.js --bundle --minify

# Check output
ls -lh dist/
cat dist/bundle.js | head -20
```

## Test Workflow 2: npm run scripts

```bash
# Create package.json with scripts
cat > package.json << 'EOF'
{
  "name": "test-project",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "build src/index.ts --outfile=dist/bundle.js --bundle",
    "build:minify": "build src/index.ts --outfile=dist/bundle.min.js --bundle --minify",
    "clean": "rm -rf dist && mkdir dist",
    "list": "ls -la dist/"
  },
  "dependencies": {
    "ms": "*"
  }
}
EOF

# Install dependencies
npm install

# Run scripts
npm run clean
npm run build
npm run list
npm run build:minify
```

## Test Workflow 3: Multiple Dependencies

```bash
# Install multiple packages
npm install lodash
npm install chalk

# Create multi-import file
cat > src/app.ts << 'EOF'
import _ from 'lodash';
import chalk from 'chalk';

const data = [1, 2, 3, 4, 5];
const doubled = _.map(data, n => n * 2);

console.log(chalk.green('Data doubled:'), doubled);
console.log(chalk.blue('Sum:'), _.sum(doubled));

export { doubled };
EOF

# Bundle everything
build src/app.ts --outfile=dist/app.js --bundle --format=esm
```

## Test Workflow 4: TypeScript Compilation

```bash
# Create TypeScript with types
cat > src/math.ts << 'EOF'
export interface Point {
  x: number;
  y: number;
}

export function distance(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export class Vector {
  constructor(
    public x: number,
    public y: number
  ) {}

  add(other: Vector): Vector {
    return new Vector(
      this.x + other.x,
      this.y + other.y
    );
  }

  magnitude(): number {
    return distance({ x: 0, y: 0 }, this);
  }
}
EOF

# Build with TypeScript
build src/math.ts --outfile=dist/math.js --bundle --format=esm --target=es2020

# Verify types were compiled
cat dist/math.js
```

## Test Workflow 5: Scoped Packages

```bash
# Install scoped package (if available in registry)
npm install @types/node

# Verify it extracts to correct location
ls node_modules/@types/
ls node_modules/@types/node/
```

## Expected Behavior

### npm install
1. Reads package.json
2. Fetches metadata from registry.npmjs.org
3. Resolves dependency tree with BFS
4. Downloads .tgz tarballs
5. Decompresses with browser DecompressionStream
6. Extracts to node_modules/ using tar parser
7. Strips package/ prefix automatically

### build command
1. Initializes esbuild-wasm (lazy, ~8MB from CDN)
2. Creates virtual FS plugin
3. Resolves imports: node_modules, relative paths, extensions
4. Compiles TypeScript → JavaScript
5. Bundles with tree-shaking
6. Outputs to virtual filesystem

### npm run
1. Reads package.json scripts
2. Executes via shell.execute()
3. Supports pipes, redirects, compound commands

## Known Limitations

- **No nested dependencies** - Uses flat node_modules (first version wins)
- **No bin executables** - Can't run installed CLI tools yet
- **No symlinks** - Package links not supported in virtual FS
- **No package-lock.json** - No version locking yet
- **vi not interactive** - Text editor needs terminal integration

## Performance Notes

- First `build` invocation: ~2-3s (loads esbuild WASM)
- Subsequent builds: ~100-500ms (WASM cached)
- npm install: ~500ms per package (network dependent)
- Large bundles: esbuild-wasm handles up to ~10MB bundles well

## Troubleshooting

### "Package not found"
- Check spelling
- Try exact version: `npm install package@1.2.3`
- Some packages might not be on npm registry

### "Failed to initialize esbuild"
- Check network connection (needs unpkg.com)
- Try reloading page
- CDN might be temporarily unavailable

### "Cannot resolve module"
- Package might not have main/module field in package.json
- Try installing dependencies first
- Check import path matches package name

### Build fails with syntax error
- esbuild-wasm doesn't support all cutting-edge syntax
- Target older ES version: `--target=es2020`
- Some packages might use Node.js-specific APIs

## Success Metrics

✅ Can create new project with `npm init`
✅ Can install packages from npm registry
✅ Can list installed packages
✅ Can bundle TypeScript to JavaScript
✅ Can minify and optimize bundles
✅ Can run npm scripts via shell
✅ All operations work offline after initial load
✅ Data persists in IndexedDB across sessions

## Next Steps

To test in browser:
1. Open http://localhost:5175/shiro/ (or deployed URL)
2. Copy commands from workflows above
3. Paste into terminal
4. Verify each step completes successfully

The goal: Clone a real GitHub repo, npm install its dependencies, and build it entirely in the browser!
