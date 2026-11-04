// src/components/trainer/TrainerReview.js
//
// «Разбор»: сводка в R и поведенческие наблюдения по учебным сделкам. Считает services/trainer/trainerStats.js —
// только сделки с kind === 'trainer'. Реальных сделок здесь нет и быть не может; об этом сказано на экране прямо.
import React from 'react';
import Icon from '../shared/Icon';
import { analyze, MIN_N } from '../../services/trainer/trainerStats';
import { deleteTrainerTrade } from '../../services/trainer/trainerTrades';
import toast from 'react-hot-toast';

const fmtR = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2).replace('.', ',')}R`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);
const MODE = { history: 'История', live: 'Живые цены' };
const REASON = { stop: 'стоп', take: 'тейк', manual: 'вручную', end: 'конец данных' };
const VERDICT_CLASS = { positive: 'badge-green', negative: 'badge-red', flat: 'badge-gold', few: 'badge-blue' };

export default function TrainerReview({ trades, onChanged }) {
  const a = analyze(trades);
  const s = a.summary;
  const rows = (trades || []).filter((t) => t.status === 'closed').slice(0, 30);

  async function remove(id) {
    if (!window.confirm('Удалить эту учебную сделку из разбора?')) return;
    try { await deleteTrainerTrade(id); onChanged?.(); } catch { toast.error('Не удалось удалить'); }
  }

  if (!s.n) {
    return (
      <div className="card tr-empty">
        <Icon name="flask" size={28} />
        <h3>Пока нет учебных сделок</h3>
        <p className="tr-muted">Сыграйте несколько попыток в «Переигровке» — здесь появятся результаты в R и разбор ваших привычек. Выводы о привычках — после {MIN_N} сделок.</p>
      </div>
    );
  }

  return (
    <div className="tr-review">
      <div className="tr-scope"><Icon name="info" size={14} /><span>Здесь только <b>учебные</b> сделки тренажёра. Реальные сделки из Журнала и бумажные сделки робота в этот разбор не входят — и учебные не попадают в них.</span></div>

      <div className="tr-tiles" data-tour="trainer-summary">
        <div className="tr-tile"><span>Сделок</span><b>{s.n}</b></div>
        <div className="tr-tile"><span>Прибыльных</span><b>{pct(s.winRate)}</b></div>
        <div className="tr-tile"><span>Средний результат</span><b className={s.avgR >= 0 ? 'tr-pos' : 'tr-neg'}>{fmtR(s.avgR)}</b></div>
        <div className="tr-tile"><span>Итого</span><b className={s.totalR >= 0 ? 'tr-pos' : 'tr-neg'}>{fmtR(s.totalR)}</b></div>
        <div className="tr-tile"><span>Профит-фактор</span><b>{s.profitFactor == null ? '—' : s.profitFactor.toFixed(2).replace('.', ',')}</b></div>
        <div className="tr-tile"><span>Макс. серия убытков</span><b>{s.maxLossStreak}</b></div>
      </div>

      <div className="card">
        <h3 className="tr-side-title">Что заметил разбор</h3>
        {a.findings.map((f) => (
          <div key={f.id} className={`tr-finding ${f.level}`}>
            <Icon name={f.level === 'warn' ? 'warning' : 'info'} size={15} />
            <p>{f.text}</p>
          </div>
        ))}
        {a.findings.length === 0 && <p className="tr-muted">Явных повторяющихся привычек не найдено.</p>}
        <p className="tr-note">Это наблюдения по вашим учебным сделкам, а не советы вкладывать деньги: выборка небольшая, и случайность на ней всё ещё заметна.</p>
      </div>

      <div className="card">
        <h3 className="tr-side-title">По стратегиям (на бумаге)</h3>
        <div className="tr-table">
          {a.strategies.map((st) => (
            <div key={st.id || 'none'} className="tr-trow">
              <span className="tr-tname">{st.name}</span>
              <span className={`badge ${VERDICT_CLASS[st.code]}`}>{st.label}</span>
              <span className="tr-muted">{st.n} сделок · {pct(st.winRate)} прибыльных · {fmtR(st.avgR)} в среднем</span>
            </div>
          ))}
        </div>
        <p className="tr-note">«Проверена на бумаге» не означает «будет прибыльной». Учебные сделки не добавляются в реальную статистику стратегии в Капитале.</p>
      </div>

      <div className="card">
        <h3 className="tr-side-title">История и живые цены</h3>
        <div className="tr-table">
          {['history', 'live'].map((m) => (
            <div key={m} className="tr-trow">
              <span className="tr-tname">{MODE[m]}</span>
              <span className="tr-muted">{a.modes[m].n ? `${a.modes[m].n} сделок · ${pct(a.modes[m].winRate)} прибыльных · ${fmtR(a.modes[m].avgR)} в среднем` : 'пока нет сделок'}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 className="tr-side-title">Последние учебные сделки</h3>
        <div className="tr-table">
          {rows.map((t) => (
            <div key={t.id} className="tr-trow">
              <span className="badge badge-purple">Бумага</span>
              <span className="tr-tname">{t.ticker} ·{t.side === 'long' ? 'покупка' : 'продажа'}</span>
              <span className="tr-muted">{MODE[t.dataMode] || 'История'} · {REASON[t.exitReason] || t.exitReason} · {t.barsHeld} св.</span>
              <b className={t.r >= 0 ? 'tr-pos' : 'tr-neg'}>{fmtR(t.r)}</b>
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Удалить" onClick={() => remove(t.id)}><Icon name="trash" size={13} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
