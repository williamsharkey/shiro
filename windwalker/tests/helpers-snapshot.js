// helpers-snapshot.js -- Filesystem snapshot utilities for windwalker tests
// Allows saving/restoring filesystem state to speed up tests that need npm install

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SNAPSHOTS_DIR = join(__dirname, '..', 'snapshots');

/**
 * Save a snapshot of the virtual filesystem to a JSON file.
 * @param {object} vfs - The VFS instance
 * @param {string} name - Snapshot name (e.g., 'parascene-installed')
 * @returns {Promise<string>} Path to the saved snapshot
 */
export async function saveSnapshot(vfs, name) {
  // Ensure snapshots directory exists
  if (!existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  // Export all inodes from the VFS cache
  const snapshot = {
    version: 1,
    name,
    timestamp: new Date().toISOString(),
    inodes: [],
  };

  // Iterate through the cache to get all files
  for (const [path, inode] of vfs.cache) {
    // Clone the inode data
    const entry = {
      path: inode.path,
      type: inode.type,
      mode: inode.mode,
      uid: inode.uid,
      gid: inode.gid,
      size: inode.size,
      ctime: inode.ctime,
      mtime: inode.mtime,
      atime: inode.atime,
    };

    // Handle content - convert Uint8Array to base64 for JSON serialization
    if (inode.content !== null && inode.content !== undefined) {
      if (inode.content instanceof Uint8Array) {
        entry.content = { type: 'base64', data: Buffer.from(inode.content).toString('base64') };
      } else if (typeof inode.content === 'string') {
        entry.content = { type: 'string', data: inode.content };
      } else {
        entry.content = { type: 'json', data: inode.content };
      }
    } else {
      entry.content = null;
    }

    // Handle symlink target
    if (inode.target) {
      entry.target = inode.target;
    }

    snapshot.inodes.push(entry);
  }

  // Sort by path for consistent output
  snapshot.inodes.sort((a, b) => a.path.localeCompare(b.path));

  const snapshotPath = join(SNAPSHOTS_DIR, `${name}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  console.log(`  Snapshot saved: ${name} (${snapshot.inodes.length} files)`);
  return snapshotPath;
}

/**
 * Restore a filesystem snapshot.
 * @param {object} vfs - The VFS instance
 * @param {string} name - Snapshot name to restore
 * @returns {Promise<boolean>} True if snapshot was restored, false if not found
 */
export async function restoreSnapshot(vfs, name) {
  const snapshotPath = join(SNAPSHOTS_DIR, `${name}.json`);

  if (!existsSync(snapshotPath)) {
    return false;
  }

  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  console.log(`  Restoring snapshot: ${name} (${snapshot.inodes.length} files)`);

  // Clear existing data and restore from snapshot
  // First, write all directories (sorted by path to ensure parents first)
  const dirs = snapshot.inodes.filter(i => i.type === 'dir').sort((a, b) => a.path.length - b.path.length);
  const files = snapshot.inodes.filter(i => i.type !== 'dir');

  for (const entry of dirs) {
    await vfs._put(restoreInode(entry));
  }

  for (const entry of files) {
    await vfs._put(restoreInode(entry));
  }

  // Reload cache
  await vfs._loadCache();

  console.log(`  Snapshot restored: ${name}`);
  return true;
}

/**
 * Check if a snapshot exists.
 * @param {string} name - Snapshot name
 * @returns {boolean}
 */
export function snapshotExists(name) {
  const snapshotPath = join(SNAPSHOTS_DIR, `${name}.json`);
  return existsSync(snapshotPath);
}

/**
 * Convert snapshot entry back to inode format.
 */
function restoreInode(entry) {
  const inode = {
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    uid: entry.uid,
    gid: entry.gid,
    size: entry.size,
    ctime: entry.ctime,
    mtime: entry.mtime,
    atime: entry.atime,
  };

  // Restore content
  if (entry.content) {
    if (entry.content.type === 'base64') {
      inode.content = Buffer.from(entry.content.data, 'base64');
    } else if (entry.content.type === 'string') {
      inode.content = entry.content.data;
    } else if (entry.content.type === 'json') {
      inode.content = entry.content.data;
    }
  } else {
    inode.content = null;
  }

  // Restore symlink target
  if (entry.target) {
    inode.target = entry.target;
  }

  return inode;
}

/**
 * Get snapshot info without loading it.
 * @param {string} name - Snapshot name
 * @returns {object|null} Snapshot metadata or null if not found
 */
export function getSnapshotInfo(name) {
  const snapshotPath = join(SNAPSHOTS_DIR, `${name}.json`);

  if (!existsSync(snapshotPath)) {
    return null;
  }

  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  return {
    name: snapshot.name,
    timestamp: snapshot.timestamp,
    fileCount: snapshot.inodes.length,
    path: snapshotPath,
  };
}
