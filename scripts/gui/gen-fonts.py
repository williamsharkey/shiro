#!/usr/bin/env python3
"""Convert X11 misc-fixed PCF fonts (xfonts-base, public domain) into
src/x11/fonts-data.ts for the in-page X server's core fonts.

usage: gen-fonts.py MISC_DIR ALIAS_FILE OUT.ts
MISC_DIR is usr/share/fonts/X11/misc from Debian's xfonts-base package.
"""
import gzip, struct, sys, os, base64, json

def parse_pcf(data):
    assert data[:4] == b'\x01fcp'
    (count,) = struct.unpack('<I', data[4:8])
    tables = {}
    for i in range(count):
        t, fmt, size, off = struct.unpack('<IIII', data[8 + 16 * i: 24 + 16 * i])
        tables[t] = (fmt, size, off)

    def reader(t):
        fmt, size, off = tables[t]
        (f2,) = struct.unpack('<I', data[off:off + 4])
        e = '>' if f2 & 4 else '<'
        return f2, e, off + 4

    # properties
    props = {}
    f, e, p = reader(1)
    (n,) = struct.unpack(e + 'I', data[p:p + 4]); p += 4
    raw = []
    for i in range(n):
        name_off, is_str, val = struct.unpack(e + 'IbI', data[p:p + 9]); p += 9
        raw.append((name_off, is_str, val))
    if n & 3: p += 4 - (n & 3)
    (slen,) = struct.unpack(e + 'I', data[p:p + 4]); p += 4
    strs = data[p:p + slen]
    cstr = lambda o: strs[o:strs.index(b'\0', o)].decode('latin-1')
    for name_off, is_str, val in raw:
        props[cstr(name_off)] = cstr(val) if is_str else struct.unpack('<i', struct.pack('<I', val))[0]

    # metrics
    f, e, p = reader(4)
    metrics = []
    if f & 0x100:
        (n,) = struct.unpack(e + 'H', data[p:p + 2]); p += 2
        for i in range(n):
            l, r, w, a, d = data[p:p + 5]; p += 5
            metrics.append((l - 0x80, r - 0x80, w - 0x80, a - 0x80, d - 0x80))
    else:
        (n,) = struct.unpack(e + 'I', data[p:p + 4]); p += 4
        for i in range(n):
            metrics.append(struct.unpack(e + 'hhhhh', data[p:p + 10])); p += 12

    # bitmaps
    f, e, p = reader(8)
    (n,) = struct.unpack(e + 'I', data[p:p + 4]); p += 4
    offsets = struct.unpack(e + '%dI' % n, data[p:p + 4 * n]); p += 4 * n
    sizes = struct.unpack(e + '4I', data[p:p + 16]); p += 16
    pad = 1 << (f & 3)
    msbit = bool(f & 8)
    unit = 1 << ((f >> 4) & 3)
    bm_base = p

    # encodings
    f, e, p = reader(32)
    min2, max2, min1, max1, defc = struct.unpack(e + 'hhhhh', data[p:p + 10]); p += 10
    ncodes = (max2 - min2 + 1) * (max1 - min1 + 1)
    idx = struct.unpack(e + '%dH' % ncodes, data[p:p + 2 * ncodes])
    enc = {}
    for b1 in range(min1, max1 + 1):
        for b2 in range(min2, max2 + 1):
            gi = idx[(b1 - min1) * (max2 - min2 + 1) + (b2 - min2)]
            if gi != 0xffff: enc[(b1 << 8) | b2] = gi

    # accelerators (prefer BDF accelerators)
    t = 0x100 if 0x100 in tables else 2
    f, e, p = reader(t)
    p += 8
    font_ascent, font_descent = struct.unpack(e + 'ii', data[p:p + 8])

    def glyph(gi):
        l, r, w, a, d = metrics[gi]
        width, height = r - l, a + d
        stride = ((width + 7) // 8 + pad - 1) // pad * pad
        row_bytes = (width + 7) // 8
        off = bm_base + offsets[gi]
        out = bytearray()
        for y in range(height):
            row = bytearray(data[off + y * stride: off + y * stride + stride])
            if not msbit:
                row = bytearray(int('{:08b}'.format(b)[::-1], 2) for b in row)
            # byte order within scan units only matters for unit > 1 with LSByte
            if unit > 1 and e == '<' and not msbit:
                pass
            out += row[:row_bytes]
        return [l, r, w, a, d], bytes(out)

    return props, enc, glyph, font_ascent, font_descent, defc

RANGES_UNI = [(0x20, 0x17f), (0x2010, 0x206f), (0x20ac, 0x20ac), (0x2190, 0x21ff), (0x2200, 0x22ff), (0x2300, 0x23ff), (0x2500, 0x25ff), (0x2600, 0x26ff)]
RANGES_LATIN1 = [(0x20, 0xff)]

FONTS = [
    # file, unicode subset?
    ('6x13', True), ('6x13B', True), ('6x13O', False), ('5x7', False), ('5x8', False), ('6x9', False), ('6x10', True), ('6x12', False),
    ('7x13', True), ('7x13B', False), ('7x14', True), ('7x14B', False), ('8x13', True), ('8x13B', False), ('8x16', False),
    ('9x15', True), ('9x15B', False), ('9x18', False), ('10x20', True), ('12x24', False),
]

def main():
    misc, alias_file, out = sys.argv[1:]
    fonts = []
    for name, uni in FONTS:
        raw = gzip.open(os.path.join(misc, name + '.pcf.gz')).read()
        props, enc, glyph, asc, desc, defc = parse_pcf(raw)
        ranges = RANGES_UNI if uni else RANGES_LATIN1
        glyphs = []
        bits = bytearray()
        for lo, hi in ranges:
            for c in range(lo, hi + 1):
                if c not in enc: continue
                m, b = glyph(enc[c])
                glyphs.append([c] + m + [len(bits)])
                bits += b
        xlfd = props.get('FONT', '')
        reg = props.get('CHARSET_REGISTRY', 'ISO10646')
        fonts.append({
            'file': name, 'xlfd': xlfd, 'ascent': asc, 'descent': desc,
            'default': 0x20, 'props': {k: v for k, v in props.items() if k != 'FONT'},
            'glyphs': glyphs, 'bits': base64.b64encode(bytes(bits)).decode(),
        })
    aliases = []
    for line in open(alias_file, encoding='latin-1'):
        line = line.strip()
        if not line or line.startswith('!'): continue
        a, _, target = line.partition(' ')
        aliases.append([a.strip('"'), target.strip().strip('"')])
    with open(out, 'w') as f:
        f.write('// Generated by scripts/gui/gen-fonts.py from Debian xfonts-base (misc-fixed, public domain). Do not edit.\n')
        f.write('// Each glyph: [code, lsb, rsb, width, ascent, descent, bitsOffset]; bits are rows of ceil((rsb-lsb)/8) bytes, MSB first.\n')
        f.write('export interface RawFont { file: string; xlfd: string; ascent: number; descent: number; default: number; props: Record<string, string | number>; glyphs: number[][]; bits: string }\n')
        f.write('export const FONTS: RawFont[] = ' + json.dumps(fonts, separators=(',', ':')) + ';\n')
        f.write('export const ALIASES: [string, string][] = ' + json.dumps(aliases) + ';\n')

main()
