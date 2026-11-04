// Пример: собрать PDF по примерным данным и записать в файл (для проверки оформления глазами).
// node scripts/reports/renderSample.mjs <выходной.pdf> [scope] [preset]
import fs from 'fs';
import { sampleReport } from './sampleModel.mjs';
import { buildPdfDefinition } from '../../src/services/report/pdfDoc.js';
import { renderPdfBuffer } from './pdfNode.mjs';

const out = process.argv[2] || 'sample-report.pdf';
const scope = process.argv[3] || 'real';
const preset = process.argv[4] || 'last_month';
const model = sampleReport({ scope, preset });
const buf = await renderPdfBuffer(buildPdfDefinition(model));
fs.writeFileSync(out, buf);
console.log(`${out}: ${Math.round(buf.length / 1024)} КБ`);
