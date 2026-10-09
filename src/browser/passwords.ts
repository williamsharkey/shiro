// The Browser app's password vault (docs/BROWSER.md, "Passwords").
//
// - Encrypted at rest on the app's origin: AES-256-GCM under a key derived
//   from the user's passphrase (PBKDF2-SHA-256, 600 000 iterations, random
//   salt). Nothing leaves the device; no browse origin can read it.
// - Import from CSV exports (Google Password Manager / Chrome, Bitwarden,
//   1Password, Firefox, or any file with url/username/password columns).
// - Re-importing merges: entries match on normalized origin + username;
//   changed passwords update with the old one kept in history; new entries
//   are added; entries that disappeared from that source are flagged for
//   review, never deleted. The plan is shown as a diff before it is applied.

export interface PasswordEntry {
  id: string;
  origin: string;           // normalized: https://example.com, android://…
  url: string;              // as imported
  name: string;
  username: string;
  password: string;
  note: string;
  /** Imports this entry came from ("google", "bitwarden", …), or "manual"/"saved". */
  sources: string[];
  created: number;
  updated: number;
  history: { password: string; until: number }[];
  /** Set when a re-import from `source` no longer contained the entry. */
  review?: { source: string; since: number };
}

export interface ImportedRow { url: string; name: string; username: string; password: string; note: string }

export type CsvFormat = 'google' | 'bitwarden' | '1password' | 'firefox' | 'generic';

// ── CSV ──

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF/LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
      continue;
    }
    if (c === '"' && field === '') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

const COLS: Record<Exclude<CsvFormat, 'generic'>, { detect: string[]; url: string; name?: string; username: string; password: string; note?: string; type?: string }> = {
  bitwarden: { detect: ['login_uri', 'login_username', 'login_password'], url: 'login_uri', name: 'name', username: 'login_username', password: 'login_password', note: 'notes', type: 'type' },
  firefox: { detect: ['url', 'username', 'password', 'formactionorigin'], url: 'url', username: 'username', password: 'password' },
  '1password': { detect: ['title', 'url', 'username', 'password'], url: 'url', name: 'title', username: 'username', password: 'password', note: 'notes' },
  google: { detect: ['name', 'url', 'username', 'password'], url: 'url', name: 'name', username: 'username', password: 'password', note: 'note' },
};

export function detectFormat(header: string[]): CsvFormat {
  const h = header.map((x) => x.trim().toLowerCase());
  for (const f of ['bitwarden', 'firefox', '1password', 'google'] as const) if (COLS[f].detect.every((c) => h.includes(c))) return f;
  return 'generic';
}

/** Rows from a password-manager CSV export; rows without a password or a site are skipped and counted. */
export function readExport(text: string): { format: CsvFormat; rows: ImportedRow[]; skipped: number } {
  const all = parseCsv(text);
  if (!all.length) return { format: 'generic', rows: [], skipped: 0 };
  const header = all[0].map((x) => x.trim().toLowerCase());
  const format = detectFormat(all[0]);
  const idx = (name?: string) => (name ? header.indexOf(name) : -1);
  let map: { url: number; name: number; username: number; password: number; note: number; type: number };
  if (format === 'generic') {
    const find = (re: RegExp) => header.findIndex((h) => re.test(h));
    map = { url: find(/url|uri|website|site|origin/), name: find(/^(name|title)$/), username: find(/user|login|email/), password: find(/pass/), note: find(/note/), type: -1 };
  } else {
    const c = COLS[format];
    map = { url: idx(c.url), name: idx(c.name), username: idx(c.username), password: idx(c.password), note: idx(c.note), type: idx(c.type) };
  }
  const rows: ImportedRow[] = [];
  let skipped = 0;
  for (const r of all.slice(1)) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? '') : '');
    if (map.type >= 0 && get(map.type) && get(map.type) !== 'login') { skipped++; continue; } // Bitwarden notes, cards
    const url = get(map.url).trim();
    const password = get(map.password);
    if (!password || !url) { skipped++; continue; }
    rows.push({ url, name: get(map.name).trim(), username: get(map.username).trim(), password, note: get(map.note) });
  }
  return { format, rows, skipped };
}

// ── matching ──

/** https://Example.com:443/login?x → https://example.com; android://…@com.app/ stays; bare hosts get https. */
export function normalizeOrigin(url: string): string {
  const s = url.trim();
  if (/^android:\/\//i.test(s)) return s.replace(/\/+$/, '').toLowerCase();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin.toLowerCase();
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

/** Usernames compare trimmed; e-mail addresses case-insensitively. */
export function normalizeUsername(u: string): string {
  const t = u.trim();
  return t.includes('@') ? t.toLowerCase() : t;
}

export const entryKey = (origin: string, username: string) => `${origin}\n${normalizeUsername(username)}`;

export interface MergePlan {
  source: string;
  added: ImportedRow[];
  changed: { entry: PasswordEntry; row: ImportedRow }[];
  unchanged: number;
  /** Ids of the unchanged entries (they gain the source and lose a review flag). */
  confirmed: string[];
  /** Entries this source had before that its new export lacks: flagged for review, not deleted. */
  missing: PasswordEntry[];
  /** Rows in the file repeating an earlier row's site + username (the last one wins). */
  duplicatesInFile: number;
  skipped: number;
}

export function planMerge(vault: PasswordEntry[], rows: ImportedRow[], source: string, skipped = 0): MergePlan {
  const byKey = new Map<string, PasswordEntry>();
  for (const e of vault) byKey.set(entryKey(e.origin, e.username), e);
  const seen = new Map<string, ImportedRow>();
  let dups = 0;
  for (const r of rows) {
    const k = entryKey(normalizeOrigin(r.url), r.username);
    if (seen.has(k)) dups++;
    seen.set(k, r);
  }
  const plan: MergePlan = { source, added: [], changed: [], unchanged: 0, confirmed: [], missing: [], duplicatesInFile: dups, skipped };
  for (const [k, r] of seen) {
    const e = byKey.get(k);
    if (!e) plan.added.push(r);
    else if (e.password !== r.password) plan.changed.push({ entry: e, row: r });
    else { plan.unchanged++; plan.confirmed.push(e.id); }
  }
  for (const e of vault) {
    if (e.sources.includes(source) && !seen.has(entryKey(e.origin, e.username)) && !e.review) plan.missing.push(e);
  }
  return plan;
}

export function summarize(p: MergePlan): string {
  const parts = [
    `${p.added.length} new`, `${p.changed.length} changed`, `${p.unchanged} unchanged`,
  ];
  if (p.missing.length) parts.push(`${p.missing.length} no longer in ${p.source} (kept, marked for review)`);
  if (p.duplicatesInFile) parts.push(`${p.duplicatesInFile} duplicate rows in the file`);
  if (p.skipped) parts.push(`${p.skipped} rows skipped (no site or password)`);
  return parts.join(', ');
}

let idSeq = 0;
const newId = () => `${Date.now().toString(36)}-${(idSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Apply a plan; returns the new vault (the input is not modified). */
export function applyMerge(vault: PasswordEntry[], p: MergePlan, now = Date.now()): PasswordEntry[] {
  const out = vault.map((e) => ({ ...e, sources: [...e.sources], history: [...e.history] }));
  const byId = new Map(out.map((e) => [e.id, e]));
  for (const { entry, row } of p.changed) {
    const e = byId.get(entry.id);
    if (!e) continue;
    e.history.push({ password: e.password, until: now });
    e.password = row.password;
    e.updated = now;
    if (row.note && !e.note) e.note = row.note;
    if (!e.sources.includes(p.source)) e.sources.push(p.source);
    delete e.review;
  }
  for (const r of p.added) {
    out.push({
      id: newId(), origin: normalizeOrigin(r.url), url: r.url, name: r.name, username: r.username, password: r.password,
      note: r.note, sources: [p.source], created: now, updated: now, history: [],
    });
  }
  for (const id of p.confirmed) {
    const e = byId.get(id);
    if (!e) continue;
    if (!e.sources.includes(p.source)) e.sources.push(p.source);
    delete e.review;
  }
  for (const e of p.missing) { const x = byId.get(e.id); if (x) x.review = { source: p.source, since: now }; }
  return out;
}

/** Entries for a page: exact origin match first (no subdomain guessing: a login for a.example.com isn't offered on b.example.com). */
export function entriesFor(vault: PasswordEntry[], origin: string): PasswordEntry[] {
  const o = normalizeOrigin(origin);
  return vault.filter((e) => e.origin === o).sort((a, b) => b.updated - a.updated);
}

// ── encryption ──

export interface SealedVault { v: 1; kdf: 'PBKDF2-SHA256'; iterations: number; salt: string; iv: string; data: string }

const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealVault(entries: PasswordEntry[], passphrase: string, iterations = 600_000): Promise<SealedVault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const plain = new TextEncoder().encode(JSON.stringify({ entries }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('tabcomputer-vault-v1') }, key, plain));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: b64(salt), iv: b64(iv), data: b64(ct) };
}

/** Throws on a wrong passphrase (AES-GCM authentication fails). */
export async function openVault(sealed: SealedVault, passphrase: string): Promise<PasswordEntry[]> {
  const key = await deriveKey(passphrase, unb64(sealed.salt), sealed.iterations);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: new TextEncoder().encode('tabcomputer-vault-v1') }, key, unb64(sealed.data));
  } catch { throw new Error('wrong passphrase'); }
  return (JSON.parse(new TextDecoder().decode(plain)).entries ?? []) as PasswordEntry[];
}

/**
 * An unlocked vault: keeps the derived key (not the passphrase) in memory so
 * saves re-encrypt with a fresh IV under the same salt.
 */
export class VaultSession {
  private constructor(private key: CryptoKey, private meta: { iterations: number; salt: string }, public entries: PasswordEntry[]) {}

  static async create(passphrase: string, iterations = 600_000): Promise<{ session: VaultSession; sealed: SealedVault }> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, salt, iterations);
    const s = new VaultSession(key, { iterations, salt: b64(salt) }, []);
    return { session: s, sealed: await s.seal() };
  }

  static async unlock(sealed: SealedVault, passphrase: string): Promise<VaultSession> {
    const key = await deriveKey(passphrase, unb64(sealed.salt), sealed.iterations);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: new TextEncoder().encode('tabcomputer-vault-v1') }, key, unb64(sealed.data));
    } catch { throw new Error('wrong passphrase'); }
    const entries = (JSON.parse(new TextDecoder().decode(plain)).entries ?? []) as PasswordEntry[];
    return new VaultSession(key, { iterations: sealed.iterations, salt: sealed.salt }, entries);
  }

  async seal(): Promise<SealedVault> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ entries: this.entries }));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('tabcomputer-vault-v1') }, this.key, plain));
    return { v: 1, kdf: 'PBKDF2-SHA256', iterations: this.meta.iterations, salt: this.meta.salt, iv: b64(iv), data: b64(ct) };
  }

  /** Save a login the user submitted on a page; returns what happened. */
  remember(origin: string, url: string, username: string, password: string, now = Date.now()): 'added' | 'changed' | 'unchanged' {
    const o = normalizeOrigin(origin);
    const k = entryKey(o, username);
    const e = this.entries.find((x) => entryKey(x.origin, x.username) === k);
    if (!e) {
      this.entries.push({ id: newId(), origin: o, url, name: new URL(o).hostname, username, password, note: '', sources: ['saved'], created: now, updated: now, history: [] });
      return 'added';
    }
    if (e.password === password) return 'unchanged';
    e.history.push({ password: e.password, until: now });
    e.password = password;
    e.updated = now;
    return 'changed';
  }
}
