// Проверка выгрузки отчёта (npm run test:exportreport): PDF и Word собираются из модели, содержат нужные разделы и текст на
// кириллице, лишние разделы не попадают, пустой период и фильтры не ломают сборку, графики — корректный SVG.
import { createRequire } from 'module';
import { sampleReport } from './reports/sampleModel.mjs';
import { buildPdfDefinition } from '../src/services/report/pdfDoc.js';
import { buildDocx, Packer } from '../src/services/report/docxDoc.js';
import { renderPdfBuffer } from './reports/pdfNode.mjs';
import { equityCurveSvg, hBarsSvg, vBarsSvg, axisLabel, valueLabel } from '../src/services/report/charts.js';

import zlib from 'zlib';

const require = createRequire(import.meta.url);
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

async function pdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, verbosity: 0 }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    text += c.items.map((x) => x.str).join(' ') + '\n';
  }
  return { pages: doc.numPages, text: text.replace(/ /g, ' ').replace(/\s+/g, ' ') };
}
// Минимальное чтение zip (центральный каталог + inflate): библиотеки для zip в проекте нет, а .docx — это zip.
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('не zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lh = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.slice(lh, lh + csize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nlen + elen + clen;
  }
  return files;
}
async function docxXml(buf) {
  const files = readZip(buf);
  const xml = files['word/document.xml'].toString('utf8');
  const media = Object.keys(files).filter((f) => f.startsWith('word/media/'));
  return { xml: xml.replace(/<[^>]+>/g, ' ').replace(/ /g, ' ').replace(/\s+/g, ' '), media, files: Object.keys(files) };
}

// ---- графики ----
const pts = [{ label: '01.10', cumulative: 0 }, { label: '02.10', cumulative: 1200 }, { label: '03.10', cumulative: -300 }, { label: '04.10', cumulative: 2500 }];
const svg1 = equityCurveSvg(pts);
ok('кривая: корректный SVG с линией, подписями и итогом на конце', svg1.startsWith('<svg') && svg1.endsWith('</svg>') && /<path d="M/.test(svg1) && svg1.includes('+2 500') && svg1.includes('04.10'));
ok('кривая из одной точки и пустая не ломаются', equityCurveSvg([{ label: 'a', cumulative: 5 }]).includes('<circle') && equityCurveSvg([]).endsWith('</svg>'));
ok('столбцы: подписи экранируются (знак & в названии стратегии)', hBarsSvg([{ label: 'A & <B>', value: 100 }, { label: 'C', value: -50 }]).includes('A &amp; &lt;B&gt;'));
ok('столбцы по дням недели: 7 подписей', (vBarsSvg(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((l, i) => ({ label: l, value: (i - 3) * 100, sub: String(i) }))).match(/font-weight="bold" fill="#1e293b"/g) || []).length === 7);
ok('подписи осей: «12 тыс», «1,5 млн», «−850»', axisLabel(12400) === '12 тыс' && axisLabel(1500000) === '1,5 млн' && axisLabel(-850) === '−850' && valueLabel(-1234) === '−1 234');

// ---- PDF ----
const model = sampleReport();
const buf = await renderPdfBuffer(buildPdfDefinition(model));
ok('PDF собирается: заголовок %PDF и разумный размер', buf.slice(0, 4).toString() === '%PDF' && buf.length > 8000);
const t = await pdfText(buf);
ok('PDF: несколько страниц, период и разделы на русском', t.pages >= 3 && t.text.includes('Октябрь 2026') && t.text.includes('Итоги периода') && t.text.includes('По инструментам') && t.text.includes('Динамика результата'));
ok('PDF: итоговые цифры и вывод словами на месте', t.text.includes('+37 507 ₽') && /закрытая сделка, результат/.test(t.text) && t.text.includes('ПРОФИТ'));
ok('PDF: привычки, «я против системы» и список сделок есть, если выбраны', t.text.includes('Привычки и что они стоили') && t.text.includes('Я против системы') && t.text.includes('Все закрытые сделки'));
ok('PDF: в колонтитуле предупреждение «не является инвестиционной рекомендацией» и номера страниц', t.text.includes('не является инвестиционной рекомендацией') && /1 \/ \d/.test(t.text));

const small = sampleReport({ sections: ['summary'] });
const t2 = await pdfText(await renderPdfBuffer(buildPdfDefinition(small)));
ok('PDF: невыбранные разделы не попадают (только итоги)', t2.pages === 1 && t2.text.includes('Итоги периода') && !t2.text.includes('По инструментам') && !t2.text.includes('Динамика результата') && !t2.text.includes('Все закрытые сделки'));

const paperOnly = sampleReport({ scope: 'paper' });
const t3 = await pdfText(await renderPdfBuffer(buildPdfDefinition(paperOnly)));
ok('PDF в срезе «Бумажные»: в шапке указан срез, в привычках — пояснение', t3.text.includes('Бумажные') && /только по реальным сделкам/.test(t3.text));

const filtered = sampleReport({ strategyNames: ['Тренд H1'.replace('H', 'Н')] });
const t4 = await pdfText(await renderPdfBuffer(buildPdfDefinition(filtered)));
ok('PDF с фильтром стратегии: в шапке указана стратегия', t4.text.includes('Тренд Н1'));

const empty = sampleReport({ preset: 'last_year' });
const t5 = await pdfText(await renderPdfBuffer(buildPdfDefinition(empty)));
ok('PDF за пустой период: собирается, есть пояснение «закрытых сделок не было»', empty.empty && t5.pages === 1 && /закрытых сделок не было/.test(t5.text));

const week = sampleReport({ preset: 'last_week' });
const t6 = await pdfText(await renderPdfBuffer(buildPdfDefinition(week)));
ok('PDF за неделю: в заголовке «Неделя …»', /Неделя 26 октября/.test(t6.text));

// ---- Word ----
const dbuf = await Packer.toBuffer(buildDocx(model));
ok('Word собирается: zip с document.xml', dbuf.slice(0, 2).toString() === 'PK');
const d = await docxXml(dbuf);
ok('Word: период, разделы, цифры и вывод на русском', d.xml.includes('Октябрь 2026') && d.xml.includes('Итоги периода') && d.xml.includes('По инструментам') && d.xml.includes('+37 507 ₽') && d.xml.includes('Привычки и что они стоили'));
ok('Word без картинок: графиков-файлов нет, но документ полный', d.media.length === 0 && d.xml.includes('Все закрытые сделки'));
const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const dimg = await docxXml(await Packer.toBuffer(buildDocx(model, { images: { curve: { data: new Uint8Array(png1x1), width: 515, height: 200, alt: 'График' } } })));
ok('Word с картинкой графика: изображение вложено', dimg.media.length === 1);
const dsmall = await docxXml(await Packer.toBuffer(buildDocx(sampleReport({ sections: ['summary', 'trades'] }))));
ok('Word: невыбранные разделы не попадают', dsmall.xml.includes('Итоги периода') && dsmall.xml.includes('Все закрытые сделки') && !dsmall.xml.includes('По инструментам'));
const dempty = await docxXml(await Packer.toBuffer(buildDocx(empty)));
ok('Word за пустой период: собирается, есть пояснение', /закрытых сделок не было/.test(dempty.xml));

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки выгрузки отчёта прошли ✓');
