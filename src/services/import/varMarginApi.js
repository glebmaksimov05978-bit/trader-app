// src/services/import/varMarginApi.js
//
// Сверка фьючерсных сделок с вариационной маржой, которую Т-Банк отдаёт через API (операции «зачисление / списание
// вариационной маржи»). Нужна там, где брокерского отчёта нет: загрузка сделок прямо из Т-Банка и сделки, открытые из
// приложения. Смысл тот же, что у сверки с отчётом (varMargin.js): маржа — настоящие деньги, в ней есть фандинг вечных
// фьючерсов и настоящий курс шага долларовых контрактов, которых в ценах сделок нет.
//
// ЧЕГО МЫ НЕ ЗНАЕМ и как с этим обходимся (на живых данных формат не сверялся — нужен токен владельца):
//   • привязана ли операция маржи к контракту или приходит одной суммой на счёт за клиринг. Модуль умеет оба вида:
//     «по контракту» (у каждой операции есть тикер) и «по счёту» (одна сумма на все фьючерсы);
//   • в какое время операция датирована. Поэтому сделки собираются в «эпизоды» — от момента, когда фьючерсов на счёте
//     (или по контракту) не было, до момента, когда их снова нет; соседние эпизоды, между которыми не было ни одной
//     операции маржи, склеиваются (у них общий клиринг). Сумма маржи эпизода сравнивается с суммой «хода цены» его сделок.
//
// ЗАЩИТА ОТ НЕВЕРНЫХ ЦИФР (ничего не угадываем молча):
//   • у обычных рублёвых контрактов маржа равна ходу цены (проверено на брокерских отчётах до копейки). Если у таких
//     эпизодов она НЕ сходится — значит, мы неправильно поняли формат или в журнале не все сделки: тогда не правится
//     ничего, а в отчёте сверки пишется причина;
//   • поправка больше 5 % от стоимости позиции не применяется;
//   • эпизод, начавшийся до периода загрузки, не закрытый, или ещё не прошедший клиринг, не трогается.
//
// Модуль чистый: без сети и базы.

const r2 = (v) => (Math.round(v * 100) / 100) || 0;
const money = (v) => (v ? Number(v.units || 0) + Number(v.nano || 0) / 1e9 : 0);
const MSK = 3 * 3600 * 1000;
const TOLERANCE = 1; // ₽: расхождение «в пределах округления» у обычного контракта
const MAX_SHARE = 0.05; // поправка не больше 5 % стоимости позиции
const SETTLE_MS = 4 * 86400000; // если после закрытия прошло столько, клиринг точно был (покрывает выходные)

export const VM_OPERATION_TYPES = ['OPERATION_TYPE_ACCRUING_VARMARGIN', 'OPERATION_TYPE_WRITING_OFF_VARMARGIN'];

const ms = (v) => {
  if (v == null) return NaN;
  if (typeof v?.toDate === 'function') return v.toDate().getTime();
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  return new Date(v).getTime();
};
const dayMsk = (t) => new Date(t + MSK).toISOString().slice(0, 10);

// Обычный срочный контракт: две буквы/цифры кода + буква месяца + цифра года (SiZ6, GZU5). Всё остальное — вечные
// фьючерсы (IMOEXF, USDRUBF, CNYRUBF, GLDRUBF, SBERF…): в их марже каждый день сидит фандинг.
const SHORT_CODE = /^([A-Za-z0-9]{2})[FGHJKMNQUVXZ]\d$/;
// Контракты с ценой не в рублях: стоимость шага биржа пересчитывает по курсу на каждом клиринге. Список неполный —
// контракт, которого здесь нет, просто останется «несверенным», если его маржа не сойдётся с ходом цены.
const FX_PRICED = new Set(['BR', 'BM', 'NG', 'NR', 'GD', 'SV', 'PT', 'PD', 'RI', 'RM', 'ED', 'NA', 'SF', 'UC', 'AU', 'GU', 'CA', 'JP', 'DX', 'SX', 'HS', 'N2', 'R2']);

/** Может ли у контракта маржа отличаться от «хода цены»: вечный или с ценой не в рублях. */
export function isAdjustable(ticker) {
  const m = SHORT_CODE.exec(String(ticker || ''));
  if (!m) return true;
  return FX_PRICED.has(m[1].toUpperCase());
}

/** Операции маржи из API → { at (мс), amount (₽ со знаком), ticker | null }. */
export function vmOperationsFromApi(items) {
  const out = [];
  for (const i of items || []) {
    if (!VM_OPERATION_TYPES.includes(i?.type || i?.operationType)) continue;
    if (i.state && i.state !== 'OPERATION_STATE_EXECUTED') continue;
    const at = ms(i.date);
    const raw = Math.abs(money(i.payment));
    if (!Number.isFinite(at) || !(raw > 0)) continue;
    const writeOff = (i.type || i.operationType) === 'OPERATION_TYPE_WRITING_OFF_VARMARGIN';
    const ticker = String(i.ticker || '').trim().toUpperCase() || null;
    out.push({ at, amount: writeOff ? -raw : raw, ticker });
  }
  return out.sort((a, b) => a.at - b.at);
}

// Эпизоды группы сделок: от нулевой позиции до нулевой (по всем контрактам группы сразу).
function buildEpisodes(items) {
  const events = [];
  items.forEach(({ t, i }) => {
    const sign = t.direction === 'short' ? -1 : 1;
    t.legs.forEach((l, k) => {
      const at = ms(l.timestampUtc);
      const q = Number(l.quantity) || 0;
      if (!Number.isFinite(at) || !(q > 0) || (l.type !== 'open' && l.type !== 'close')) return;
      events.push({ at, i, k, ticker: t.ticker, delta: sign * (l.type === 'open' ? q : -q) });
    });
  });
  events.sort((a, b) => a.at - b.at || a.i - b.i || a.k - b.k);
  const episodes = [];
  const pos = new Map();
  let cur = null;
  for (const e of events) {
    if (!cur) cur = { start: e.at, end: null, idx: new Set() };
    cur.idx.add(e.i);
    pos.set(e.ticker, (pos.get(e.ticker) || 0) + e.delta);
    if ([...pos.values()].every((v) => Math.abs(v) < 1e-9)) { cur.end = e.at; episodes.push(cur); cur = null; }
  }
  if (cur) episodes.push(cur);
  return episodes;
}

// Склейка соседних эпизодов, между которыми нет ни одной операции маржи (у них общий клиринг).
function mergeEpisodes(episodes, ops) {
  const out = [];
  for (const ep of episodes) {
    const prev = out[out.length - 1];
    const gapHasOp = prev && prev.end != null && ops.some((o) => o.at > prev.end && o.at <= ep.start);
    if (prev && !gapHasOp) {
      ep.idx.forEach((i) => prev.idx.add(i));
      prev.end = ep.end;
    } else out.push({ start: ep.start, end: ep.end, idx: new Set(ep.idx) });
  }
  return out;
}

// Вес сделки при делении поправки: «контракто-время» в рынке (чем дольше и больше держал — тем больше фандинга).
function contractTime(t) {
  const sorted = t.legs.map((l) => ({ at: ms(l.timestampUtc), q: (l.type === 'open' ? 1 : -1) * (Number(l.quantity) || 0) }))
    .filter((l) => Number.isFinite(l.at)).sort((a, b) => a.at - b.at);
  let held = 0, w = 0;
  for (let k = 0; k < sorted.length; k += 1) {
    if (k > 0) w += Math.max(0, held) * (sorted[k].at - sorted[k - 1].at);
    held += sorted[k].q;
  }
  return w;
}

/**
 * @param {Array} trades  сделки (фьючерсные — с legs, direction, status, ticker, pnl, commission)
 * @param {Array<{at:number, amount:number, ticker:string|null}>} vmOps  операции маржи (vmOperationsFromApi)
 * @param {object} o
 * @param {(t)=>number|null} o.grossOf     «ход цены» сделки в рублях до комиссии; null — стоимость пункта неизвестна
 * @param {(t)=>number|null} [o.notionalOf] стоимость позиции в рублях (для ограничения поправки)
 * @param {number} [o.periodStart]  мс: раньше этого момента операций маржи у нас нет
 * @param {number} [o.dirtyBefore]  мс: до этого момента на счёте были позиции, которых нет среди сделок
 * @param {number} [o.asOf]         мс: «сейчас» (момент загрузки операций)
 * @param {(t)=>boolean} [o.skip]   сделки, которые править нельзя (уже сверены и т.п.) — участвуют в суммах, но не меняются
 * @returns {{trades:Array, report:Array, summary:object}}
 */
export function applyApiVarMargin(trades, vmOps, o = {}) {
  const { grossOf, notionalOf = () => null, periodStart = null, dirtyBefore = null, asOf = Date.now(), skip = () => false } = o;
  const summary = { mode: null, operations: vmOps?.length || 0, applied: 0, checked: 0, validation: 'нет данных' };
  const report = [];
  if (!Array.isArray(vmOps) || !vmOps.length) return { trades, report, summary };

  const futs = trades.map((t, i) => ({ t, i })).filter(({ t }) => t.isFuture && Array.isArray(t.legs) && t.legs.length);
  if (!futs.length) return { trades, report, summary };
  const byTicker = vmOps.every((op) => op.ticker);
  summary.mode = byTicker ? 'по контракту' : 'по счёту';

  const groups = [];
  if (byTicker) {
    const codes = [...new Set(futs.map(({ t }) => t.ticker))];
    for (const code of codes) groups.push({ code, items: futs.filter(({ t }) => t.ticker === code), ops: vmOps.filter((op) => op.ticker === code) });
  } else {
    groups.push({ code: null, items: futs, ops: vmOps });
  }

  const patch = new Map();
  const ordinary = []; // проверка формата: сошлась ли маржа с ходом цены там, где обязана

  for (const g of groups) {
    const episodes = mergeEpisodes(buildEpisodes(g.items), g.ops);
    episodes.forEach((ep, n) => {
      const next = episodes[n + 1];
      const ops = g.ops.filter((op) => op.at > ep.start && (!next || op.at <= next.start));
      const members = g.items.filter(({ i }) => ep.idx.has(i));
      const tickers = [...new Set(members.map(({ t }) => t.ticker))];
      const brokerVm = r2(ops.reduce((s, op) => s + op.amount, 0));
      const entry = {
        code: tickers.join(', '), from: dayMsk(ep.start), to: dayMsk(ep.end ?? ep.start), brokerVm, trades: members.length,
      };
      let why = '';
      if (ep.end == null || members.some(({ t }) => t.status !== 'closed')) why = 'позиция ещё не закрыта';
      else if (periodStart != null && ep.start < periodStart) why = 'позиция открыта раньше периода загрузки';
      else if (dirtyBefore != null && ep.start <= dirtyBefore + 86400000) why = 'рядом есть закрытия позиций, открытых до периода загрузки';
      else if (!ops.some((op) => op.at >= ep.end) && asOf - ep.end < SETTLE_MS) why = 'клиринг после закрытия ещё не прошёл';
      if (why) { report.push({ ...entry, applied: false, reason: why }); return; }

      const rows = members.map(({ t, i }) => ({ t, i, gross: grossOf(t), special: byTicker || isAdjustable(t.ticker) }));
      if (rows.some((r) => r.gross == null)) {
        if (rows.length === 1 && !skip(rows[0].t)) {
          patch.set(rows[0].i, { fromVm: brokerVm });
          report.push({ ...entry, applied: true, byPrices: null, residual: 0, shared: false, fromVm: true });
        } else report.push({ ...entry, applied: false, reason: 'неизвестна стоимость пункта, а сделок в эти дни несколько' });
        return;
      }
      const grossSum = rows.reduce((s, r) => s + r.gross, 0);
      const residual = r2(brokerVm - grossSum);
      const base = { ...entry, byPrices: r2(grossSum), residual };
      const onlyOrdinary = rows.every((r) => !isAdjustable(r.t.ticker));
      if (onlyOrdinary) ordinary.push(Math.abs(residual) <= TOLERANCE);

      const targets = rows.filter((r) => r.special);
      if (!targets.length && Math.abs(residual) > TOLERANCE) {
        report.push({ ...base, applied: false, reason: 'маржа брокера не сошлась с ходом цены — возможно, в журнале не все сделки за эти дни' });
        return;
      }
      const notional = rows.reduce((s, r) => s + Math.abs(Number(notionalOf(r.t)) || 0), 0);
      if (notional > 0 && Math.abs(residual) > notional * MAX_SHARE) {
        report.push({ ...base, applied: false, reason: 'расхождение слишком велико для фандинга или курса — возможно, в журнале не все сделки за эти дни' });
        return;
      }
      if (rows.some((r) => skip(r.t))) {
        report.push({ ...base, applied: false, reason: 'часть сделок этих дней уже сверена раньше' });
        return;
      }
      const pool = targets.length ? targets : rows;
      let weights = pool.map((r) => contractTime(r.t));
      if (!(weights.reduce((s, w) => s + w, 0) > 0)) weights = pool.map((r) => Math.abs(r.gross));
      if (!(weights.reduce((s, w) => s + w, 0) > 0)) weights = pool.map((_, k) => (k === pool.length - 1 ? 1 : 0));
      const wSum = weights.reduce((s, w) => s + w, 0);
      const parts = weights.map((w) => r2(residual * (w / wSum)));
      const drift = r2(residual - parts.reduce((s, p) => s + p, 0));
      if (drift) { const k = weights.indexOf(Math.max(...weights)); parts[k] = r2(parts[k] + drift); }
      const shared = pool.length > 1 && residual !== 0;
      rows.forEach((r) => patch.set(r.i, { adjustment: 0, shared: false }));
      pool.forEach((r, k) => patch.set(r.i, { adjustment: parts[k], shared }));
      report.push({ ...base, applied: true, shared });
    });
  }

  // Проверка формата: обычные контракты обязаны сходиться. Если не сходятся — мы что-то поняли не так: не правим ничего.
  if (ordinary.length >= 2) {
    const okShare = ordinary.filter(Boolean).length / ordinary.length;
    summary.validation = `обычные контракты сошлись в ${ordinary.filter(Boolean).length} из ${ordinary.length} случаев`;
    if (okShare < 0.7) {
      summary.blocked = true;
      const blockedReport = report.map((r) => (r.applied ? { ...r, applied: false, reason: 'сверка остановлена: маржа обычных контрактов не сходится с ходом цены — формат данных Т-Банка понят неверно, пришлите диагностику' } : r));
      return { trades, report: blockedReport, summary };
    }
  } else if (ordinary.length === 1) summary.validation = ordinary[0] ? 'обычный контракт сошёлся (1 случай)' : 'обычный контракт не сошёлся (1 случай)';

  const out = trades.map((t, i) => {
    const p = patch.get(i);
    if (!p) return t;
    summary.checked += 1;
    if (p.fromVm != null) {
      summary.applied += 1;
      return { ...t, pnl: r2(p.fromVm - (Number(t.commission) || 0)), pnlNeedsSpecs: false, brokerAdjustment: 0, brokerVmChecked: true, brokerVmShared: false };
    }
    if (p.adjustment) summary.applied += 1;
    return {
      ...t, pnl: t.pnl != null ? r2(Number(t.pnl) + p.adjustment) : t.pnl,
      brokerAdjustment: p.adjustment, brokerVmChecked: true, brokerVmShared: p.shared,
    };
  });
  return { trades: out, report, summary };
}

/** Все операции вариационной маржи по счёту за период (страницы по 1000). */
export async function fetchVarMarginOperations(api, { accountId, from, to }) {
  const items = [];
  let cursor = '';
  for (let page = 0; page < 100; page += 1) {
    const r = await api.getOperationsPage({ accountId, from, to, cursor, operationTypes: VM_OPERATION_TYPES });
    items.push(...(r.items || []));
    if (!r.hasNext || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return items;
}
