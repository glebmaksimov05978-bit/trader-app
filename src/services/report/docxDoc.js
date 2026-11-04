// src/services/report/docxDoc.js
//
// Оформление отчёта в Word (.docx): та же модель, что и у PDF (pdfDoc.js), тот же стиль — тёмная шапка, светлые карточки, один
// акцентный цвет. Графики вставляются картинками PNG (их растеризует вызывающий код: в браузере через canvas), без них
// документ остаётся полноценным — таблицы и текст на месте. Шрифт Calibri есть в любом Word.
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType, BorderStyle,
  ImageRun, Header, Footer, PageNumber, TableLayoutType, VerticalAlign, TabStopType,
} from 'docx';
import { PALETTE as P } from './charts.js';
import { fmtMoney, fmtPct, fmtPF, plural } from './exportReport.js';

const FONT = 'Calibri';
const CONTENT_W = 9638; // ширина текста A4 при полях 2 см, в twips (1/20 pt)
const hex = (c) => c.replace('#', '').toUpperCase();
const sign = (v) => (v > 0 ? P.green : v < 0 ? P.red : P.muted);
const dateRu = (ms, tz = 180) => {
  const d = new Date(ms + tz * 60000);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
};

const run = (text, o = {}) => new TextRun({
  text: String(text), font: FONT, size: Math.round((o.size || 10) * 2), bold: !!o.bold, italics: !!o.italics,
  color: hex(o.color || P.text), characterSpacing: o.spacing ? Math.round(o.spacing * 20) : undefined, break: o.break,
});
const para = (children, o = {}) => new Paragraph({
  children: Array.isArray(children) ? children : [children],
  alignment: o.align, keepNext: !!o.keepNext, keepLines: true,
  spacing: { before: Math.round((o.before || 0) * 20), after: Math.round((o.after || 0) * 20), line: o.line ? Math.round(o.line * 240) : undefined },
  border: o.border, shading: o.shading, indent: o.indent, tabStops: o.tabStops, pageBreakBefore: o.pageBreakBefore,
});

const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE };
const line = (color, size = 6) => ({ style: BorderStyle.SINGLE, size, color: hex(color) });

function cell(children, o = {}) {
  return new TableCell({
    children: Array.isArray(children) ? children : [children],
    width: o.width ? { size: o.width, type: WidthType.DXA } : undefined,
    shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: hex(o.fill) } : undefined,
    borders: o.borders || NO_BORDERS,
    margins: o.margins || { top: 80, bottom: 80, left: 140, right: 140 },
    verticalAlign: o.v || VerticalAlign.CENTER,
    columnSpan: o.span,
  });
}
const table = (rows, widths, o = {}) => new Table({
  rows, width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths,
  layout: TableLayoutType.FIXED, borders: { ...NO_BORDERS, insideHorizontal: NONE, insideVertical: NONE }, ...o,
});

// ---------- блоки ----------
function sectionTitle(text, hint, opts = {}) {
  const out = [para(run(text, { size: 14, bold: true, color: P.ink }), {
    before: 16, after: hint ? 1 : 6, keepNext: true, pageBreakBefore: opts.pageBreakBefore,
    border: { left: { style: BorderStyle.SINGLE, size: 24, color: hex(P.accent), space: 6 } }, indent: { left: 140 },
  })];
  if (hint) out.push(para(run(hint, { size: 8.5, color: P.muted }), { after: 6, keepNext: true, indent: { left: 140 } }));
  return out;
}

function kpiRow(cards) {
  const w = Math.floor(CONTENT_W / cards.length);
  const gap = { style: BorderStyle.SINGLE, size: 18, color: 'FFFFFF' };
  return table([new TableRow({
    cantSplit: true,
    children: cards.map((c) => cell([
      para(run(c.label.toUpperCase(), { size: 7, bold: true, color: P.muted, spacing: 0.6 }), { after: 2 }),
      para(run(c.value, { size: 17, bold: true, color: c.color || P.ink }), { after: 1 }),
      para(run(c.sub || ' ', { size: 7.5, color: P.muted })),
    ], { width: w, fill: P.card, borders: { top: line(c.accent || P.line, 18), left: gap, right: gap, bottom: gap }, margins: { top: 100, bottom: 100, left: 160, right: 140 }, v: VerticalAlign.TOP })),
  })], cards.map(() => w));
}

function callout(text, color = P.accent) {
  return table([new TableRow({
    children: [cell(para(run(text, { size: 10.5, color: P.ink }), { line: 1.25 }), { width: CONTENT_W, fill: P.card, borders: { ...NO_BORDERS, left: line(color, 24) }, margins: { top: 140, bottom: 140, left: 220, right: 200 } })],
  })], [CONTENT_W]);
}

const th = (text, w, align) => cell(para(run(text, { size: 7.5, bold: true, color: P.muted }), { align }), { width: w, fill: P.soft, margins: { top: 70, bottom: 70, left: 100, right: 100 } });
function td(text, w, o = {}, fill) {
  return cell(para(run(text, { size: o.size || 9, bold: !!o.bold, color: o.color || P.text }), { align: o.align }), { width: w, fill, margins: { top: 60, bottom: 60, left: 100, right: 100 } });
}
const pnlTd = (v, w, fill) => td(fmtMoney(v), w, { align: AlignmentType.RIGHT, bold: true, color: sign(v) }, fill);
const R = AlignmentType.RIGHT;

function groupTable(rows, first) {
  const w = [Math.floor(CONTENT_W * 0.36), 1000, 1400, 1900, 1500];
  w[0] = CONTENT_W - w[1] - w[2] - w[3] - w[4];
  return table([
    new TableRow({ tableHeader: true, cantSplit: true, children: [th(first, w[0]), th('Сделок', w[1], R), th('Прибыльных', w[2], R), th('Результат', w[3], R), th('Средняя', w[4], R)] }),
    ...rows.map((g, i) => new TableRow({
      cantSplit: true,
      children: [td(g.label, w[0], { bold: true }, i % 2 ? P.card : undefined), td(String(g.count), w[1], { align: R }, i % 2 ? P.card : undefined), td(fmtPct(g.winrate), w[2], { align: R }, i % 2 ? P.card : undefined),
        pnlTd(g.pnl, w[3], i % 2 ? P.card : undefined), td(fmtMoney(g.avg), w[4], { align: R, color: sign(g.avg) }, i % 2 ? P.card : undefined)],
    })),
  ], w);
}

function tradesTable(rows) {
  const w = [1150, 0, 850, 2400, 1750];
  w[1] = CONTENT_W - w[0] - w[2] - w[3] - w[4];
  return table([
    new TableRow({ tableHeader: true, cantSplit: true, children: [th('Дата', w[0]), th('Инструмент', w[1]), th('Сторона', w[2]), th('Стратегия', w[3]), th('Результат', w[4], R)] }),
    ...rows.map((t, i) => new TableRow({
      cantSplit: true,
      children: [td(t.date, w[0], {}, i % 2 ? P.card : undefined), td(t.ticker, w[1], { bold: true }, i % 2 ? P.card : undefined), td(t.side, w[2], { color: P.muted }, i % 2 ? P.card : undefined),
        td(t.strategy, w[3], { color: P.muted, size: 8.5 }, i % 2 ? P.card : undefined), pnlTd(t.pnl, w[4], i % 2 ? P.card : undefined)],
    })),
  ], w);
}

function bestWorstTable(best, worst) {
  const half = Math.floor((CONTENT_W - 300) / 2);
  const col = (title, rows, color) => {
    const inner = [para(run(title, { size: 9.5, bold: true, color }), { after: 3 })];
    if (!rows.length) inner.push(para(run('Нет сделок', { size: 8.5, italics: true, color: P.muted })));
    rows.forEach((t) => inner.push(para([
      run(`${t.date}   `, { size: 8, color: P.muted }), run(t.ticker, { size: 9.5, bold: true }), run(`   ${t.side} · ${t.strategy}   `, { size: 8, color: P.muted }), run(fmtMoney(t.pnl), { size: 9.5, bold: true, color: sign(t.pnl) }),
    ], { after: 3 })));
    return cell(inner, { width: half, margins: { top: 40, bottom: 40, left: 0, right: 80 }, v: VerticalAlign.TOP });
  };
  return table([new TableRow({ children: [col('Лучшие', best, P.green), cell(para(run(' ')), { width: 300 }), col('Худшие', worst, P.red)] })], [half, 300, half]);
}

function statCell(title, s, w) {
  const has = s.total || s.partialEvents;
  return cell([
    para(run(title, { size: 9.5, bold: true, color: P.ink }), { after: 4 }),
    para(run(has ? fmtMoney(s.pnl) : '—', { size: 18, bold: true, color: s.total ? sign(s.pnl) : P.muted }), { after: 2 }),
    para(run(s.total ? `${s.total} ${plural(s.total, ['сделка', 'сделки', 'сделок'])} · ${fmtPct(s.winrate)} прибыльных · профит-фактор ${fmtPF(s.profitFactor)}` : 'Закрытых сделок нет', { size: 8, color: P.muted })),
  ], { width: w, fill: P.card, margins: { top: 140, bottom: 140, left: 200, right: 160 }, v: VerticalAlign.TOP });
}

function image(png, width = 600) {
  if (!png?.data) return null;
  const h = Math.round(width * (png.height / png.width));
  return para(new ImageRun({ type: 'png', data: png.data, transformation: { width, height: h }, altText: { title: png.alt || 'График', description: png.alt || 'График', name: png.alt || 'chart' } }), { after: 4 });
}

function pickRows(rows, max) {
  if (rows.length <= max) return rows;
  const head = Math.ceil(max * 0.6);
  return [...rows.slice(0, head), ...rows.slice(rows.length - (max - head))];
}

/**
 * @param {object} m — модель (buildExportReport)
 * @param {{images?: {curve?, instruments?, strategies?, weekdays?}, footer?: string}} [opts]
 *   images.* = { data: Uint8Array, width: px, height: px, alt?: string } — PNG графика; нет картинки — раздел без графика.
 */
export function buildDocx(m, opts = {}) {
  const imgs = opts.images || {};
  const has = (id) => m.sections.includes(id);
  const s = m.stats;
  const kids = [];

  // шапка
  kids.push(table([new TableRow({
    children: [cell([
      para([run('TRADERPRO  ·  ОТЧЁТ ПО ТОРГОВЛЕ', { size: 7.5, bold: true, color: '#A5B4FC', spacing: 1.2 }), ...(m.meta.userName ? [run(`\t${m.meta.userName}`, { size: 8, color: '#94A3B8' })] : [])], { tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W - 600 }] }),
      para(run(m.meta.period.title, { size: 27, bold: true, color: '#FFFFFF' }), { before: 8, after: 3 }),
      para(run([m.meta.period.rangeText, m.meta.scopeLabel, m.meta.strategiesText].join('  ·  '), { size: 9, color: '#CBD5E1' })),
    ], { width: CONTENT_W, fill: P.ink, margins: { top: 360, bottom: 340, left: 440, right: 440 }, v: VerticalAlign.TOP })],
  })], [CONTENT_W]));
  kids.push(table([new TableRow({ children: [cell(para(run(' ', { size: 2 })), { width: CONTENT_W, fill: P.accent, margins: { top: 0, bottom: 0, left: 0, right: 0 } })] })], [CONTENT_W]));
  kids.push(para(run(`Сформировано ${dateRu(m.meta.generatedAt)}. Результаты — по закрытым сделкам, в рублях.`, { size: 7.5, color: P.muted }), { before: 3, after: 4 }));

  if (m.empty) {
    kids.push(callout(m.verdict, P.gold));
    return finish(kids, m, opts);
  }

  if (has('summary')) {
    const dText = m.delta.hasPrev ? `${fmtMoney(m.delta.pnl)} к периоду «${m.meta.prevPeriod.title}»` : 'нет данных за прошлый период';
    kids.push(...sectionTitle('Итоги периода'));
    kids.push(kpiRow([
      { label: 'Результат', value: fmtMoney(s.pnl), sub: dText, color: sign(s.pnl), accent: sign(s.pnl) },
      { label: 'Закрытых сделок', value: String(s.total), sub: `${s.wins} прибыльных · ${s.total - s.wins} прочих`, accent: P.accent },
      { label: 'Прибыльных', value: fmtPct(s.winrate), sub: m.delta.winrate != null ? `${m.delta.winrate >= 0 ? '+' : '−'}${Math.abs(m.delta.winrate).toFixed(0)} п.п. к прошлому` : ' ', accent: P.accent },
      { label: 'Профит-фактор', value: fmtPF(s.profitFactor), sub: 'прибыль / убыток', accent: P.accent },
    ]));
    kids.push(para(run(' ', { size: 3 })));
    kids.push(kpiRow([
      { label: 'Средняя сделка', value: fmtMoney(s.avg), color: sign(s.avg) },
      { label: 'Средняя прибыль', value: s.avgWin ? fmtMoney(s.avgWin) : '—', color: P.green },
      { label: 'Средний убыток', value: s.avgLoss ? fmtMoney(s.avgLoss) : '—', color: P.red },
      { label: 'Макс. просадка', value: s.maxDrawdown ? fmtMoney(-s.maxDrawdown) : '0 ₽', sub: 'внутри периода', color: s.maxDrawdown ? P.red : P.muted },
    ]));
    kids.push(para(run(' ', { size: 4 })));
    kids.push(callout(m.verdict));
    m.notes.forEach((n) => kids.push(para(run(n, { size: 8.5, italics: true, color: P.muted }), { before: 3 })));
  }

  if (has('curve') && m.curve.points.length > 1) {
    const g = m.curve.granularity;
    kids.push(...sectionTitle('Динамика результата', `Накопленный результат ${g === 'day' ? 'по дням' : g === 'week' ? 'по неделям' : 'по месяцам'}, ₽`));
    const im = image(imgs.curve); if (im) kids.push(im);
  }

  if (has('best_worst') && (m.best.length || m.worst.length)) {
    kids.push(...sectionTitle('Лучшие и худшие сделки', 'Пять лучших и пять худших закрытых сделок периода'));
    kids.push(bestWorstTable(m.best, m.worst));
  }

  if (has('instruments') && m.byInstrument.length) {
    const rows = pickRows(m.byInstrument, 12);
    kids.push(...sectionTitle('По инструментам', 'Результат по каждому инструменту, от лучшего к худшему'));
    const im = image(imgs.instruments); if (im) kids.push(im);
    kids.push(groupTable(rows, 'Инструмент'));
    if (rows.length < m.byInstrument.length) kids.push(para(run(`Показано ${rows.length} из ${m.byInstrument.length}: лучшие и худшие.`, { size: 7.5, color: P.muted }), { before: 3 }));
  }

  if (has('strategies') && m.byStrategy.length) {
    const rows = pickRows(m.byStrategy, 10);
    kids.push(...sectionTitle('По стратегиям', 'Какая стратегия как отработала за период'));
    const im = image(imgs.strategies); if (im) kids.push(im);
    kids.push(groupTable(rows, 'Стратегия'));
  }

  if (has('weekdays') && m.byWeekday.some((w) => w.count)) {
    kids.push(...sectionTitle('По дням недели', 'Результат сделок по дню закрытия; под днём — число сделок'));
    const im = image(imgs.weekdays); if (im) kids.push(im);
    else kids.push(table([new TableRow({ children: m.byWeekday.map((w) => cell([para(run(w.short, { size: 9, bold: true }), { align: AlignmentType.CENTER }), para(run(fmtMoney(w.pnl), { size: 9, bold: true, color: sign(w.pnl) }), { align: AlignmentType.CENTER }), para(run(`${w.count} сд.`, { size: 7.5, color: P.muted }), { align: AlignmentType.CENTER })], { width: Math.floor(CONTENT_W / 7), fill: P.card })) })], m.byWeekday.map(() => Math.floor(CONTENT_W / 7))));
  }

  if (has('versus') && (m.versus.real.total || m.versus.paper.total)) {
    kids.push(...sectionTitle('Я против системы', 'Ваши реальные сделки рядом с бумажными сделками робота за тот же период'));
    const half = Math.floor((CONTENT_W - 200) / 2);
    kids.push(table([new TableRow({ cantSplit: true, children: [statCell('Ваши реальные сделки', m.versus.real, half), cell(para(run(' ')), { width: 200 }), statCell('Бумажные сделки робота', m.versus.paper, half)] })], [half, 200, half]));
    kids.push(para(run('Бумажные сделки открывает робот по правилам стратегий, реальных денег они не касаются. Сравнение показывает, чем ваши решения отличались от правил.', { size: 8, color: P.muted }), { before: 4 }));
  }

  if (has('habits')) {
    kids.push(...sectionTitle('Привычки и что они стоили', 'Находки движка привычек по вашим реальным сделкам периода'));
    if (m.habits && m.habits.list.length) {
      m.habits.list.forEach((h) => {
        const col = h.confidence === 'confirmed' ? P.red : P.gold;
        kids.push(table([new TableRow({
          cantSplit: true,
          children: [cell([
            para([run(h.title, { size: 10, bold: true, color: P.ink }), run(h.costRub ? `\t≈ ${fmtMoney(-h.costRub)}` : '', { size: 10, bold: true, color: P.red })], { tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W - 400 }] }),
            para(run(`${h.confidence === 'confirmed' ? 'Подтверждено' : 'Гипотеза'} · разобрано ${h.sampleSize} ${plural(h.sampleSize, ['сделка', 'сделки', 'сделок'])}`, { size: 7.5, color: col }), { before: 1, after: 2 }),
            ...(h.detail ? [para(run(h.detail, { size: 8.5, color: P.muted }), { line: 1.1 })] : []),
          ], { width: CONTENT_W, fill: P.card, borders: { ...NO_BORDERS, left: line(col, 24) }, margins: { top: 110, bottom: 110, left: 220, right: 200 }, v: VerticalAlign.TOP })],
        })], [CONTENT_W]));
        kids.push(para(run(' ', { size: 4 })));
      });
      kids.push(para(run('Наблюдения, а не советы: подтверждёнными считаются выводы от 25 сделок, меньше — гипотезы.', { size: 7.5, color: P.muted })));
    } else if (m.habits) {
      kids.push(para(run('Дорогих привычек за период движок не нашёл — либо их правда нет, либо сделок пока мало для вывода.', { size: 9.5, color: P.muted })));
    } else {
      kids.push(para(run(m.meta.scope === 'paper' ? 'Привычки считаются только по реальным сделкам — в срезе «Бумажные» этого раздела нет.' : 'Для этого периода раздел недоступен: нет реальных сделок или не подключён движок привычек.', { size: 9.5, color: P.muted })));
    }
  }

  if (has('trades') && m.trades.length) {
    kids.push(...sectionTitle('Все закрытые сделки', `${m.trades.length} ${plural(m.trades.length, ['сделка', 'сделки', 'сделок'])} за период`, { pageBreakBefore: true }));
    kids.push(tradesTable(m.trades));
  }

  return finish(kids, m, opts);
}

function finish(children, m, opts) {
  const footerText = opts.footer || 'Отчёт сформирован автоматически по вашим сделкам и не является инвестиционной рекомендацией.';
  const tab = [{ type: TabStopType.RIGHT, position: CONTENT_W }];
  return new Document({
    creator: 'TraderPro', title: `${m.meta.title} — ${m.meta.period.title}`, description: m.meta.period.rangeText,
    styles: { default: { document: { run: { font: FONT, size: 20, color: hex(P.text) } } } },
    sections: [{
      properties: { titlePage: true, page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, bottom: 900, left: 1134, right: 1134, header: 500, footer: 400 } } },
      headers: {
        first: new Header({ children: [para(run(' ', { size: 2 }))] }),
        default: new Header({ children: [para([run('TRADERPRO', { size: 7.5, bold: true, color: P.accent, spacing: 1.2 }), run(`\t${m.meta.period.title}  ·  ${m.meta.scopeLabel}`, { size: 7.5, color: P.muted })], { tabStops: tab })] }),
      },
      footers: {
        first: new Footer({ children: [para([run(footerText, { size: 7, color: P.faint }), new TextRun({ children: ['\t', PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], font: FONT, size: 15, color: hex(P.muted) })], { tabStops: tab })] }),
        default: new Footer({ children: [para([run(footerText, { size: 7, color: P.faint }), new TextRun({ children: ['\t', PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], font: FONT, size: 15, color: hex(P.muted) })], { tabStops: tab })] }),
      },
      children,
    }],
  });
}

/** Готовый файл .docx. В браузере вернёт Blob, в Node — Buffer (см. вызывающий код). */
export { Packer };
