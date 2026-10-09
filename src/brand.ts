/**
 * The product name the desktop shows: the active profile's brand
 * (profiles/<id>/profile.json, src/profile.ts; server.mjs reads the same file
 * to title the app shell and set its meta tags). A profile without one
 * (shiro.computer keeps its own name on the terminal UI) still gets the Unix
 * edition's when it opens the desktop (?ui=desktop).
 */
import { activeProfile, PROFILES, type Brand } from './profile';

const fallback = PROFILES.find((p) => p.brand)!.brand!;

export const BRAND: Readonly<Brand> = activeProfile().brand ?? fallback;
