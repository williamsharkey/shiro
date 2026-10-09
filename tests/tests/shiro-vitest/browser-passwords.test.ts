/**
 * The Browser app's password vault (src/browser/passwords.ts, docs/BROWSER.md
 * "Passwords"): CSV exports from Google/Chrome, Bitwarden, 1Password and
 * Firefox, the re-import merge (no duplicates, changed passwords keep history,
 * removed entries flagged not deleted), and the encrypted vault.
 */
import { describe, expect, it } from 'vitest';
import {
  applyMerge, entriesFor, normalizeOrigin, openVault, parseCsv, planMerge, readExport, sealVault, summarize, type PasswordEntry,
} from '@shiro/browser/passwords';

const GOOGLE = `name,url,username,password,note
example.com,https://example.com/login,alice@example.com,pw1,
github.com,https://github.com/session,alice,"p,w""2",work account
,https://nopassword.example,bob,,
accounts.google.com,https://accounts.google.com/,Alice@Example.com,pw3,
`;

describe('CSV exports', () => {
  it('parses RFC 4180 with quotes, commas, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x,1","y ""q"""\r\n')).toEqual([['a', 'b'], ['x,1', 'y "q"']]);
    expect(parseCsv('a\n"multi\nline",z')).toEqual([['a'], ['multi\nline', 'z']]);
  });
  it('reads Google Password Manager exports', () => {
    const r = readExport(GOOGLE);
    expect(r.format).toBe('google');
    expect(r.rows).toHaveLength(3);
    expect(r.skipped).toBe(1);
    expect(r.rows[1]).toMatchObject({ url: 'https://github.com/session', username: 'alice', password: 'p,w"2', note: 'work account' });
  });
  it('reads Bitwarden, 1Password and Firefox exports', () => {
    const bw = readExport(`folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
,,login,Example,,,0,https://example.com,alice@example.com,bwpw,
,,note,Secure note,text,,0,,,,
`);
    expect(bw.format).toBe('bitwarden');
    expect(bw.rows).toEqual([{ url: 'https://example.com', name: 'Example', username: 'alice@example.com', password: 'bwpw', note: '' }]);
    expect(bw.skipped).toBe(1);
    const op = readExport(`Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes
Example,https://example.com,alice@example.com,oppw,,false,false,,n
`);
    expect(op.format).toBe('1password');
    expect(op.rows[0]).toMatchObject({ password: 'oppw', note: 'n' });
    const ff = readExport(`"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"
"https://example.com","alice@example.com","ffpw",,"https://example.com","{x}","1","2","3"
`);
    expect(ff.format).toBe('firefox');
    expect(ff.rows[0].password).toBe('ffpw');
  });
  it('normalizes origins', () => {
    expect(normalizeOrigin('https://Example.com:443/login?x=1')).toBe('https://example.com');
    expect(normalizeOrigin('example.com')).toBe('https://example.com');
    expect(normalizeOrigin('http://example.com:8080/')).toBe('http://example.com:8080');
    expect(normalizeOrigin('android://hash@com.example.app/')).toBe('android://hash@com.example.app');
  });
});

describe('re-import merge', () => {
  const first = readExport(GOOGLE);
  const v1 = applyMerge([], planMerge([], first.rows, 'google', first.skipped), 1000);

  it('first import adds everything once', () => {
    const p = planMerge([], first.rows, 'google', first.skipped);
    expect(summarize(p)).toBe('3 new, 0 changed, 0 unchanged, 1 rows skipped (no site or password)');
    expect(v1).toHaveLength(3);
    expect(v1.every((e) => e.sources.includes('google'))).toBe(true);
  });

  it('importing the same file again changes nothing', () => {
    const p = planMerge(v1, first.rows, 'google');
    expect([p.added.length, p.changed.length, p.unchanged, p.missing.length]).toEqual([0, 0, 3, 0]);
    expect(applyMerge(v1, p)).toHaveLength(3);
  });

  it('updates changed passwords keeping history, adds new, flags removed, and dedupes the file', () => {
    const next = readExport(`name,url,username,password,note
example.com,https://EXAMPLE.com/other-page,ALICE@example.com,pw1-new,
new.example,https://new.example/,carol,pw4,
new.example,https://new.example/,carol,pw4,
accounts.google.com,https://accounts.google.com/,alice@example.com,pw3,
`);
    const p = planMerge(v1, next.rows, 'google');
    expect(p.added.map((r) => r.url)).toEqual(['https://new.example/']);
    expect(p.changed).toHaveLength(1);
    expect(p.unchanged).toBe(1);
    expect(p.missing.map((e) => e.origin)).toEqual(['https://github.com']);
    expect(p.duplicatesInFile).toBe(1);
    expect(summarize(p)).toBe('1 new, 1 changed, 1 unchanged, 1 no longer in google (kept, marked for review), 1 duplicate rows in the file');
    const v2 = applyMerge(v1, p, 2000);
    expect(v2).toHaveLength(4);
    const ex = v2.find((e) => e.origin === 'https://example.com')!;
    expect(ex.password).toBe('pw1-new');
    expect(ex.history).toEqual([{ password: 'pw1', until: 2000 }]);
    const gh = v2.find((e) => e.origin === 'https://github.com')!;
    expect(gh.password).toBe('p,w"2'); // kept
    expect(gh.review).toEqual({ source: 'google', since: 2000 });
    // the input vault is untouched
    expect(v1.find((e) => e.origin === 'https://example.com')!.password).toBe('pw1');
    // it reappears: the review flag clears
    const back = planMerge(v2, first.rows, 'google');
    const v3 = applyMerge(v2, back, 3000);
    expect(v3.find((e) => e.origin === 'https://github.com')!.review).toBeUndefined();
  });

  it('merges other sources into the same entries', () => {
    const bw = readExport(`folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
,,login,Example,,,0,https://example.com,alice@example.com,pw1,
`);
    const p = planMerge(v1, bw.rows, 'bitwarden');
    expect([p.added.length, p.changed.length, p.unchanged]).toEqual([0, 0, 1]);
    const v = applyMerge(v1, p);
    expect(v.find((e) => e.origin === 'https://example.com')!.sources).toEqual(['google', 'bitwarden']);
    // a source never flags entries it didn't contribute
    expect(p.missing).toEqual([]);
  });

  it('offers logins for the exact origin only', () => {
    expect(entriesFor(v1, 'https://example.com').map((e) => e.username)).toEqual(['alice@example.com']);
    expect(entriesFor(v1, 'https://evil.example.com')).toEqual([]);
  });
});

describe('vault encryption', () => {
  it('round-trips with the passphrase and refuses a wrong one', async () => {
    const entries: PasswordEntry[] = [{ id: '1', origin: 'https://a.example', url: 'https://a.example', name: '', username: 'u', password: 's3cret', note: '', sources: ['manual'], created: 1, updated: 1, history: [] }];
    const sealed = await sealVault(entries, 'correct horse', 1000);
    expect(JSON.stringify(sealed)).not.toContain('s3cret');
    expect(sealed.iterations).toBe(1000);
    expect(await openVault(sealed, 'correct horse')).toEqual(entries);
    await expect(openVault(sealed, 'wrong')).rejects.toThrow('wrong passphrase');
    expect((await sealVault(entries, 'x')).iterations).toBe(600_000);
  });
});

describe('vault session', () => {
  it('creates, saves, unlocks and remembers submitted logins', async () => {
    const { VaultSession } = await import('@shiro/browser/passwords');
    const { session, sealed } = await VaultSession.create('pass phrase', 1000);
    expect(session.remember('https://a.example/login', 'https://a.example/login', 'u', 'p1')).toBe('added');
    expect(session.remember('https://a.example', 'https://a.example/', 'u', 'p1')).toBe('unchanged');
    expect(session.remember('https://a.example', 'https://a.example/', 'u', 'p2')).toBe('changed');
    const saved = await session.seal();
    expect(saved.salt).toBe(sealed.salt);
    expect(saved.iv).not.toBe(sealed.iv);
    const again = await VaultSession.unlock(saved, 'pass phrase');
    expect(again.entries[0]).toMatchObject({ origin: 'https://a.example', username: 'u', password: 'p2', history: [{ password: 'p1' }] });
    await expect(VaultSession.unlock(saved, 'nope')).rejects.toThrow('wrong passphrase');
  });
});
