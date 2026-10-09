/**
 * Imported first by main.ts: legacy `shiro-…` storage keys are copied to
 * their `tabcomputer-…` names before any module reads them (legacy-storage.ts).
 */
import { migrateStorage } from './legacy-storage';

migrateStorage(typeof localStorage !== 'undefined' ? localStorage : undefined);
migrateStorage(typeof sessionStorage !== 'undefined' ? sessionStorage : undefined);
