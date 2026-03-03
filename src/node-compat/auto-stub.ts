/**
 * Auto-stub proxy for graceful degradation of unknown module properties.
 * Prevents "Class extends undefined" and similar errors.
 * Extracted from node-cmd.ts createAutoStub().
 */

export function createAutoStubFactory(): { createAutoStub: (modPath: string, target: any) => any } {
  let _autoStubDepth = 0;

  function createAutoStub(modPath: string, target: any): any {
    const stubCache = new Map<string, any>();
    return new Proxy(target, {
      get(t, prop, receiver) {
        if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver);
        _autoStubDepth++;
        if (_autoStubDepth > 500) {
          _autoStubDepth--;
          console.error(`[AutoStub] DEPTH OVERFLOW on ${modPath}.${String(prop)} depth=${_autoStubDepth}`);
          return undefined;
        }
        try {
          const val = Reflect.get(t, prop, receiver);
          if (val !== undefined) return val;
        } finally {
          _autoStubDepth--;
        }
        // Don't stub internal/common props
        if (prop === 'then' || prop === 'toJSON' || prop === '__esModule' || prop === 'default' || prop.startsWith('_')) return undefined;
        // Return cached stub
        if (stubCache.has(prop)) return stubCache.get(prop);
        // Create a stub class/function that can be extended and called
        const stubClass = class StubClass {
          constructor(..._args: any[]) {}
          static [Symbol.hasInstance](_inst: any) { return false; }
        };
        // Make it callable as a function too
        let _stubCallCount = 0;
        const stub: any = function(...args: any[]) {
          _stubCallCount++;
          if (_stubCallCount > 50) return undefined; // Safety bail for infinite recursion
          // For sync functions that return values, return sensible defaults
          if (prop.endsWith('Sync')) return '';
          if (prop === 'constants') return {};
          return stub;
        };
        // Copy class prototype so it works with extends
        Object.setPrototypeOf(stub, stubClass);
        stub.prototype = stubClass.prototype;
        stubCache.set(prop, stub);
        return stub;
      }
    });
  }

  return { createAutoStub };
}
