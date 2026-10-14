// src/components/cockpit/PaperActions.js
//
// «Что сделали ВЫ по этому сигналу». Бумажную сделку ведёт робот, и приложение не знало, торговали
// ли вы по сигналу, пропустили ли, снимали ли часть. Здесь это отмечается двумя способами:
//   • вручную — «Вошёл», «Пропустил» (с причиной), «Снял часть», «Закрыл целиком»;
//   • по данным Т-Банка — «Проверить по Т-Банку» читает ваши позиции и предлагает отметку сама
//     (только чтение; та же сверка, что делает фоновый робот).
// Из этих отметок складывается журнал решений: по ним отчёт потом сравнивает, как вы торговали по
// сигналам и как отработала бы система без вас.
import React, { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import Icon from '../shared/Icon';
import { addPaperDecision, updatePaperTrade } from '../../services/paperTrades';
import { fetchOpenPositions, resolveAccountId } from '../../services/positionSync';
import { PAPER_SKIP_REASONS } from '../../services/alerts';
import {
  ACTION_LABELS, summarizeDecisions, statusLine, reconcileWithBroker, eventToDecision, describeEvent,
} from '../../services/analytics/actionMatch';

const fmtAt = (v) => {
  if (!v) return '';
  const d = v.toDate ? v.toDate() : (v.seconds != null ? new Date(v.seconds * 1000) : new Date(v));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export default function PaperActions({ trade, journalTrades = [], userProfile, onDecision }) {
  const [busy, setBusy] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [found, setFound] = useState(null); // результат проверки по Т-Банку: { events, patch }

  const sum = useMemo(() => summarizeDecisions(trade), [trade]);
  const line = statusLine(trade);
  const history = useMemo(() => {
    const list = Array.isArray(trade.decisions) ? [...trade.decisions] : [];
    return list.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
  }, [trade.decisions]);

  const record = async (decision, message) => {
    setBusy(true);
    try {
      const d = { ...decision, at: new Date().toISOString() };
      await addPaperDecision(trade.id, d);
      onDecision?.(trade.id, d);
      toast.success(message || 'Записано');
    } catch (e) {
      toast.error('Не удалось записать: ' + (e.message || 'ошибка'));
    }
    setBusy(false);
  };

  const check = async () => {
    const token = userProfile?.tinkoffToken;
    if (!token) { toast.error('Нужен токен Т-Банка — добавьте его в Настройках'); return; }
    setBusy(true);
    setFound(null);
    try {
      const accountId = await resolveAccountId({ token, profile: userProfile });
      const positions = await fetchOpenPositions({ token, accountId });
      const balances = {};
      for (const p of positions) {
        if (!p.ticker) continue;
        const k = String(p.ticker).toUpperCase();
        balances[k] = (balances[k] || 0) + (Number(p.quantity) || 0);
      }
      const r = reconcileWithBroker({
        paperTrades: [trade],
        balances,
        journalTrades: journalTrades.filter((t) => t.status === 'open' || t.status === 'partial'),
      });
      const alreadyJournal = r.patches[trade.id]?.state === 'journal';
      setFound({ events: r.events, patch: r.patches[trade.id] || null, alreadyJournal, none: !r.events.length && !alreadyJournal });
    } catch (e) {
      toast.error('Не удалось спросить Т-Банк: ' + (e.message || 'ошибка'));
    }
    setBusy(false);
  };

  const applyFound = async (ev) => {
    const dec = eventToDecision(ev);
    if (!dec) return;
    setBusy(true);
    try {
      await addPaperDecision(trade.id, dec);
      if (found?.patch) await updatePaperTrade(trade.id, { brokerWatch: found.patch });
      onDecision?.(trade.id, dec);
      toast.success('Отметка записана');
      setFound(null);
    } catch (e) {
      toast.error('Не удалось записать: ' + (e.message || 'ошибка'));
    }
    setBusy(false);
  };

  return (
    <section className="ck-panel pa-wrap">
      <div className="pa-head">
        <h3>Что вы сделали по этому сигналу</h3>
        {line ? <span className={`pa-status ${sum.auto ? 'auto' : ''}`}>{line}{sum.auto ? ' · по данным Т-Банка' : ''}</span>
          : <span className="pa-status none">пока не отмечено</span>}
      </div>

      <div className="pa-btns">
        <button className="ck-btn" disabled={busy} onClick={() => record({ action: 'entered', via: 'app' }, 'Отметила: вошли по сигналу')}>
          <Icon name="check" size={14} style={{ marginRight: 6 }} />Вошёл
        </button>
        <button className="ck-btn" disabled={busy} onClick={() => setSkipOpen((v) => !v)}>
          <Icon name="minus" size={14} style={{ marginRight: 6 }} />Пропустил
        </button>
        <button className="ck-btn" disabled={busy} onClick={() => record({ action: 'fixed_partial', via: 'app' }, 'Отметила: сняли часть')}>
          Снял часть
        </button>
        <button className="ck-btn" disabled={busy} onClick={() => record({ action: 'closed_full', via: 'app' }, 'Отметила: закрыли целиком')}>
          Закрыл целиком
        </button>
        <button className="ck-btn pa-check" disabled={busy} onClick={check} title="Прочитать ваши позиции в Т-Банке и предложить отметку (только чтение)">
          <Icon name="refresh" size={14} style={{ marginRight: 6 }} />{busy ? 'Смотрю…' : 'Проверить по Т-Банку'}
        </button>
      </div>

      {skipOpen && (
        <div className="pa-reasons">
          <span className="ck-k">Почему пропустили?</span>
          {PAPER_SKIP_REASONS.map((r) => (
            <button key={r.code} className="ck-share" disabled={busy}
              onClick={async () => { await record({ action: 'skipped', reason: r.label, via: 'app' }, `Причина: ${r.label.toLowerCase()}`); setSkipOpen(false); }}>
              {r.label}
            </button>
          ))}
        </div>
      )}

      {found && (
        <div className="pa-found">
          {found.none && <div className="pa-found-row">В Т-Банке по этому инструменту ничего не изменилось — позиции в сторону сигнала нет.</div>}
          {found.alreadyJournal && <div className="pa-found-row">Позиция по этому инструменту уже записана в вашем Журнале — отдельная отметка не нужна.</div>}
          {found.events.map((ev, i) => (
            <div key={i} className="pa-found-row">
              <span>{describeEvent(ev)}</span>
              {ev.kind !== 'system_exit_still_holding' && (
                <button className="ck-btn ck-btn-primary" disabled={busy} onClick={() => applyFound(ev)}>Записать</button>
              )}
            </div>
          ))}
        </div>
      )}

      {sum.entered && (
        <div className="pa-wrong">
          <button className="pa-link" disabled={busy} onClick={() => record({ action: 'not_this', via: 'app' }, 'Отметка снята')}>
            Это была не эта сделка — снять отметку
          </button>
        </div>
      )}

      {history.length > 0 && (
        <ul className="pa-history">
          {history.map((d, i) => (
            <li key={i}>
              <span className="pa-h-at">{fmtAt(d.at)}</span>
              <span>{ACTION_LABELS[d.action] || d.action}{d.reason ? ` — ${d.reason}` : ''}</span>
              <span className="pa-h-via">{d.via === 'broker' ? 'Т-Банк' : d.via === 'telegram' ? 'Telegram' : 'приложение'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
