// src/components/trainer/ReplayDesk.js
//
// «Переигровка истории»: настоящие исторические свечи MOEX, будущее скрыто, свечи открываются по одной. Игрок ставит
// заявку (вход по ОТКРЫТИЮ следующей свечи — как у бумажных сделок робота), стоп и тейк обязательны/по желанию, двигает стоп,
// закрывает вручную. Исполнение, R и комиссия — services/trainer/trainerSim.js. Закрытая сделка сохраняется в отдельную
// коллекцию trainerTrades и никогда не попадает в реальный журнал и статистику.
//
// «Слепой режим» (по умолчанию): тикер и даты скрыты, пока сделка не закрыта — иначе игрок «вспоминает», что было дальше.
import confirmDialog from '../shared/confirmDialog';
import React, { useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import CandleChart from '../shared/CandleChart';
import Icon from '../shared/Icon';
import { useAuth } from '../../context/AuthContext';
import { fetchDailyCandles } from '../../services/marketData/candles';
import { catalogEntry } from '../../services/marketData/instrumentCatalog';
import { getStrategies } from '../../services/analytics/strategy';
import { atrOf } from '../../services/chartDrawings';
import { openPosition, onBar, moveStop, closePosition, unrealized, DEFAULT_FEE_PCT_PER_SIDE } from '../../services/trainer/trainerSim';
import { addTrainerTrade, updateTrainerTrade } from '../../services/trainer/trainerTrades';

const LIQUID = ['SBER', 'GAZP', 'LKOH', 'GMKN', 'ROSN', 'NVTK', 'MGNT', 'TATN', 'CHMF', 'NLMK', 'MTSS', 'AFLT', 'ALRS', 'VTBR', 'PLZL', 'MOEX', 'PHOR', 'SNGS'];
const MIN_BARS = 260;      // меньше истории — игра не имеет смысла
const WARMUP = 150;        // свечей истории, которые видны с самого начала
const TAIL = 40;           // с конца данных оставляем запас, чтобы было куда двигаться
const AFTER_REVEAL = 20;   // сколько свечей «что было дальше» показываем после закрытия сделки

const num = (s) => { const n = parseFloat(String(s ?? '').replace(',', '.').replace(/\s/g, '')); return Number.isFinite(n) ? n : null; };
const fmtR = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2).replace('.', ',')}R`;
const fmtPrice = (x) => (x == null ? '—' : x.toLocaleString('ru-RU', { maximumFractionDigits: 4 }));
const REASON = { stop: 'сработал стоп', take: 'сработал тейк', manual: 'закрыто вручную', end: 'данные кончились' };

export default function ReplayDesk({ onSaved }) {
  const { user, userProfile } = useAuth();
  const strategies = useMemo(() => getStrategies(userProfile), [userProfile]);

  // --- настройка ---
  const [ticker, setTicker] = useState('SBER');
  const [blind, setBlind] = useState(true);
  const [strategyId, setStrategyId] = useState('');
  const [riskMoney, setRiskMoney] = useState('1000');
  // --- ход игры ---
  const [phase, setPhase] = useState('setup');      // setup | loading | run | done
  const [all, setAll] = useState([]);                // все свечи инструмента
  const [cursor, setCursor] = useState(0);           // индекс последней открытой свечи
  const [pending, setPending] = useState(null);      // заявка, которая исполнится по открытию следующей свечи
  const [position, setPosition] = useState(null);
  const [closedTrade, setClosedTrade] = useState(null);
  const [orderStop, setOrderStop] = useState('');
  const [orderTake, setOrderTake] = useState('');
  const [newStop, setNewStop] = useState('');
  const [note, setNote] = useState('');
  const sessionRef = useRef({ ticker: '', blind: true, startIdx: 0 });

  const shown = all.slice(0, cursor + 1);
  const last = shown[shown.length - 1] || null;
  const atr = useMemo(() => atrOf(shown.slice(-60), 14), [shown]);

  // Слепой режим: вместо настоящих дат — синтетические подряд идущие дни (ось не выдаёт год и месяц).
  const displayCandles = useMemo(() => {
    const src = phase === 'done' && closedTrade ? all.slice(0, Math.min(all.length, cursor + 1 + AFTER_REVEAL)) : shown;
    if (!(blind && phase !== 'done')) return src;
    const base = Date.UTC(2000, 0, 1);
    return src.map((c, i) => ({ ...c, date: new Date(base + i * 86400000) }));
  }, [shown, all, cursor, blind, phase, closedTrade]);

  const hideNames = blind && phase !== 'done';
  const upl = position && last ? unrealized(position, last.close) : null;

  async function start(chosenTicker) {
    const t = String(chosenTicker || ticker || '').trim().toUpperCase();
    if (!t) { toast.error('Укажите тикер'); return; }
    setPhase('loading');
    try {
      const info = catalogEntry(t);
      const candles = await fetchDailyCandles({ ticker: t, instrumentType: info?.type || 'stock', toDate: new Date(), timeframe: 'D1', lookbackDays: 3000 });
      if (!candles || candles.length < MIN_BARS) throw new Error(`По ${t} найдено ${candles?.length || 0} свечей — для игры нужно хотя бы ${MIN_BARS}`);
      const lo = WARMUP, hi = candles.length - TAIL;
      const startIdx = lo + Math.floor(Math.random() * Math.max(1, hi - lo));
      sessionRef.current = { ticker: t, blind, startIdx };
      setAll(candles); setCursor(startIdx);
      setPending(null); setPosition(null); setClosedTrade(null);
      setOrderStop(''); setOrderTake(''); setNewStop(''); setNote('');
      setPhase('run');
    } catch (e) {
      toast.error(e?.message || 'Не удалось загрузить историю');
      setPhase('setup');
    }
  }

  function randomStart() {
    const t = LIQUID[Math.floor(Math.random() * LIQUID.length)];
    setTicker(t);
    start(t);
  }

  async function finalize(closedPos, idx) {
    const strat = strategies.find((s) => s.id === strategyId);
    const doc = {
      ...closedPos,
      dataMode: 'history',
      ticker: sessionRef.current.ticker, instrumentType: 'stock', timeframe: 'D1',
      blind: sessionRef.current.blind,
      strategyId: strat ? strat.id : null, strategyName: strat ? (strat.name || strat.id) : null,
      startIdx: sessionRef.current.startIdx,
    };
    setClosedTrade(doc); setPosition(null); setPending(null); setCursor(idx); setPhase('done');
    try {
      const ref = await addTrainerTrade(user.uid, doc);
      setClosedTrade({ ...doc, id: ref.id });
      onSaved?.();
    } catch (e) {
      toast.error(e?.code === 'permission-denied'
        ? 'Сделка не записана в разбор: правила базы для тренажёра ещё не опубликованы. Результат на экране верный.'
        : 'Не удалось сохранить сделку в разбор: ' + (e?.message || 'ошибка'));
    }
  }

  // Открыть k следующих свечей. Останавливаемся, как только заявка не исполнилась, позиция закрылась или данные кончились.
  function step(k = 1) {
    let idx = cursor, pos = position, pend = pending;
    for (let i = 0; i < k; i++) {
      if (idx + 1 >= all.length) {
        if (pos) { finalize(closePosition(pos, all[idx].close, all[idx].date, idx, 'end'), idx); return; }
        toast('Данные закончились'); break;
      }
      idx += 1;
      const bar = all[idx];
      if (pend && !pos) {
        try {
          pos = openPosition({
            side: pend.side, price: bar.open, stop: pend.stop, take: pend.take, date: bar.date, bar: idx,
            riskMoney: pend.riskMoney, feePctPerSide: DEFAULT_FEE_PCT_PER_SIDE,
            meta: { plannedStop: pend.stop },
          });
        } catch (e) {
          toast.error(`Заявка не исполнена: ${e.message}. Цена открытия — ${fmtPrice(bar.open)}.`);
          pend = null; setPending(null); setCursor(idx);
          return;
        }
        pend = null;
      }
      if (pos) {
        const r = onBar(pos, bar, idx);
        pos = r.position;
        if (r.closed) { finalize(pos, idx); return; }
      }
    }
    setCursor(idx); setPosition(pos); setPending(pend);
  }

  function placeOrder(side) {
    if (!last) return;
    const stop = num(orderStop), take = orderTake === '' ? null : num(orderTake), risk = num(riskMoney);
    if (stop == null) { toast.error('Укажите стоп — без стопа заявка не ставится'); return; }
    if (!(risk > 0)) { toast.error('Укажите риск на сделку'); return; }
    const d = side === 'long' ? 1 : -1;
    if ((last.close - stop) * d <= 0) { toast.error(side === 'long' ? 'Для покупки стоп должен быть ниже текущей цены' : 'Для продажи стоп должен быть выше текущей цены'); return; }
    if (take != null && (take - last.close) * d <= 0) { toast.error(side === 'long' ? 'Для покупки тейк должен быть выше текущей цены' : 'Для продажи тейк должен быть ниже текущей цены'); return; }
    setPending({ side, stop, take, riskMoney: risk });
  }

  function applyStop() {
    const v = num(newStop);
    if (v == null) { toast.error('Укажите цену стопа'); return; }
    try { setPosition(moveStop(position, v, cursor, last.close)); setNewStop(''); } catch (e) { toast.error(e.message); }
  }

  function closeNow() {
    if (!position || !last) return;
    finalize(closePosition(position, last.close, last.date, cursor, 'manual'), cursor);
  }

  function setAtrStop(mult, side) {
    if (!atr || !last) return;
    const v = side === 'long' ? last.close - atr * mult : last.close + atr * mult;
    setOrderStop(String(Number(v.toFixed(4))));
  }

  async function saveNote() {
    if (!closedTrade?.id) return;
    try { await updateTrainerTrade(closedTrade.id, { note }); toast.success('Заметка сохранена'); } catch { toast.error('Не удалось сохранить заметку'); }
  }

  function again() { setPhase('setup'); setAll([]); setClosedTrade(null); setNote(''); }

  const planLines = position ? { entry: position.entryPrice, stop: position.stopPrice, take: position.takePrice }
    : pending ? { stop: pending.stop, take: pending.take } : undefined;

  // ---------- настройка ----------
  if (phase === 'setup' || phase === 'loading') {
    return (
      <div className="tr-setup-grid">
      <div className="card tr-setup">
        <h3 className="tr-side-title">Новая попытка</h3>
        <p className="tr-muted">Настоящая история MOEX. Будущее скрыто: свечи открываются по одной, а вы решаете, входить ли, где стоять стопу и когда выходить. Сделка записывается в «Разбор» как <b>учебная</b> — в реальный журнал и статистику она не попадает.</p>
        <div className="tr-form">
          <div className="input-group">
            <label className="input-label" htmlFor="tr-ticker">Тикер (акции)</label>
            <input id="tr-ticker" className="input" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="SBER" list="tr-tickers" />
            <datalist id="tr-tickers">{LIQUID.map((t) => <option key={t} value={t} />)}</datalist>
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="tr-strat">Стратегия, которую проверяете</label>
            <select id="tr-strat" className="input" value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
              <option value="">Без стратегии (просто практика)</option>
              {strategies.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
            </select>
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="tr-risk">Риск на сделку, ₽ (условно)</label>
            <input id="tr-risk" className="input" inputMode="decimal" value={riskMoney} onChange={(e) => setRiskMoney(e.target.value)} />
          </div>
          <label className="tr-check">
            <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
            <span><b>Слепой режим</b> — скрыть тикер и даты до конца сделки (рекомендуется: иначе легко «вспомнить», что было дальше)</span>
          </label>
        </div>
        <div className="tr-actions">
          <button type="button" className="btn btn-primary" disabled={phase === 'loading'} onClick={() => start()}>{phase === 'loading' ? 'Загружаю историю…' : 'Начать с этим тикером'}</button>
          <button type="button" className="btn btn-secondary" disabled={phase === 'loading'} onClick={randomStart}>Случайный инструмент</button>
        </div>
        <p className="tr-note">Вход — по открытию следующей свечи после заявки. Если в одной свече достижимы и стоп, и тейк, считается стоп. Комиссия {DEFAULT_FEE_PCT_PER_SIDE} % с каждой стороны. Фьючерсы пока не поддерживаются.</p>
      </div>
      <div className="card tr-howto">
        <h3 className="tr-side-title">Как играть</h3>
        <ol>
          <li><b>Начните попытку.</b> Выберите акцию (или «Случайный инструмент»). Вы увидите историю до случайного дня — как будто это «сегодня». Что было дальше, скрыто.</li>
          <li><b>Открывайте свечи.</b> Кнопка «Следующая свеча» (или «+5 свечей») открывает график по одной свече — как время, идущее вперёд.</li>
          <li><b>Решили войти?</b> Справа в «Заявке» укажите стоп (обязательно) и, если хотите, тейк, затем «Купить» или «Продать». Сделка откроется по цене открытия следующей свечи.</li>
          <li><b>Ведите сделку.</b> Можно двигать стоп или закрыть вручную. Когда сделка закроется, вы увидите результат в R и свечи, которые были дальше, — и сможете записать заметку.</li>
        </ol>
        <p className="tr-note">Хотите потренироваться именно в выходе — войдите сразу, а решения принимайте по ходу свечей. В «Слепом режиме» тикер и даты скрыты, чтобы нельзя было вспомнить, чем всё кончилось.</p>
      </div>
      </div>
    );
  }

  // ---------- игра ----------
  const title = hideNames ? 'Инструмент скрыт' : sessionRef.current.ticker;
  return (
    <div className="tr-grid">
      <div className="tr-main">
        <div className="card tr-chart-card">
          <div className="tr-chart-head">
            <b>{title}</b>
            <span className="badge badge-purple">Учебная сделка</span>
            {hideNames && <span className="badge badge-gold">Слепой режим</span>}
            <span className="tr-muted">Свеча {cursor - sessionRef.current.startIdx + 1} от начала попытки</span>
          </div>
          <CandleChart
            candles={displayCandles}
            ticker={title}
            timeframe="D1"
            height={460}
            planLines={phase === 'run' ? planLines : undefined}
            systemMarkers={phase === 'done' && closedTrade ? [{ date: all[closedTrade.exitBar]?.date, text: 'Выход' }] : undefined}
          />
          {phase === 'run' && !position && !pending && (
            <p className="tr-hint">Открывайте свечи кнопкой «Следующая свеча». Решите войти — поставьте заявку справа (стоп обязателен). Вход произойдёт по открытию следующей свечи.</p>
          )}
          {phase === 'run' && (
            <div className="tr-steps" data-tour="trainer-steps">
              <button type="button" className="btn btn-primary" onClick={() => step(1)}>Следующая свеча</button>
              <button type="button" className="btn btn-secondary" onClick={() => step(5)}>+5 свечей</button>
              <button type="button" className="btn btn-ghost" onClick={async () => { if (!position || await confirmDialog({ title: 'Прервать попытку?', text: 'Позиция открыта — выйти без записи сделки?', confirmLabel: 'Прервать' })) again(); }}>Прервать попытку</button>
            </div>
          )}
        </div>
      </div>

      <aside className="tr-side">
        {phase === 'run' && !position && (
          <div className="card" data-tour="trainer-order">
            <h3 className="tr-side-title">Заявка</h3>
            {last && <p className="tr-muted">Последняя цена: <b>{fmtPrice(last.close)}</b>{atr ? <> · ATR(14) ≈ {fmtPrice(Number(atr.toFixed(4)))}</> : null}</p>}
            {pending ? (
              <>
                <p>Заявка на {pending.side === 'long' ? 'покупку' : 'продажу'} стоит: стоп {fmtPrice(pending.stop)}{pending.take != null ? `, тейк ${fmtPrice(pending.take)}` : ''}. Исполнится по открытию следующей свечи.</p>
                <button type="button" className="btn btn-secondary" onClick={() => setPending(null)}>Снять заявку</button>
              </>
            ) : (
              <>
                <div className="input-group">
                  <label className="input-label" htmlFor="tr-stop">Стоп (цена) — обязателен</label>
                  <input id="tr-stop" className="input" inputMode="decimal" value={orderStop} onChange={(e) => setOrderStop(e.target.value)} />
                  {atr && (
                    <div className="tr-quick">
                      <span>Быстро:</span>
                      <button type="button" className="tr-chip" onClick={() => setAtrStop(1, 'long')}>лонг, 1 ATR</button>
                      <button type="button" className="tr-chip" onClick={() => setAtrStop(2, 'long')}>лонг, 2 ATR</button>
                      <button type="button" className="tr-chip" onClick={() => setAtrStop(1, 'short')}>шорт, 1 ATR</button>
                      <button type="button" className="tr-chip" onClick={() => setAtrStop(2, 'short')}>шорт, 2 ATR</button>
                    </div>
                  )}
                </div>
                <div className="input-group">
                  <label className="input-label" htmlFor="tr-take">Тейк (цена) — по желанию</label>
                  <input id="tr-take" className="input" inputMode="decimal" value={orderTake} onChange={(e) => setOrderTake(e.target.value)} />
                </div>
                <div className="tr-actions">
                  <button type="button" className="btn btn-primary" onClick={() => placeOrder('long')}>Купить</button>
                  <button type="button" className="btn btn-secondary" onClick={() => placeOrder('short')}>Продать</button>
                </div>
              </>
            )}
          </div>
        )}

        {phase === 'run' && position && (
          <div className="card" data-tour="trainer-position">
            <h3 className="tr-side-title">Позиция: {position.side === 'long' ? 'покупка' : 'продажа'}</h3>
            <div className="tr-kv"><span>Вход</span><b>{fmtPrice(position.entryPrice)}</b></div>
            <div className="tr-kv"><span>Стоп</span><b>{fmtPrice(position.stopPrice)}</b></div>
            <div className="tr-kv"><span>Тейк</span><b>{fmtPrice(position.takePrice)}</b></div>
            <div className="tr-kv"><span>Сейчас</span><b className={upl && upl.r >= 0 ? 'tr-pos' : 'tr-neg'}>{upl ? fmtR(upl.r) : '—'}</b></div>
            <div className="tr-kv"><span>Лучший ход / худший</span><b>{fmtR(position.mfeR)} / −{position.maeR.toFixed(2).replace('.', ',')}R</b></div>
            <div className="input-group" style={{ marginTop: 10 }}>
              <label className="input-label" htmlFor="tr-newstop">Передвинуть стоп</label>
              <div className="tr-row">
                <input id="tr-newstop" className="input" inputMode="decimal" value={newStop} onChange={(e) => setNewStop(e.target.value)} placeholder={fmtPrice(position.stopPrice)} />
                <button type="button" className="btn btn-secondary btn-sm" onClick={applyStop}>Передвинуть</button>
              </div>
            </div>
            <button type="button" className="btn btn-danger" style={{ marginTop: 10 }} onClick={closeNow}>Закрыть по {fmtPrice(last?.close)}</button>
          </div>
        )}

        {phase === 'done' && closedTrade && (
          <div className="card" data-tour="trainer-result">
            <h3 className="tr-side-title">Результат</h3>
            <div className={`tr-big ${closedTrade.r >= 0 ? 'tr-pos' : 'tr-neg'}`}>{fmtR(closedTrade.r)}</div>
            <p className="tr-muted">{REASON[closedTrade.exitReason] || closedTrade.exitReason}{closedTrade.gap ? ' · гэп: свеча открылась за уровнем' : ''}{closedTrade.ambiguous ? ' · в свече были достижимы и стоп, и тейк — засчитан стоп' : ''}</p>
            <div className="tr-kv"><span>Инструмент</span><b>{closedTrade.ticker}</b></div>
            <div className="tr-kv"><span>Вход → выход</span><b>{new Date(closedTrade.entryDate).toLocaleDateString('ru-RU')} → {new Date(closedTrade.exitDate).toLocaleDateString('ru-RU')}</b></div>
            <div className="tr-kv"><span>Держали</span><b>{closedTrade.barsHeld} св.</b></div>
            <div className="tr-kv"><span>Можно было взять до</span><b>{fmtR(closedTrade.mfeR)}</b></div>
            <div className="tr-kv"><span>Худшая просадка</span><b>−{closedTrade.maeR.toFixed(2).replace('.', ',')}R</b></div>
            <div className="tr-kv"><span>Условно</span><b>{Math.round(closedTrade.pnlVirtual).toLocaleString('ru-RU')} ₽</b></div>
            <p className="tr-note">Это учебная сделка: она попала только в раздел «Разбор» тренажёра. Свечи справа от отметки «Выход» — что было дальше.</p>
            <div className="input-group">
              <label className="input-label" htmlFor="tr-note">Заметка: почему вошли и что чувствовали</label>
              <textarea id="tr-note" className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 6 }} onClick={saveNote} disabled={!closedTrade.id || !note.trim()}><Icon name="save" size={13} /> Сохранить заметку</button>
            </div>
            <button type="button" className="btn btn-primary" onClick={again}>Новая попытка</button>
          </div>
        )}
      </aside>
    </div>
  );
}
