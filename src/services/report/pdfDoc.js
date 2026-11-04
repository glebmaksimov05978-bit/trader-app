// src/services/report/pdfDoc.js
//
// Оформление отчёта в PDF: описание документа для pdfmake (чистая функция — модель → объект). Один и тот же документ собирается
// в браузере (кнопка «Скачать PDF») и на сервере (отправка по расписанию). Шрифт — Roboto (поддерживает кириллицу).
// Стиль: сдержанный, матовый — тёмная шапка, светлые карточки, один акцентный цвет, зелёный/красный только для результата.
import { PALETTE as C, equityCurveSvg, hBarsSvg, vBarsSvg } from './charts.js';
import { fmtMoney, fmtPct, fmtPF, plural } from './exportReport.js';

const W = 515; // ширина области текста при полях 40
const sign = (v) => (v > 0 ? C.green : v < 0 ? C.red : C.muted);
const dateRu = (ms, tz = 180) => {
  const d = new Date(ms + tz * 60000);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
};

// ---------- кирпичики ----------
function sectionTitle(text, hint) {
  return {
    stack: [
      { columns: [{ canvas: [{ type: 'rect', x: 0, y: 1, w: 4, h: 15, color: C.accent }], width: 10 }, { text, style: 'h2', width: '*' }], columnGap: 0 },
      ...(hint ? [{ text: hint, style: 'hint', margin: [10, 1, 0, 0] }] : []),
    ],
    margin: [0, 18, 0, 8], unbreakable: true,
  };
}

// Заголовок раздела и его первый блок держим вместе: заголовок не должен оставаться один внизу страницы.
const block = (title, first) => ({ stack: [title, first], unbreakable: true });

const noBorder = [false, false, false, false];

function card({ label, value, sub, color = C.ink, accent = C.line }) {
  return {
    stack: [
      { text: label.toUpperCase(), fontSize: 7, characterSpacing: 0.6, color: C.muted, bold: true },
      { text: value, fontSize: 17, bold: true, color, margin: [0, 4, 0, 2] },
      { text: sub || ' ', fontSize: 7.5, color: C.muted },
    ],
    fillColor: C.card, margin: [9, 8, 9, 8],
    border: [false, true, false, false], borderColor: [accent, accent, accent, accent],
  };
}

function cardsRow(cards) {
  const body = [];
  const widths = [];
  cards.forEach((c, i) => {
    if (i) { body.push({ text: '', border: noBorder }); widths.push(8); }
    body.push(c); widths.push('*');
  });
  return {
    table: { widths, body: [body] },
    layout: { hLineWidth: () => 2, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
    margin: [0, 0, 0, 8],
  };
}

function callout(text, color = C.accent) {
  return {
    table: { widths: ['*'], body: [[{ text, fontSize: 10.5, lineHeight: 1.4, color: C.ink, fillColor: C.card, margin: [12, 10, 12, 10], border: [true, false, false, false], borderColor: [color, color, color, color] }]] },
    layout: { hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 3 : 0), paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
    margin: [0, 4, 0, 6],
  };
}

const zebra = {
  hLineWidth: (i, node) => (i === 1 || i === node.table.body.length ? 0.6 : 0),
  hLineColor: () => C.line,
  vLineWidth: () => 0,
  fillColor: (row) => (row === 0 ? C.soft : row % 2 === 0 ? C.card : null),
  paddingLeft: () => 7, paddingRight: () => 7, paddingTop: () => 4.5, paddingBottom: () => 4.5,
};

const th = (text, alignment = 'left') => ({ text, fontSize: 7.5, bold: true, color: C.muted, alignment });
const td = (text, o = {}) => ({ text, fontSize: 9, ...o });

function pnlCell(v) { return td(fmtMoney(v), { alignment: 'right', bold: true, color: sign(v), noWrap: true }); }

function groupTable(rows, firstHeader) {
  return {
    table: {
      headerRows: 1, dontBreakRows: true, widths: ['*', 46, 58, 84, 74],
      body: [
        [th(firstHeader), th('Сделок', 'right'), th('Прибыльных', 'right'), th('Результат', 'right'), th('Средняя', 'right')],
        ...rows.map((g) => [td(g.label, { bold: true }), td(String(g.count), { alignment: 'right' }), td(fmtPct(g.winrate), { alignment: 'right' }), pnlCell(g.pnl), td(fmtMoney(g.avg), { alignment: 'right', color: sign(g.avg) })]),
      ],
    },
    layout: zebra,
  };
}

function tradesTable(rows, title) {
  return {
    table: {
      headerRows: 1, dontBreakRows: true, widths: [48, '*', 36, 96, 70],
      body: [
        [th('Дата'), th('Инструмент'), th('Сторона'), th('Стратегия'), th('Результат', 'right')],
        ...rows.map((t) => [td(t.date), td(t.ticker, { bold: true }), td(t.side, { color: C.muted }), td(t.strategy, { color: C.muted, fontSize: 8 }), pnlCell(t.pnl)]),
      ],
    },
    layout: zebra,
  };
}

function miniTable(title, rows, color) {
  return {
    stack: [
      { text: title, fontSize: 9, bold: true, color, margin: [0, 0, 0, 4] },
      rows.length ? {
        table: {
          widths: [46, '*', 66], dontBreakRows: true,
          body: rows.map((t) => [td(t.date, { fontSize: 8, color: C.muted }), { stack: [{ text: t.ticker, fontSize: 9, bold: true }, { text: `${t.side} · ${t.strategy}`, fontSize: 7, color: C.muted }] }, pnlCell(t.pnl)]),
        },
        layout: { hLineWidth: (i, n) => (i > 0 && i < n.table.body.length ? 0.5 : 0), hLineColor: () => C.line, vLineWidth: () => 0, paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 4, paddingBottom: () => 4 },
      } : { text: 'Нет сделок', fontSize: 8.5, color: C.muted, italics: true },
    ],
  };
}

function statBlock(title, s) {
  return {
    stack: [
      { text: title, fontSize: 9, bold: true, color: C.ink, margin: [0, 0, 0, 6] },
      { text: s.total || s.partialEvents ? fmtMoney(s.pnl) : '—', fontSize: 18, bold: true, color: s.total ? sign(s.pnl) : C.muted },
      { text: s.total ? `${s.total} ${plural(s.total, ['сделка', 'сделки', 'сделок'])} · ${fmtPct(s.winrate)} прибыльных · профит-фактор ${fmtPF(s.profitFactor)}` : 'Закрытых сделок нет', fontSize: 8, color: C.muted, margin: [0, 3, 0, 0] },
    ],
    fillColor: C.card, margin: [10, 9, 10, 9], border: noBorder,
  };
}

// ---------- сам документ ----------
/**
 * @param {object} model — результат buildExportReport
 * @param {{footer?: string}} [opts]
 * @returns {object} описание документа для pdfmake
 */
export function buildPdfDefinition(model, opts = {}) {
  const m = model;
  const has = (id) => m.sections.includes(id);
  const s = m.stats;
  const content = [];

  // --- шапка ---
  const sub = [m.meta.period.rangeText, m.meta.scopeLabel, m.meta.strategiesText].join('  ·  ');
  content.push({
    table: {
      widths: ['*'],
      body: [[{
        fillColor: C.ink, border: noBorder, margin: [22, 20, 22, 20],
        stack: [
          { columns: [
            { text: 'TRADERPRO  ·  ОТЧЁТ ПО ТОРГОВЛЕ', fontSize: 7.5, bold: true, characterSpacing: 1.2, color: '#a5b4fc', width: '*' },
            { text: m.meta.userName ? m.meta.userName : '', fontSize: 8, color: '#94a3b8', alignment: 'right', width: 'auto' },
          ] },
          { text: m.meta.period.title, fontSize: 27, bold: true, color: '#ffffff', margin: [0, 9, 0, 4] },
          { text: sub, fontSize: 9, color: '#cbd5e1' },
        ],
      }]],
    },
    layout: 'noBorders',
  });
  content.push({ canvas: [{ type: 'rect', x: 0, y: 0, w: W, h: 3, color: C.accent }], margin: [0, 0, 0, 4] });
  content.push({ text: `Сформировано ${dateRu(m.meta.generatedAt)}. Результаты — по закрытым сделкам, в рублях.`, fontSize: 7.5, color: C.muted, margin: [0, 0, 0, 6] });

  if (m.empty) {
    content.push(callout(m.verdict, C.gold));
    return finish(content, m, opts);
  }

  // --- итоги ---
  if (has('summary')) {
    const dText = m.delta.hasPrev ? `${fmtMoney(m.delta.pnl)} к периоду «${m.meta.prevPeriod.title}»` : 'нет данных за прошлый период';
    const firstCards = cardsRow([
      card({ label: 'Результат', value: fmtMoney(s.pnl), sub: dText, color: sign(s.pnl), accent: sign(s.pnl) }),
      card({ label: 'Закрытых сделок', value: String(s.total), sub: `${s.wins} прибыльных · ${s.total - s.wins} прочих`, accent: C.accent }),
      card({ label: 'Прибыльных', value: fmtPct(s.winrate), sub: m.delta.winrate != null ? `${m.delta.winrate >= 0 ? '+' : '−'}${Math.abs(m.delta.winrate).toFixed(0)} п.п. к прошлому` : ' ', accent: C.accent }),
      card({ label: 'Профит-фактор', value: fmtPF(s.profitFactor), sub: 'прибыль / убыток', accent: C.accent }),
    ]);
    content.push(block(sectionTitle('Итоги периода'), firstCards));
    content.push(cardsRow([
      card({ label: 'Средняя сделка', value: fmtMoney(s.avg), color: sign(s.avg) }),
      card({ label: 'Средняя прибыль', value: s.avgWin ? fmtMoney(s.avgWin) : '—', color: C.green }),
      card({ label: 'Средний убыток', value: s.avgLoss ? fmtMoney(s.avgLoss) : '—', color: C.red }),
      card({ label: 'Макс. просадка', value: s.maxDrawdown ? fmtMoney(-s.maxDrawdown) : '0 ₽', sub: 'внутри периода', color: s.maxDrawdown ? C.red : C.muted }),
    ]));
    content.push(callout(m.verdict));
    m.notes.forEach((n) => content.push({ text: n, fontSize: 8.5, italics: true, color: C.muted, margin: [0, 2, 0, 2] }));
  }

  // --- динамика ---
  if (has('curve') && m.curve.points.length > 1) {
    const g = m.curve.granularity;
    content.push(block(sectionTitle('Динамика результата', `Накопленный результат ${g === 'day' ? 'по дням' : g === 'week' ? 'по неделям' : 'по месяцам'}, ₽`),
      { svg: equityCurveSvg(m.curve.points, { width: W, height: 200 }), width: W, margin: [0, 0, 0, 4] }));
  }

  // --- лучшие и худшие ---
  if (has('best_worst') && (m.best.length || m.worst.length)) {
    content.push(block(sectionTitle('Лучшие и худшие сделки', 'Пять лучших и пять худших закрытых сделок периода'),
      { columns: [miniTable('Лучшие', m.best, C.green), miniTable('Худшие', m.worst, C.red)], columnGap: 22 }));
  }

  // --- инструменты ---
  if (has('instruments') && m.byInstrument.length) {
    const rows = pickRows(m.byInstrument, 12);
    content.push(block(sectionTitle('По инструментам', 'Результат по каждому инструменту, от лучшего к худшему'),
      { svg: hBarsSvg(rows.map((g) => ({ label: g.label, value: g.pnl })), { width: W }), width: W, margin: [0, 0, 0, 8] }));
    content.push(groupTable(rows, 'Инструмент'));
    if (rows.length < m.byInstrument.length) content.push({ text: `Показано ${rows.length} из ${m.byInstrument.length}: лучшие и худшие.`, fontSize: 7.5, color: C.muted, margin: [0, 3, 0, 0] });
  }

  // --- стратегии ---
  if (has('strategies') && m.byStrategy.length) {
    const rows = pickRows(m.byStrategy, 10);
    content.push(block(sectionTitle('По стратегиям', 'Какая стратегия как отработала за период'),
      { svg: hBarsSvg(rows.map((g) => ({ label: g.label, value: g.pnl })), { width: W, labelW: 150 }), width: W, margin: [0, 0, 0, 8] }));
    content.push(groupTable(rows, 'Стратегия'));
  }

  // --- дни недели ---
  if (has('weekdays') && m.byWeekday.some((w) => w.count)) {
    content.push(block(sectionTitle('По дням недели', 'Результат сделок по дню закрытия; под днём — число сделок'),
      { svg: vBarsSvg(m.byWeekday.map((w) => ({ label: w.short, value: w.pnl, sub: String(w.count) })), { width: W }), width: W }));
  }

  // --- я против системы ---
  if (has('versus') && (m.versus.real.total || m.versus.paper.total)) {
    content.push(block(sectionTitle('Я против системы', 'Ваши реальные сделки рядом с бумажными сделками робота за тот же период'), {
      table: { widths: ['*', 10, '*'], body: [[statBlock('Ваши реальные сделки', m.versus.real), { text: '', border: noBorder }, statBlock('Бумажные сделки робота', m.versus.paper)]] },
      layout: 'noBorders',
    }));
    content.push({ text: 'Бумажные сделки открывает робот по правилам стратегий, реальных денег они не касаются. Сравнение показывает, чем ваши решения отличались от правил.', fontSize: 8, color: C.muted, margin: [0, 5, 0, 0] });
  }

  // --- привычки ---
  if (has('habits')) {
    const habitsTitle = sectionTitle('Привычки и что они стоили', 'Находки движка привычек по вашим реальным сделкам периода');
    if (m.habits && m.habits.list.length) {
      m.habits.list.forEach((h, idx) => {
        const cardNode = {
          unbreakable: true, margin: [0, 0, 0, 6],
          table: { widths: ['*'], body: [[{
            fillColor: C.card, margin: [11, 8, 11, 8], border: [true, false, false, false], borderColor: [h.confidence === 'confirmed' ? C.red : C.gold, 0, 0, 0],
            stack: [
              { columns: [{ text: h.title, bold: true, fontSize: 10, width: '*' }, { text: h.costRub ? `≈ ${fmtMoney(-h.costRub)}` : '', bold: true, fontSize: 10, color: C.red, alignment: 'right', width: 'auto' }] },
              { text: `${h.confidence === 'confirmed' ? 'Подтверждено' : 'Гипотеза'} · разобрано ${h.sampleSize} ${plural(h.sampleSize, ['сделка', 'сделки', 'сделок'])}`, fontSize: 7.5, color: h.confidence === 'confirmed' ? C.red : C.gold, margin: [0, 2, 0, 3] },
              ...(h.detail ? [{ text: h.detail, fontSize: 8.5, color: C.muted, lineHeight: 1.3 }] : []),
            ],
          }]] },
          layout: { hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 3 : 0), paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
        };
        content.push(idx === 0 ? block(habitsTitle, cardNode) : cardNode);
      });
      content.push({ text: 'Наблюдения, а не советы: подтверждёнными считаются выводы от 25 сделок, меньше — гипотезы.', fontSize: 7.5, color: C.muted });
    } else if (m.habits) {
      content.push(habitsTitle);
      content.push({ text: 'Дорогих привычек за период движок не нашёл — либо их правда нет, либо сделок пока мало для вывода.', fontSize: 9.5, color: C.muted });
    } else {
      content.push(habitsTitle);
      content.push({ text: m.meta.scope === 'paper' ? 'Привычки считаются только по реальным сделкам — в срезе «Бумажные» этого раздела нет.' : 'Для этого периода раздел недоступен: нет реальных сделок или не подключён движок привычек.', fontSize: 9.5, color: C.muted });
    }
  }

  // --- список сделок ---
  if (has('trades') && m.trades.length) {
    content.push({ ...sectionTitle('Все закрытые сделки', `${m.trades.length} ${plural(m.trades.length, ['сделка', 'сделки', 'сделок'])} за период`), pageBreak: 'before', margin: [0, 0, 0, 8] });
    content.push(tradesTable(m.trades));
  }

  return finish(content, m, opts);
}

/** Для длинных списков — лучшие и худшие, чтобы график не растягивался на страницу. */
function pickRows(rows, max) {
  if (rows.length <= max) return rows;
  const head = Math.ceil(max * 0.6), tail = max - head;
  return [...rows.slice(0, head), ...rows.slice(rows.length - tail)];
}

function finish(content, m, opts) {
  const footerText = opts.footer || 'Отчёт сформирован автоматически по вашим сделкам и не является инвестиционной рекомендацией.';
  return {
    pageSize: 'A4',
    pageMargins: [40, 52, 40, 48],
    info: { title: `${m.meta.title} — ${m.meta.period.title}`, author: 'TraderPro', subject: m.meta.period.rangeText },
    defaultStyle: { font: 'Roboto', fontSize: 9.5, color: C.text, lineHeight: 1.2 },
    styles: { h2: { fontSize: 13, bold: true, color: C.ink }, hint: { fontSize: 8, color: C.muted } },
    header: (page) => (page === 1 ? null : {
      margin: [40, 22, 40, 0],
      columns: [
        { text: 'TRADERPRO', fontSize: 7.5, bold: true, characterSpacing: 1.2, color: C.accent },
        { text: `${m.meta.period.title}  ·  ${m.meta.scopeLabel}`, fontSize: 7.5, color: C.muted, alignment: 'right' },
      ],
    }),
    footer: (page, pages) => ({
      margin: [40, 12, 40, 0],
      columns: [
        { text: footerText, fontSize: 7, color: C.faint, width: '*' },
        { text: `${page} / ${pages}`, fontSize: 7.5, color: C.muted, alignment: 'right', width: 'auto' },
      ],
    }),
    content,
  };
}
