// src/components/shared/chartDrawingsPrimitive.js
//
// Слой рисунков поверх графика Lightweight Charts: подключается к ряду свечей как «примитив»
// (series.attachPrimitive) и рисует линии, зоны, Фибоначчи, метки и линейку на холсте графика —
// поэтому рисунки двигаются и масштабируются вместе со свечами без отдельного наложенного слоя.
//
// Время ↔ координата переводится через ЛОГИЧЕСКИЙ индекс бара (между барами — линейно, за краями —
// по типичному шагу), а не через timeToCoordinate: тот умеет только точное время бара, а линию
// можно провести правее последней свечи или между двумя барами.
import { FIB_RATIOS, distToSegment } from '../../services/chartDrawings';

const UP = '#3fb68b';
const DOWN = '#e0584f';

function withAlpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export class DrawingsPrimitive {
  constructor() {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
    this._s = {
      drawings: [], preview: null, selectedId: null, ruler: null, times: [], barSec: 86400, digits: 2,
    };
    this._renderer = { draw: (target) => this._draw(target) };
    this._paneView = { zOrder: () => 'top', renderer: () => this._renderer };
  }

  attached({ chart, series, requestUpdate }) {
    this._chart = chart;
    this._series = series;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  paneViews() { return [this._paneView]; }
  updateAllViews() { /* геометрия считается при отрисовке */ }

  /** Обновить состояние и перерисовать. */
  setState(partial) {
    Object.assign(this._s, partial);
    this._requestUpdate?.();
  }

  // ---- время / цена ↔ координаты ----
  _logicalOfTime(t) {
    const ts = this._s.times;
    const n = ts.length;
    if (!n) return null;
    const step = (a, b) => (b > a ? b - a : this._s.barSec || 86400);
    if (t <= ts[0]) return (t - ts[0]) / step(ts[0], n > 1 ? ts[1] : ts[0] + this._s.barSec);
    if (t >= ts[n - 1]) return (n - 1) + (t - ts[n - 1]) / step(n > 1 ? ts[n - 2] : ts[n - 1] - this._s.barSec, ts[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) lo = mid; else hi = mid;
    }
    return lo + (t - ts[lo]) / (ts[lo + 1] - ts[lo]);
  }

  _timeOfLogical(l) {
    const ts = this._s.times;
    const n = ts.length;
    if (!n) return null;
    const step = (a, b) => (b > a ? b - a : this._s.barSec || 86400);
    if (l <= 0) return ts[0] + l * step(ts[0], n > 1 ? ts[1] : ts[0] + this._s.barSec);
    if (l >= n - 1) return ts[n - 1] + (l - (n - 1)) * step(n > 1 ? ts[n - 2] : ts[n - 1] - this._s.barSec, ts[n - 1]);
    const i = Math.floor(l);
    return ts[i] + (l - i) * (ts[i + 1] - ts[i]);
  }

  /** Время (секунды) → x в пикселях или null. */
  timeToX(t) {
    if (!this._chart) return null;
    const l = this._logicalOfTime(t);
    if (l == null) return null;
    return this._chart.timeScale().logicalToCoordinate(l);
  }

  /** x в пикселях → время (секунды) или null. */
  xToTime(x) {
    if (!this._chart) return null;
    const l = this._chart.timeScale().coordinateToLogical(x);
    if (l == null) return null;
    return this._timeOfLogical(l);
  }

  priceToY(p) { return this._series ? this._series.priceToCoordinate(p) : null; }
  yToPrice(y) { return this._series ? this._series.coordinateToPrice(y) : null; }

  /** Точка экрана → { time, price } или null. */
  pointAt(x, y) {
    const time = this.xToTime(x);
    const price = this.yToPrice(y);
    if (time == null || price == null) return null;
    return { time, price: Number(price) };
  }

  // ---- геометрия ----
  _pxy(p) {
    const x = this.timeToX(p.time);
    const y = this.priceToY(p.price);
    return x == null || y == null ? null : { x, y };
  }

  /**
   * Фигуры рисунка в экранных координатах: отрезки (для отрисовки и попадания клика), заливки,
   * подписи и «ручки». width/height — размер области графика.
   */
  _shapes(d, width, height) {
    const out = { segs: [], fills: [], labels: [], handles: [] };
    const a = this._pxy(d.p1);
    if (!a && d.type !== 'vline') return out;
    const color = d.color;
    const fmtP = (v) => v.toLocaleString('ru-RU', { maximumFractionDigits: this._s.digits });

    if (d.type === 'hline') {
      out.segs.push({ x1: 0, y1: a.y, x2: width, y2: a.y, color, w: d.width });
      out.labels.push({ x: width - 6, y: a.y - 8, text: fmtP(d.p1.price), align: 'right', color });
      out.handles.push(a);
    } else if (d.type === 'vline') {
      const x = this.timeToX(d.p1.time);
      if (x == null) return out;
      out.segs.push({ x1: x, y1: 0, x2: x, y2: height, color, w: d.width });
      out.handles.push({ x, y: height / 2 });
    } else if (d.type === 'text') {
      out.labels.push({ x: a.x, y: a.y, text: d.label || 'Метка', align: 'left', color, box: true });
      out.handles.push(a);
    } else {
      const b = this._pxy(d.p2);
      if (!b) return out;
      if (d.type === 'trend') {
        out.segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color, w: d.width });
      } else if (d.type === 'ray') {
        const dx = b.x - a.x, dy = b.y - a.y;
        let x2 = b.x, y2 = b.y;
        if (dx !== 0) {
          const target = dx > 0 ? width + 20 : -20;
          const k = (target - a.x) / dx;
          x2 = target; y2 = a.y + dy * k;
        } else {
          x2 = a.x; y2 = dy > 0 ? height + 20 : -20;
        }
        out.segs.push({ x1: a.x, y1: a.y, x2, y2, color, w: d.width });
      } else if (d.type === 'rect') {
        const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
        out.fills.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, color, alpha: 0.12 });
        out.segs.push({ x1, y1, x2, y2: y1, color, w: d.width }, { x1: x2, y1, x2, y2, color, w: d.width },
          { x1, y1: y2, x2, y2, color, w: d.width }, { x1, y1, x2: x1, y2, color, w: d.width });
      } else if (d.type === 'fib') {
        const x1 = Math.min(a.x, b.x);
        const x2 = Math.max(a.x, b.x);
        const ys = FIB_RATIOS.map((r) => ({ r, price: d.p1.price + (d.p2.price - d.p1.price) * r }))
          .map((l) => ({ ...l, y: this.priceToY(l.price) })).filter((l) => l.y != null);
        // «золотая зона» 38,2–61,8% — лёгкая заливка
        const g1 = ys.find((l) => l.r === 0.382), g2 = ys.find((l) => l.r === 0.618);
        if (g1 && g2) out.fills.push({ x: x1, y: Math.min(g1.y, g2.y), w: Math.max(40, x2 - x1), h: Math.abs(g2.y - g1.y), color, alpha: 0.1 });
        for (const l of ys) {
          out.segs.push({ x1, y1: l.y, x2: Math.max(x2, x1 + 40), y2: l.y, color, w: 1, dash: l.r === 0 || l.r === 1 ? null : [4, 4] });
          out.labels.push({ x: x1 + 4, y: l.y - 8, text: `${String(Math.round(l.r * 1000) / 10).replace('.', ',')}% · ${fmtP(l.price)}`, align: 'left', color });
        }
        out.segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color, w: 1, dash: [2, 3] });
      }
      out.handles.push(a, b);
    }
    return out;
  }

  /** id рисунка под точкой экрана (в пределах tol пикселей) или null. */
  hitTest(x, y, tol = 8) {
    const w = this._width || 0, h = this._height || 0;
    let best = null;
    for (const d of this._s.drawings) {
      const sh = this._shapes(d, w, h);
      let dist = Infinity;
      for (const s of sh.segs) dist = Math.min(dist, distToSegment(x, y, s.x1, s.y1, s.x2, s.y2));
      for (const f of sh.fills) {
        if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h) dist = Math.min(dist, 0);
      }
      for (const l of sh.labels) {
        if (l.box && Math.abs(x - l.x) < 60 && Math.abs(y - l.y) < 12) dist = Math.min(dist, 0);
      }
      if (dist <= tol && (!best || dist < best.dist)) best = { id: d.id, dist };
    }
    return best ? best.id : null;
  }

  // ---- отрисовка ----
  _draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      this._width = mediaSize.width;
      this._height = mediaSize.height;
      const { drawings, preview, selectedId, ruler } = this._s;
      const list = preview ? [...drawings, { ...preview, __preview: true }] : drawings;
      ctx.save();
      try {
        for (const d of list) {
          const sh = this._shapes(d, mediaSize.width, mediaSize.height);
          const selected = d.id === selectedId;
          const alpha = d.__preview ? 0.6 : 1;
          for (const f of sh.fills) {
            ctx.fillStyle = withAlpha(f.color, f.alpha * alpha);
            ctx.fillRect(f.x, f.y, f.w, f.h);
          }
          for (const s of sh.segs) {
            ctx.strokeStyle = withAlpha(s.color, alpha);
            ctx.lineWidth = (s.w || 1) + (selected ? 1 : 0);
            ctx.setLineDash(d.__preview ? [6, 4] : (s.dash || []));
            ctx.beginPath();
            ctx.moveTo(s.x1, s.y1);
            ctx.lineTo(s.x2, s.y2);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          for (const l of sh.labels) this._label(ctx, l, alpha);
          if (selected) {
            for (const h of sh.handles) {
              ctx.fillStyle = '#fff';
              ctx.strokeStyle = d.color;
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.arc(h.x, h.y, 5, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            }
          }
        }
        if (ruler) this._ruler(ctx, ruler, mediaSize.width);
      } finally {
        ctx.restore();
      }
    });
  }

  _label(ctx, l, alpha) {
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(l.text).width;
    const padX = 6, h = 18;
    let x = l.x;
    if (l.align === 'right') x = l.x - w - padX * 2;
    if (l.box) {
      ctx.fillStyle = withAlpha('#11161f', 0.78 * alpha);
      ctx.strokeStyle = withAlpha(l.color, alpha);
      ctx.lineWidth = 1;
      this._round(ctx, x, l.y - h / 2, w + padX * 2, h, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e8ecf4';
      ctx.fillText(l.text, x + padX, l.y);
    } else {
      ctx.fillStyle = withAlpha(l.color, alpha);
      ctx.fillText(l.text, x + (l.align === 'right' ? padX : 0), l.y);
    }
  }

  _round(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _ruler(ctx, r, width) {
    const a = this._pxy(r.p1), b = this._pxy(r.p2);
    if (!a || !b) return;
    const color = r.up ? UP : DOWN;
    // коробка «время × цена» между точками
    ctx.fillStyle = withAlpha(color, 0.1);
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeStyle = withAlpha(color, 0.9);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [a, b]) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // подпись у второй точки, внутри области графика
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    const w = ctx.measureText(r.text).width + 16;
    let x = b.x + 10;
    if (x + w > width - 4) x = b.x - w - 10;
    const y = Math.max(14, b.y - 14);
    ctx.fillStyle = withAlpha('#11161f', 0.9);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    this._round(ctx, x, y - 11, w, 22, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e8ecf4';
    ctx.textBaseline = 'middle';
    ctx.fillText(r.text, x + 8, y);
  }
}
