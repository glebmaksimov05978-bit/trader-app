// Пример: собрать Word по примерным данным (графики растеризует resvg, если он установлен) и записать в файл.
// node scripts/reports/renderSampleDocx.mjs <выходной.docx> [scope] [preset]
import fs from 'fs';
import { createRequire } from 'module';
import { sampleReport } from './sampleModel.mjs';
import { buildDocx, Packer } from '../../src/services/report/docxDoc.js';
import { equityCurveSvg, hBarsSvg, vBarsSvg } from '../../src/services/report/charts.js';

const require = createRequire(import.meta.url);
const out = process.argv[2] || 'sample-report.docx';
const model = sampleReport({ scope: process.argv[3] || 'real', preset: process.argv[4] || 'last_month' });

let images = {};
try {
  const { Resvg } = require('@resvg/resvg-js');
  const png = (svg, w, h, alt) => {
    const r = new Resvg(svg, { fitTo: { mode: 'width', value: w * 2 }, background: 'white', font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } });
    return { data: new Uint8Array(r.render().asPng()), width: w, height: h, alt };
  };
  const pick = (rows, max) => (rows.length <= max ? rows : [...rows.slice(0, Math.ceil(max * 0.6)), ...rows.slice(rows.length - (max - Math.ceil(max * 0.6)))]);
  images = {
    curve: png(equityCurveSvg(model.curve.points, { width: 515, height: 200 }), 515, 200, 'Накопленный результат'),
    instruments: (() => { const r = pick(model.byInstrument, 12); const s = hBarsSvg(r.map((g) => ({ label: g.label, value: g.pnl })), { width: 515 }); return png(s, 515, 4 + r.length * 22 + 4, 'По инструментам'); })(),
    strategies: (() => { const r = pick(model.byStrategy, 10); const s = hBarsSvg(r.map((g) => ({ label: g.label, value: g.pnl })), { width: 515, labelW: 150 }); return png(s, 515, 4 + r.length * 22 + 4, 'По стратегиям'); })(),
    weekdays: png(vBarsSvg(model.byWeekday.map((w) => ({ label: w.short, value: w.pnl, sub: String(w.count) })), { width: 515 }), 515, Math.min(...model.byWeekday.map((w) => w.pnl)) < 0 ? 184 : 170, 'По дням недели'),
  };
} catch (e) { console.log('resvg недоступен — графики не вставляются:', e.message); }

const buf = await Packer.toBuffer(buildDocx(model, { images }));
fs.writeFileSync(out, buf);
console.log(`${out}: ${Math.round(buf.length / 1024)} КБ`);
