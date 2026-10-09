/**
 * The X display's scale: device pixels per CSS pixel (devicePixelRatio when
 * the display starts, 1 headless). Xshiro's screen is in device pixels, so
 * clients draw at the screen's real resolution and each window's canvas maps
 * 1:1 onto the screen (docs/GUI.md, "HiDPI"); window hosts convert to CSS px.
 */
let scale: number | null = null;

export function displayScale(): number {
  if (scale === null) {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    // Quantized to 1/4 so a zoom level's rounding noise doesn't make every size fractional
    scale = dpr > 0 && Number.isFinite(dpr) ? Math.max(1, Math.round(dpr * 4) / 4) : 1;
  }
  return scale;
}

/** Tests: fix the scale (null: measure again). */
export function setDisplayScale(s: number | null): void { scale = s; }

/** The DPI X clients are told (Xft.dpi, the screen's size in mm). */
export function displayDpi(s = displayScale()): number { return Math.round(96 * s); }

/**
 * Toolkit settings for scale `s`: GTK scales its UI by whole numbers only
 * (GDK_SCALE), fonts follow Xft.dpi with GDK_DPI_SCALE undoing the double
 * count; Qt takes a fractional factor and its own font DPI.
 */
export function toolkitScaleEnv(s = displayScale()): Record<string, string> {
  if (s === 1) return {};
  const gdk = Math.max(1, Math.floor(s));
  return {
    GDK_SCALE: String(gdk),
    GDK_DPI_SCALE: String(1 / gdk),
    QT_SCALE_FACTOR: String(s),
    QT_FONT_DPI: '96',
    XCURSOR_SIZE: String(Math.round(24 * s)),
  };
}
