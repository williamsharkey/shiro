/**
 * The Browser app's Passwords panel (docs/BROWSER.md, "Passwords"): create /
 * unlock the encrypted vault, import a Google (or Chrome, Bitwarden,
 * 1Password, Firefox) CSV export with a diff preview, review flagged entries.
 * Google's export is the import path: this never signs in to Google or reads
 * passwords.google.com.
 */
import { kvGet, kvSet } from '../../browser/kv';
import {
  VaultSession, applyMerge, entriesFor, planMerge, readExport, summarize, type MergePlan, type PasswordEntry, type SealedVault,
} from '../../browser/passwords';

const IDLE_LOCK_MS = 15 * 60_000;

export class Vault {
  sealed: SealedVault | null = null;
  session: VaultSession | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  onChange: () => void = () => {};

  async load() { this.sealed = (await kvGet<SealedVault>('vault').catch(() => undefined)) ?? null; }
  get exists() { return !!this.sealed; }
  get unlocked() { return !!this.session; }
  get entries(): PasswordEntry[] { return this.session?.entries ?? []; }

  private touch() {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => this.lock(), IDLE_LOCK_MS);
  }
  async create(passphrase: string) {
    const { session, sealed } = await VaultSession.create(passphrase);
    this.session = session; this.sealed = sealed;
    await kvSet('vault', sealed);
    this.touch(); this.onChange();
  }
  async unlock(passphrase: string) {
    if (!this.sealed) throw new Error('no vault');
    this.session = await VaultSession.unlock(this.sealed, passphrase);
    this.touch(); this.onChange();
  }
  lock() { this.session = null; if (this.lockTimer) clearTimeout(this.lockTimer); this.onChange(); }
  async save() {
    if (!this.session) return;
    this.sealed = await this.session.seal();
    await kvSet('vault', this.sealed);
    this.touch(); this.onChange();
  }
  forOrigin(origin: string): PasswordEntry[] { this.touch(); return entriesFor(this.entries, origin); }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const GOOGLE_STEPS = `
<ol class="sd-small" style="margin:6px 0 10px 18px;line-height:1.7">
  <li><button class="sd-link" data-v="open-google">Open passwords.google.com in a real tab</button> and sign in there (Google checks it's really you).</li>
  <li>Click the gear (<b>Settings</b>) → <b>Export passwords</b> → <b>Export</b>, and confirm with your Google password.</li>
  <li>Choose the downloaded <code>Google Passwords.csv</code> here: <input type="file" accept=".csv,text/csv" data-v="file-google"></li>
  <li>Then delete the CSV file: it holds every password in plain text.</li>
</ol>`;

/** Fill `el` with the Passwords section; `rerender` redraws it. */
export function renderPasswords(el: HTMLElement, vault: Vault, rerender: () => void) {
  let html = '<h3>Passwords</h3><div class="sd-card">';
  if (!vault.exists) {
    html += `<p class="sd-small sd-muted">Saved logins live in an encrypted vault on this device (AES-256, key from your passphrase). Nothing is sent anywhere.</p>
      <div class="sd-row"><input class="sd-input sd-grow" type="password" placeholder="New passphrase" data-v="pass1" autocomplete="new-password">
      <input class="sd-input sd-grow" type="password" placeholder="Again" data-v="pass2" autocomplete="new-password"><button class="sd-btn sd-primary" data-v="create">Create vault</button></div>`;
  } else if (!vault.unlocked) {
    html += `<div class="sd-row"><input class="sd-input sd-grow" type="password" placeholder="Vault passphrase" data-v="pass" autocomplete="current-password"><button class="sd-btn sd-primary" data-v="unlock">Unlock</button></div>`;
  } else {
    const review = vault.entries.filter((e) => e.review);
    html += `<div class="sd-row"><span class="sd-grow">${vault.entries.length} saved logins${review.length ? `, ${review.length} to review` : ''}</span><button class="sd-btn" data-v="lock">Lock</button></div>
      <h3 style="margin-top:10px">Import from Google</h3>${GOOGLE_STEPS}
      <div class="sd-row"><span class="sd-small sd-grow">Or another export (Chrome, Bitwarden, 1Password, Firefox):</span><input type="file" accept=".csv,text/csv" data-v="file-other"></div>
      <div data-v="preview"></div>`;
    if (review.length) {
      html += `<h3>No longer in an import</h3><p class="sd-small sd-muted">Kept, not deleted: delete them here if you removed them on purpose.</p>`
        + review.map((e) => `<div class="sd-row"><span class="sd-grow">${esc(e.origin)} · ${esc(e.username)} <span class="sd-muted sd-small">(missing from ${esc(e.review!.source)})</span></span>
          <button class="sd-btn" data-v="keep" data-id="${esc(e.id)}">Keep</button><button class="sd-btn" data-v="delete" data-id="${esc(e.id)}">Delete</button></div>`).join('');
    }
    html += '<h3>Saved</h3>' + (vault.entries.slice().sort((a, b) => a.origin.localeCompare(b.origin)).slice(0, 500)
      .map((e) => `<div class="sd-row"><span class="sd-grow">${esc(e.origin)}</span><span class="sd-muted">${esc(e.username)}</span><span class="sd-muted sd-small">${e.history.length ? `${e.history.length} older` : ''}</span></div>`).join('') || '<span class="sd-muted sd-small">None yet.</span>');
  }
  html += '<p class="sd-small" data-v="msg" style="color:var(--sd-accent)"></p></div>';
  el.innerHTML = html;
  const q = <T extends HTMLElement>(k: string) => el.querySelector<T>(`[data-v="${k}"]`)!;
  const msg = (t: string) => { const m = el.querySelector<HTMLElement>('[data-v="msg"]'); if (m) m.textContent = t; };
  let plan: MergePlan | null = null;

  const preview = async (file: File, source: string) => {
    const text = await file.text();
    const r = readExport(text);
    const src = source === 'auto' ? (r.format === 'generic' ? 'csv' : r.format) : source;
    plan = planMerge(vault.entries, r.rows, src, r.skipped);
    const p = plan;
    const list = (title: string, items: string[]) => (items.length ? `<div class="sd-small"><b>${title}</b>: ${items.slice(0, 20).map(esc).join(', ')}${items.length > 20 ? ` and ${items.length - 20} more` : ''}</div>` : '');
    q('preview').innerHTML = `<div class="sd-card" style="margin-top:8px"><div><b>${esc(file.name)}</b> (${r.format}): ${esc(summarize(p))}</div>
      ${list('New', p.added.map((a) => `${new URL(normalizeUrl(a.url)).hostname} · ${a.username}`))}
      ${list('Changed password', p.changed.map((c) => `${c.entry.origin} · ${c.entry.username}`))}
      ${list('Not in this file any more (kept, flagged)', p.missing.map((m) => `${m.origin} · ${m.username}`))}
      <div class="sd-row"><button class="sd-btn sd-primary" data-v="apply">Apply</button><button class="sd-btn" data-v="cancel">Cancel</button></div></div>`;
  };

  el.onchange = (ev) => {
    const t = ev.target as HTMLInputElement;
    const f = t.files?.[0];
    if (!f) return;
    void preview(f, t.dataset.v === 'file-google' ? 'google' : 'auto').catch((e) => msg(`Could not read ${f.name}: ${(e as Error).message}`));
  };
  el.onclick = async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-v]');
    const v = b?.dataset.v;
    try {
      if (v === 'create') {
        const p1 = q<HTMLInputElement>('pass1').value, p2 = q<HTMLInputElement>('pass2').value;
        if (p1.length < 8) { msg('Use at least 8 characters.'); return; }
        if (p1 !== p2) { msg('The passphrases differ.'); return; }
        await vault.create(p1); rerender();
      } else if (v === 'unlock') {
        await vault.unlock(q<HTMLInputElement>('pass').value); rerender();
      } else if (v === 'lock') { vault.lock(); rerender(); }
      else if (v === 'open-google') window.open('https://passwords.google.com/', '_blank', 'noopener');
      else if (v === 'apply' && plan && vault.session) {
        vault.session.entries = applyMerge(vault.entries, plan);
        const s = summarize(plan);
        await vault.save(); rerender();
        msg(`Imported: ${s}. Now delete the CSV file.`);
      } else if (v === 'cancel') { plan = null; q('preview').innerHTML = ''; }
      else if ((v === 'keep' || v === 'delete') && vault.session) {
        const id = b!.dataset.id;
        if (v === 'delete') vault.session.entries = vault.entries.filter((e) => e.id !== id);
        else { const e = vault.entries.find((x) => x.id === id); if (e) delete e.review; }
        await vault.save(); rerender();
      }
    } catch (e) { msg((e as Error).message); }
  };
  el.onkeydown = (ev) => { if (ev.key === 'Enter') (el.querySelector('[data-v=unlock],[data-v=create]') as HTMLElement | null)?.click(); };
}

function normalizeUrl(u: string) { return /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`; }
