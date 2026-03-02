/**
 * x86-64 Virtual Memory — demand-paged, 4KB pages.
 * All addresses are bigint (64-bit virtual addresses).
 */

const PAGE_SIZE = 4096;
const PAGE_SHIFT = 12;
const PAGE_MASK = BigInt(PAGE_SIZE - 1);

export class VirtualMemory {
  private pages: Map<number, Uint8Array> = new Map();  // page number → 4KB page

  // Stats for debugging
  totalAllocated = 0;

  /** Get or allocate a page for the given address */
  private getPage(addr: bigint): Uint8Array {
    const pageNum = Number(addr >> BigInt(PAGE_SHIFT));
    let page = this.pages.get(pageNum);
    if (!page) {
      page = new Uint8Array(PAGE_SIZE);
      this.pages.set(pageNum, page);
      this.totalAllocated += PAGE_SIZE;
    }
    return page;
  }

  /** Check if a page exists without allocating */
  hasPage(addr: bigint): boolean {
    return this.pages.has(Number(addr >> BigInt(PAGE_SHIFT)));
  }

  // ─── Single-byte read/write ────────────────────────────────────────────────

  read8(addr: bigint): number {
    const page = this.getPage(addr);
    return page[Number(addr & PAGE_MASK)];
  }

  write8(addr: bigint, val: number): void {
    const page = this.getPage(addr);
    page[Number(addr & PAGE_MASK)] = val & 0xFF;
  }

  // ─── Multi-byte reads (little-endian) ──────────────────────────────────────

  read16(addr: bigint): number {
    const off = Number(addr & PAGE_MASK);
    // Fast path: within single page
    if (off <= PAGE_SIZE - 2) {
      const page = this.getPage(addr);
      return page[off] | (page[off + 1] << 8);
    }
    return this.read8(addr) | (this.read8(addr + 1n) << 8);
  }

  read32(addr: bigint): number {
    const off = Number(addr & PAGE_MASK);
    if (off <= PAGE_SIZE - 4) {
      const page = this.getPage(addr);
      return (page[off] | (page[off + 1] << 8) | (page[off + 2] << 16) | (page[off + 3] << 24)) >>> 0;
    }
    return (this.read8(addr) |
            (this.read8(addr + 1n) << 8) |
            (this.read8(addr + 2n) << 16) |
            (this.read8(addr + 3n) << 24)) >>> 0;
  }

  read64(addr: bigint): bigint {
    const lo = BigInt(this.read32(addr)) & 0xFFFFFFFFn;
    const hi = BigInt(this.read32(addr + 4n)) & 0xFFFFFFFFn;
    return lo | (hi << 32n);
  }

  // ─── Multi-byte writes (little-endian) ─────────────────────────────────────

  write16(addr: bigint, val: number): void {
    const off = Number(addr & PAGE_MASK);
    if (off <= PAGE_SIZE - 2) {
      const page = this.getPage(addr);
      page[off] = val & 0xFF;
      page[off + 1] = (val >> 8) & 0xFF;
      return;
    }
    this.write8(addr, val & 0xFF);
    this.write8(addr + 1n, (val >> 8) & 0xFF);
  }

  write32(addr: bigint, val: number): void {
    const off = Number(addr & PAGE_MASK);
    if (off <= PAGE_SIZE - 4) {
      const page = this.getPage(addr);
      page[off] = val & 0xFF;
      page[off + 1] = (val >> 8) & 0xFF;
      page[off + 2] = (val >> 16) & 0xFF;
      page[off + 3] = (val >> 24) & 0xFF;
      return;
    }
    this.write8(addr, val & 0xFF);
    this.write8(addr + 1n, (val >> 8) & 0xFF);
    this.write8(addr + 2n, (val >> 16) & 0xFF);
    this.write8(addr + 3n, (val >> 24) & 0xFF);
  }

  write64(addr: bigint, val: bigint): void {
    this.write32(addr, Number(val & 0xFFFFFFFFn));
    this.write32(addr + 4n, Number((val >> 32n) & 0xFFFFFFFFn));
  }

  // ─── Bulk operations ──────────────────────────────────────────────────────

  /** Load a segment of data into virtual memory */
  loadSegment(vaddr: bigint, data: Uint8Array, memsz: number): void {
    // Write actual data
    for (let i = 0; i < data.length; i++) {
      this.write8(vaddr + BigInt(i), data[i]);
    }
    // Zero-fill BSS (memsz > filesz)
    for (let i = data.length; i < memsz; i++) {
      this.write8(vaddr + BigInt(i), 0);
    }
  }

  /** Allocate zero-filled pages starting at addr */
  allocatePages(addr: bigint, count: number): void {
    for (let i = 0; i < count; i++) {
      const pageAddr = addr + BigInt(i * PAGE_SIZE);
      const pageNum = Number(pageAddr >> BigInt(PAGE_SHIFT));
      if (!this.pages.has(pageNum)) {
        this.pages.set(pageNum, new Uint8Array(PAGE_SIZE));
        this.totalAllocated += PAGE_SIZE;
      }
    }
  }

  /** Deallocate pages in range */
  freePages(addr: bigint, count: number): void {
    for (let i = 0; i < count; i++) {
      const pageNum = Number((addr + BigInt(i * PAGE_SIZE)) >> BigInt(PAGE_SHIFT));
      if (this.pages.delete(pageNum)) {
        this.totalAllocated -= PAGE_SIZE;
      }
    }
  }

  /** Read a null-terminated string from memory */
  readString(addr: bigint, maxLen = 4096): string {
    const bytes: number[] = [];
    for (let i = 0; i < maxLen; i++) {
      const b = this.read8(addr + BigInt(i));
      if (b === 0) break;
      bytes.push(b);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  /** Write a null-terminated string to memory */
  writeString(addr: bigint, str: string): number {
    const encoded = new TextEncoder().encode(str);
    for (let i = 0; i < encoded.length; i++) {
      this.write8(addr + BigInt(i), encoded[i]);
    }
    this.write8(addr + BigInt(encoded.length), 0); // null terminator
    return encoded.length + 1; // bytes written including null
  }

  /** Read bytes from memory into a Uint8Array */
  readBytes(addr: bigint, length: number): Uint8Array {
    const result = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      result[i] = this.read8(addr + BigInt(i));
    }
    return result;
  }

  /** Write bytes from a Uint8Array into memory */
  writeBytes(addr: bigint, data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      this.write8(addr + BigInt(i), data[i]);
    }
  }

  /** Get total allocated memory in bytes */
  getAllocatedBytes(): number {
    return this.totalAllocated;
  }

  /** Clear all memory */
  reset(): void {
    this.pages.clear();
    this.totalAllocated = 0;
  }
}
