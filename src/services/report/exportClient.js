// src/services/report/exportClient.js
//
// Выгрузка отчёта в браузере: PDF (pdfmake) и Word (docx). Тяжёлые библиотеки подгружаются только при нажатии кнопки
// (динамический import), поэтому на размер основной части сайта они не влияют.
import { equityCurveSvg, hBarsSvg, vBarsSvg } from './charts';

export { reportFileName } from './exportReport';

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
}

export async function buildPdfBlob(model) {
  const [pm, vfsMod, { buildPdfDefinition }] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
    import('./pdfDoc'),
  ]);
  const pdfMake = pm.default || pm;
  pdfMake.addVirtualFileSystem(vfsMod.default || vfsMod);
  return pdfMake.createPdf(buildPdfDefinition(model)).getBlob();
}

/** SVG-строка → PNG (Uint8Array) через canvas; фон белый, вдвое выше разрешение для чёткости. */
export function rasterizeSvg(svg, width, height, scale = 2) {
  const safe = svg.split('font-family="Roboto"').join('font-family="Calibri, Carlito, Arial, Helvetica, sans-serif"');
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([safe], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(width * scale); c.height = Math.round(height * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(async (b) => {
        if (!b) { reject(new Error('Не удалось нарисовать график')); return; }
        resolve({ data: new Uint8Array(await b.arrayBuffer()), width, height });
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось нарисовать график')); };
    img.src = url;
  });
}

const pick = (rows, max) => {
  if (rows.length <= max) return rows;
  const head = Math.ceil(max * 0.6);
  return [...rows.slice(0, head), ...rows.slice(rows.length - (max - head))];
};

/** Картинки графиков для Word; ошибка одного графика не мешает остальным — документ просто без него. */
export async function renderChartImages(model) {
  const W = 515;
  const jobs = {};
  if (model.curve.points.length > 1) jobs.curve = [equityCurveSvg(model.curve.points, { width: W, height: 200 }), W, 200, 'Накопленный результат'];
  if (model.byInstrument.length) { const r = pick(model.byInstrument, 12); jobs.instruments = [hBarsSvg(r.map((g) => ({ label: g.label, value: g.pnl })), { width: W }), W, 8 + r.length * 22, 'По инструментам']; }
  if (model.byStrategy.length) { const r = pick(model.byStrategy, 10); jobs.strategies = [hBarsSvg(r.map((g) => ({ label: g.label, value: g.pnl })), { width: W, labelW: 150 }), W, 8 + r.length * 22, 'По стратегиям']; }
  if (model.byWeekday.some((w) => w.count)) jobs.weekdays = [vBarsSvg(model.byWeekday.map((w) => ({ label: w.short, value: w.pnl, sub: String(w.count) })), { width: W }), W, model.byWeekday.some((w) => w.pnl < 0) ? 184 : 170, 'По дням недели'];
  const out = {};
  await Promise.all(Object.entries(jobs).map(async ([k, [svg, w, h, alt]]) => {
    try { out[k] = { ...(await rasterizeSvg(svg, w, h)), alt }; } catch { /* без графика */ }
  }));
  return out;
}

export async function buildDocxBlob(model) {
  const { buildDocx, Packer } = await import('./docxDoc');
  const images = await renderChartImages(model);
  return Packer.toBlob(buildDocx(model, { images }));
}
