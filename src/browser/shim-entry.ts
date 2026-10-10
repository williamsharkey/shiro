// /__tc/shim.js: shim.ts for workers. The broker starts a rewritten worker
// script with importScripts() or import of this file; the worker's own
// location names its browse origin, which is all the shim needs.
import { OriginMap, templateFromBrowseOrigin } from './origin-map';
import { installShim } from './shim';

const g = globalThis as any;
const template = templateFromBrowseOrigin(g.location.origin);
if (template) installShim(g, new OriginMap(template));
