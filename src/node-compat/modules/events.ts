export function createEventsModule(): any {
  class EventEmitter {
    _events: Record<string, Function[]> = {};
    _maxListeners: number = 10;
    on(event: string, fn: Function) { (this._events[event] ??= []).push(fn); return this; }
    addListener(event: string, fn: Function) { return this.on(event, fn); }
    off(event: string, fn: Function) { this._events[event] = (this._events[event] || []).filter(f => f !== fn); return this; }
    removeListener(event: string, fn: Function) { return this.off(event, fn); }
    emit(event: string, ...args: any[]) { (this._events[event] || []).forEach(fn => fn(...args)); return true; }
    once(event: string, fn: Function) {
      const wrapper = (...args: any[]) => { this.off(event, wrapper); fn(...args); };
      return this.on(event, wrapper);
    }
    prependListener(event: string, fn: Function) { (this._events[event] ??= []).unshift(fn); return this; }
    removeAllListeners(event?: string) { if (event) delete this._events[event]; else this._events = {}; return this; }
    listeners(event: string) { return [...(this._events[event] || [])]; }
    rawListeners(event: string) { return [...(this._events[event] || [])]; }
    listenerCount(event: string) { return (this._events[event] || []).length; }
    eventNames() { return Object.keys(this._events); }
    setMaxListeners(n: number) { this._maxListeners = n; return this; }
    getMaxListeners() { return this._maxListeners; }
  }
  // The events module default export IS EventEmitter (allows `class Foo extends require('events')`)
  const mod: any = EventEmitter;
  mod.EventEmitter = EventEmitter;
  mod.default = EventEmitter;
  // Static helpers used by some libraries
  mod.once = async (emitter: any, event: string) => {
    return new Promise<any[]>((resolve) => {
      emitter.once(event, (...args: any[]) => resolve(args));
    });
  };
  mod.on = (emitter: any, event: string) => {
    const events: any[] = [];
    emitter.on(event, (...args: any[]) => events.push(args));
    return { [Symbol.asyncIterator]: async function*() { while (true) { if (events.length) yield events.shift(); else await new Promise(r => setTimeout(r, 10)); } } };
  };
  mod.getEventListeners = (emitter: any, event: string) => emitter.listeners?.(event) || [];
  mod.getMaxListeners = (emitter: any) => emitter.getMaxListeners?.() || 10;
  mod.setMaxListeners = (n: number, ...emitters: any[]) => { emitters.forEach(e => e.setMaxListeners?.(n)); };
  mod.defaultMaxListeners = 10;
  mod.listenerCount = (emitter: any, event: string) => emitter.listenerCount?.(event) || 0;
  return mod;
}
