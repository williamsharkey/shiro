import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '../src/filesystem';

describe('FileSystem', () => {
  let fs: FileSystem;

  beforeEach(async () => {
    fs = new FileSystem();
    await fs.init();
  });

  it('should have root directory', async () => {
    const stat = await fs.stat('/');
    expect(stat.isDirectory()).toBe(true);
  });

  it('should create and read files', async () => {
    await fs.writeFile('/home/user/test.txt', 'hello world');
    const content = await fs.readFile('/home/user/test.txt', 'utf8');
    expect(content).toBe('hello world');
  });

  it('should create directories', async () => {
    await fs.mkdir('/home/user/testdir');
    const stat = await fs.stat('/home/user/testdir');
    expect(stat.isDirectory()).toBe(true);
  });

  it('should create directories recursively', async () => {
    await fs.mkdir('/home/user/a/b/c', { recursive: true });
    const stat = await fs.stat('/home/user/a/b/c');
    expect(stat.isDirectory()).toBe(true);
  });

  it('should list directory contents', async () => {
    await fs.writeFile('/home/user/file1.txt', 'a');
    await fs.writeFile('/home/user/file2.txt', 'b');
    const entries = await fs.readdir('/home/user');
    expect(entries).toContain('file1.txt');
    expect(entries).toContain('file2.txt');
  });

  it('should delete files', async () => {
    await fs.writeFile('/home/user/todelete.txt', 'bye');
    await fs.unlink('/home/user/todelete.txt');
    await expect(fs.stat('/home/user/todelete.txt')).rejects.toThrow('ENOENT');
  });

  it('should rename files', async () => {
    await fs.writeFile('/home/user/old.txt', 'data');
    await fs.rename('/home/user/old.txt', '/home/user/new.txt');
    const content = await fs.readFile('/home/user/new.txt', 'utf8');
    expect(content).toBe('data');
    await expect(fs.stat('/home/user/old.txt')).rejects.toThrow('ENOENT');
  });

  it('should resolve paths with . and ..', () => {
    expect(fs.resolvePath('foo/bar', '/home')).toBe('/home/foo/bar');
    expect(fs.resolvePath('../tmp', '/home/user')).toBe('/home/tmp');
    expect(fs.resolvePath('./file.txt', '/home/user')).toBe('/home/user/file.txt');
    expect(fs.resolvePath('/absolute', '/home')).toBe('/absolute');
  });

  it('should remove directories recursively', async () => {
    await fs.mkdir('/home/user/rmtest', { recursive: true });
    await fs.writeFile('/home/user/rmtest/file.txt', 'data');
    await fs.mkdir('/home/user/rmtest/sub');
    await fs.writeFile('/home/user/rmtest/sub/nested.txt', 'nested');
    await fs.rm('/home/user/rmtest', { recursive: true });
    await expect(fs.stat('/home/user/rmtest')).rejects.toThrow('ENOENT');
  });

  it('should throw on reading nonexistent file', async () => {
    await expect(fs.readFile('/nonexistent')).rejects.toThrow('ENOENT');
  });

  it('should append to files', async () => {
    await fs.writeFile('/home/user/append.txt', 'hello');
    await fs.appendFile('/home/user/append.txt', ' world');
    const content = await fs.readFile('/home/user/append.txt', 'utf8');
    expect(content).toBe('hello world');
  });
});
