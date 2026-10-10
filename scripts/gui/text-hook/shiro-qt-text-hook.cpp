/*
 * libshiro-qt-text-hook.so: lets Qt 5 widget apps tell Xshiro what text they
 * draw, without changing what they draw (docs/DOM-RENDERING.md; the GTK one
 * is shiro-text-hook.c).
 *
 * Loaded with LD_PRELOAD (src/gui/apps.ts) when the display's text mode
 * isn't "pixels". Qt Widgets draws labels, buttons, menus, tabs, list and
 * tree items through QStyle, which calls QPainter::drawText in QtGui: those
 * calls cross a library boundary, so the exported drawText overloads can be
 * interposed. Each run is recorded with its position mapped to the toplevel
 * window (device pixels), its font metrics and pen colour, then drawn exactly
 * as before. Text Qt lays out inside QtGui (QTextLayout: line edits, text
 * documents) is not seen.
 *
 * Each toplevel keeps the runs it shows: a widget starting to paint (a
 * QPainter on it) clears the runs in its area, and its drawText calls add the
 * new ones. Qt keeps its pixels in a backing store and may put the same ones
 * on the window again without painting (an expose), which erases the spans
 * there; so every time Qt puts pixels on the window (xcb_copy_area,
 * xcb_put_image or xcb_shm_put_image, interposed in libxcb) the runs in that
 * area follow them on Qt's own connection, to the toplevel's _SHIRO_TEXT
 * property, one line each:
 *   "x baseline width ascent descent rrggbb\ttext\n"   (device pixels)
 * Xshiro consumes the property (server.ts). SHIRO_QT_TEXT_DEBUG=1 logs runs.
 *
 * Built by build.sh against Debian 12's Qt 5.15 headers and libraries.
 */
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <QtCore/QHash>
#include <QtCore/QVector>
#include <QtCore/QString>
#include <QtCore/QStringList>
#include <QtCore/QRectF>
#include <QtGui/QPainter>
#include <QtGui/QFontMetricsF>
#include <QtGui/QTransform>
#include <QtGui/QTextOption>
#include <QtWidgets/QWidget>

// ── a connection of our own (libxcb, already loaded by Qt's xcb platform) ──
typedef struct xcb_connection_t xcb_connection_t;
typedef struct { unsigned int sequence; } xcb_void_cookie_t;
typedef struct { unsigned int sequence; } xcb_intern_atom_cookie_t;
typedef struct { uint8_t response_type, pad0; uint16_t sequence; uint32_t length; uint32_t atom; } xcb_intern_atom_reply_t;

static struct {
  xcb_connection_t *(*connect)(const char *, int *);
  int (*has_error)(xcb_connection_t *);
  xcb_intern_atom_cookie_t (*intern_atom)(xcb_connection_t *, uint8_t, uint16_t, const char *);
  xcb_intern_atom_reply_t *(*intern_atom_reply)(xcb_connection_t *, xcb_intern_atom_cookie_t, void **);
  xcb_void_cookie_t (*change_property)(xcb_connection_t *, uint8_t, uint32_t, uint32_t, uint32_t, uint8_t, uint32_t, const void *);
  int (*flush)(xcb_connection_t *);
  xcb_connection_t *c;
  uint32_t prop, utf8;
  int state; // 0 not tried, 1 ready, -1 unavailable
} X;

static bool xready() {
  if (X.state) return X.state > 0;
  X.state = -1;
  void *h = dlopen("libxcb.so.1", RTLD_NOW | RTLD_NOLOAD);
  if (!h) h = dlopen("libxcb.so.1", RTLD_NOW);
  if (!h) return false;
  *(void **)&X.connect = dlsym(h, "xcb_connect");
  *(void **)&X.has_error = dlsym(h, "xcb_connection_has_error");
  *(void **)&X.intern_atom = dlsym(h, "xcb_intern_atom");
  *(void **)&X.intern_atom_reply = dlsym(h, "xcb_intern_atom_reply");
  *(void **)&X.change_property = dlsym(h, "xcb_change_property");
  *(void **)&X.flush = dlsym(h, "xcb_flush");
  if (!X.connect || !X.has_error || !X.intern_atom || !X.intern_atom_reply || !X.change_property || !X.flush) return false;
  X.c = X.connect(nullptr, nullptr);
  if (!X.c || X.has_error(X.c)) return false;
  const char *names[2] = { "_SHIRO_TEXT", "UTF8_STRING" };
  uint32_t *atoms[2] = { &X.prop, &X.utf8 };
  for (int i = 0; i < 2; i++) {
    xcb_intern_atom_reply_t *r = X.intern_atom_reply(X.c, X.intern_atom(X.c, 0, (uint16_t)strlen(names[i]), names[i]), nullptr);
    if (!r) return false;
    *atoms[i] = r->atom;
    free(r);
  }
  X.state = 1;
  return true;
}

/** A run the window shows now: its box (device pixels) and its _SHIRO_TEXT line */
struct Run { QRectF box; QByteArray line; };
/** Per toplevel X window: the runs it shows. Qt keeps its pixels (the backing store) and may put the same ones again
 *  without painting (an expose): every put of an area re-sends the runs in it, since the new pixels erase the spans. */
static QHash<uint32_t, QVector<Run>> &shown() { static QHash<uint32_t, QVector<Run>> p; return p; }

/** The area of widget `w` in its toplevel, device pixels; its X window in `win` */
static QRectF widgetBox(QWidget *w, uint32_t *win) {
  QWidget *top = w->window();
  *win = top ? (uint32_t)top->internalWinId() : 0;
  if (!*win) return QRectF();
  const qreal dpr = top->devicePixelRatioF();
  const QPoint o = w == top ? QPoint() : w->mapTo(top, QPoint(0, 0));
  return QRectF(o.x() * dpr, o.y() * dpr, w->width() * dpr, w->height() * dpr);
}

template <typename F> static F next(const char *sym) { return reinterpret_cast<F>(dlsym(RTLD_NEXT, sym)); }

/** Record the lines of `text` laid out in `r` (painter coordinates) with Qt alignment `flags`. */
static void report(QPainter *p, const QRectF &r, int flags, const QString &text, bool fromPoint) {
  if (text.trimmed().isEmpty() || !p->isActive()) return;
  QPaintDevice *dev = p->device();
  static const bool debug = getenv("SHIRO_QT_TEXT_DEBUG") != nullptr;
  if (!dev || dev->devType() != QInternal::Widget) return;
  QWidget *top = static_cast<QWidget *>(dev)->window();
  WId win = top ? top->internalWinId() : 0;
  if (!win || !xready()) return;
  // painter → the toplevel's backing store, in device pixels
  QWidget *w = static_cast<QWidget *>(dev);
  QPointF off = w == top ? QPointF() : QPointF(w->mapTo(top, QPoint(0, 0)));
  QTransform t = p->worldTransform() * QTransform::fromTranslate(off.x(), off.y()) * QTransform::fromScale(top->devicePixelRatioF(), top->devicePixelRatioF());
  QFontMetricsF fm(p->font(), dev);
  QString s = text;
  if (flags & Qt::TextShowMnemonic) s.replace(QLatin1String("&&"), QChar(0xfffe)).remove(QLatin1Char('&')).replace(QChar(0xfffe), QLatin1Char('&'));
  else if (flags & Qt::TextHideMnemonic) s.replace(QLatin1String("&&"), QChar(0xfffe)).remove(QLatin1Char('&')).replace(QChar(0xfffe), QLatin1Char('&'));
  const QStringList lines = s.split(QLatin1Char('\n'));
  const qreal lh = fm.lineSpacing(), total = lh * lines.size() - fm.leading();
  qreal y = r.top();
  if (!fromPoint) {
    if (flags & Qt::AlignBottom) y = r.bottom() - total;
    else if (flags & Qt::AlignVCenter) y = r.top() + (r.height() - total) / 2;
  }
  const QColor c = p->pen().color();
  QVector<Run> &runs = shown()[(uint32_t)win];
  for (const QString &line : lines) {
    const qreal width = fm.horizontalAdvance(line);
    qreal x = r.left();
    if (!fromPoint) {
      if (flags & Qt::AlignRight) x = r.right() - width;
      else if (flags & Qt::AlignHCenter) x = r.left() + (r.width() - width) / 2;
    }
    const qreal base = fromPoint ? r.top() : y + fm.ascent();
    y += lh;
    if (line.trimmed().isEmpty()) continue;
    // scale of the transform: font sizes and widths in device pixels
    const QPointF a = t.map(QPointF(x, base)), b = t.map(QPointF(x + width, base));
    const qreal sy = QLineF(t.map(QPointF(0, 0)), t.map(QPointF(0, 1))).length();
    if (a.y() != b.y()) continue; // rotated text: leave it as pixels
    char head[96];
    snprintf(head, sizeof head, "%d %d %d %d %d %02x%02x%02x\t", (int)(a.x() + 0.5), (int)(a.y() + 0.5), (int)(b.x() - a.x() + 0.5),
             (int)(fm.ascent() * sy + 0.5), (int)(fm.descent() * sy + 0.5), c.red(), c.green(), c.blue());
    QString clean = line;
    clean.replace(QLatin1Char('\t'), QLatin1Char(' '));
    Run run{ QRectF(a.x(), a.y() - fm.ascent() * sy, b.x() - a.x(), (fm.ascent() + fm.descent()) * sy), QByteArray(head) + clean.toUtf8() + '\n' };
    if (debug) fprintf(stderr, "qt-text: 0x%lx %s", (unsigned long)win, run.line.constData());
    // it replaces what was drawn there
    for (int i = runs.size() - 1; i >= 0; i--) if (runs[i].box.intersects(run.box)) runs.remove(i);
    if (runs.size() < 4096) runs.push_back(run);
  }
}

/** A widget starts painting: the text it showed is being redrawn (or isn't there any more). */
static void painting(QPaintDevice *dev) {
  if (!dev || dev->devType() != QInternal::Widget) return;
  uint32_t win;
  const QRectF box = widgetBox(static_cast<QWidget *>(dev), &win);
  auto it = shown().find(win);
  if (it == shown().end()) return;
  QVector<Run> &runs = it.value();
  for (int i = runs.size() - 1; i >= 0; i--) if (box.contains(runs[i].box.center())) runs.remove(i);
}

/** After Qt's pixels for `drawable` went out on `c`: the runs drawn in it follow them. */
static void flushRuns(xcb_connection_t *c, uint32_t drawable, int x, int y, int w, int h) {
  if (X.state <= 0) return;
  auto it = shown().find(drawable);
  if (it == shown().end()) return;
  const QRectF area(x, y, w, h);
  QByteArray out;
  for (const Run &r : it.value()) if (r.box.intersects(area)) out += r.line;
  if (!out.isEmpty()) X.change_property(c, 2 /* append */, drawable, X.prop, X.utf8, 8, (uint32_t)out.size(), out.constData());
}

extern "C" {
xcb_void_cookie_t xcb_copy_area(xcb_connection_t *c, uint32_t src, uint32_t dst, uint32_t gc, int16_t sx, int16_t sy, int16_t dx, int16_t dy, uint16_t w, uint16_t h) {
  static auto real = next<xcb_void_cookie_t (*)(xcb_connection_t *, uint32_t, uint32_t, uint32_t, int16_t, int16_t, int16_t, int16_t, uint16_t, uint16_t)>("xcb_copy_area");
  xcb_void_cookie_t r = real(c, src, dst, gc, sx, sy, dx, dy, w, h);
  flushRuns(c, dst, dx, dy, w, h);
  return r;
}
xcb_void_cookie_t xcb_put_image(xcb_connection_t *c, uint8_t format, uint32_t drawable, uint32_t gc, uint16_t w, uint16_t h, int16_t x, int16_t y, uint8_t pad, uint8_t depth, uint32_t len, const uint8_t *data) {
  static auto real = next<xcb_void_cookie_t (*)(xcb_connection_t *, uint8_t, uint32_t, uint32_t, uint16_t, uint16_t, int16_t, int16_t, uint8_t, uint8_t, uint32_t, const uint8_t *)>("xcb_put_image");
  xcb_void_cookie_t r = real(c, format, drawable, gc, w, h, x, y, pad, depth, len, data);
  flushRuns(c, drawable, x, y, w, h);
  return r;
}
xcb_void_cookie_t xcb_shm_put_image(xcb_connection_t *c, uint32_t drawable, uint32_t gc, uint16_t tw, uint16_t th, uint16_t sx, uint16_t sy, uint16_t sw, uint16_t sh, int16_t dx, int16_t dy, uint8_t depth, uint8_t format, uint8_t send_event, uint32_t seg, uint32_t offset) {
  static auto real = next<xcb_void_cookie_t (*)(xcb_connection_t *, uint32_t, uint32_t, uint16_t, uint16_t, uint16_t, uint16_t, uint16_t, uint16_t, int16_t, int16_t, uint8_t, uint8_t, uint8_t, uint32_t, uint32_t)>("xcb_shm_put_image");
  xcb_void_cookie_t r = real(c, drawable, gc, tw, th, sx, sy, sw, sh, dx, dy, depth, format, send_event, seg, offset);
  flushRuns(c, drawable, dx, dy, sw, sh);
  return r;
}
}

// void QPainter::drawText(const QPointF &p, const QString &s)
void QPainter::drawText(const QPointF &pt, const QString &s) {
  static auto real = next<void (*)(QPainter *, const QPointF &, const QString &)>("_ZN8QPainter8drawTextERK7QPointFRK7QString");
  report(this, QRectF(pt, QSizeF()), 0, s, true);
  real(this, pt, s);
}

// void QPainter::drawText(const QRectF &r, int flags, const QString &text, QRectF *br)
void QPainter::drawText(const QRectF &r, int flags, const QString &text, QRectF *br) {
  static auto real = next<void (*)(QPainter *, const QRectF &, int, const QString &, QRectF *)>("_ZN8QPainter8drawTextERK6QRectFiRK7QStringPS0_");
  report(this, r, flags, text, false);
  real(this, r, flags, text, br);
}

// void QPainter::drawText(const QRect &r, int flags, const QString &text, QRect *br)
void QPainter::drawText(const QRect &r, int flags, const QString &text, QRect *br) {
  static auto real = next<void (*)(QPainter *, const QRect &, int, const QString &, QRect *)>("_ZN8QPainter8drawTextERK5QRectiRK7QStringPS0_");
  report(this, QRectF(r), flags, text, false);
  real(this, r, flags, text, br);
}

// void QPainter::drawText(const QRectF &r, const QString &text, const QTextOption &o)
void QPainter::drawText(const QRectF &r, const QString &text, const QTextOption &o) {
  static auto real = next<void (*)(QPainter *, const QRectF &, const QString &, const QTextOption &)>("_ZN8QPainter8drawTextERK6QRectFRK7QStringRK11QTextOption");
  report(this, r, int(o.alignment()), text, false);
  real(this, r, text, o);
}

// QPainter::QPainter(QPaintDevice *) and QPainter::begin(QPaintDevice *): a widget's paintEvent starts.
// Plain functions under the mangled names (a constructor can't be redefined here without QPainterPrivate).
extern "C" void shiro_painter_ctor(QPainter *self, QPaintDevice *dev) __asm__("_ZN8QPainterC1EP12QPaintDevice");
extern "C" void shiro_painter_ctor(QPainter *self, QPaintDevice *dev) {
  static auto real = next<void (*)(QPainter *, QPaintDevice *)>("_ZN8QPainterC1EP12QPaintDevice");
  painting(dev);
  real(self, dev);
}

extern "C" bool shiro_painter_begin(QPainter *self, QPaintDevice *dev) __asm__("_ZN8QPainter5beginEP12QPaintDevice");
extern "C" bool shiro_painter_begin(QPainter *self, QPaintDevice *dev) {
  static auto real = next<bool (*)(QPainter *, QPaintDevice *)>("_ZN8QPainter5beginEP12QPaintDevice");
  painting(dev);
  return real(self, dev);
}
