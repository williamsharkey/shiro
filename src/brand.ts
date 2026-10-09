/**
 * The Unix edition's name, in one place (src/brand.json, which server.mjs
 * also reads to title the app shell and set its meta tags). shiro.computer
 * keeps its own name; this brand goes with the desktop UI (src/ui-mode.ts).
 */
import brand from './brand.json';

export const BRAND: Readonly<{ name: string; domain: string; tagline: string; description: string }> = brand;
