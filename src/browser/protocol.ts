// Messages between a browse origin's service worker / page runtime and the
// Browser app's broker (docs/BROWSER.md, "Moving parts"). Types only.

export type HeaderPairs = [string, string][];

/** SW → broker, over a MessagePort the broker bound to one document. */
export interface FetchMsg {
  type: 'fetch';
  id: number;
  url: string;              // the real URL
  method: string;
  headers: HeaderPairs;
  body: ArrayBuffer | null;
  mode: RequestMode;
  destination: RequestDestination;
  credentials: RequestCredentials;
  redirect: RequestRedirect;
  referrer: string;         // real URL, or '' / 'about:client'
  referrerPolicy: ReferrerPolicy;
  /** A navigation of the document this port is bound to. */
  navigation: boolean;
}

export interface ResponseMsg {
  type: 'response';
  id: number;
  status: number;
  statusText: string;
  headers: HeaderPairs;
  /** A transferred stream, or bytes. */
  body: ReadableStream<Uint8Array> | ArrayBuffer | null;
  url: string;              // final real URL
  redirected: boolean;
}

/** A navigation answered with a redirect: the shell goes to the browse URL of `location`. */
export interface RedirectMsg { type: 'redirect'; id: number; location: string }

export interface ErrorMsg {
  type: 'error';
  id: number;
  message: string;
  /** Why the app suggests "Open in a real tab" (tls-version, webauthn, google-signin, unproxyable, ...). */
  fallback?: string;
}

export type BrokerReply = ResponseMsg | RedirectMsg | ErrorMsg;

/** Page runtime → broker (its own port). */
export type ClientMsg =
  | { type: 'cookie-set'; url: string; cookie: string }
  | { type: 'cookie-get'; id: number; url: string }
  | { type: 'open-tab'; url: string }
  | { type: 'fallback'; reason: string; url: string }
  | { type: 'title'; title: string }
  | { type: 'url'; url: string }
  | { type: 'ws-open'; id: number; url: string; protocols: string[] }
  | { type: 'ws-send'; id: number; data: string | ArrayBuffer }
  | { type: 'ws-close'; id: number; code?: number; reason?: string }
  | { type: 'unproxyable'; url: string };

/** Broker → page runtime. */
export type BrokerToClient =
  | { type: 'cookie'; id: number; value: string }
  | { type: 'ws-event'; id: number; event: 'open'; protocol: string; extensions: string }
  | { type: 'ws-event'; id: number; event: 'message'; data: string | ArrayBuffer }
  | { type: 'ws-event'; id: number; event: 'error' }
  | { type: 'ws-event'; id: number; event: 'close'; code: number; reason: string; wasClean: boolean };

/** window.postMessage between documents on browse origins and the app (always with an exact targetOrigin). */
export interface HelloMsg {
  tc: 'hello';
  /** The real URL the document is (or is about to be) showing. */
  url: string;
  /** 'sw': a port for the service worker; 'client': a port for the page runtime. */
  role: 'sw' | 'client';
}
