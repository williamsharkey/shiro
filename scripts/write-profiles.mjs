// dist/profiles.json: every profiles/<id>/profile.json, for server.mjs in a
// release (tabcomputer.com's and shiro.computer's carry only dist/ and
// server.mjs). Run by `npm run build`.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const root = new URL('../profiles/', import.meta.url);
const profiles = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/profile.json`, root)))
  .map((d) => JSON.parse(readFileSync(new URL(`${d.name}/profile.json`, root), 'utf8')));
writeFileSync(new URL('../dist/profiles.json', import.meta.url), JSON.stringify(profiles, null, 1) + '\n');
console.log(`profiles: ${profiles.map((p) => p.id).join(', ')}`);
