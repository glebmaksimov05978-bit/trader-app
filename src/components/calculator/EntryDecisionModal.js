// src/components/calculator/EntryDecisionModal.js
//
// Короткий вопрос после входа в сделку из Калькулятора: ПО КАКОЙ причине вы вошли — по сигналу
// стратегии или по своему решению. Ответ ложится в сделку (entryDecision) и, если вошли по
// бумажному сигналу, отмечает его «вошёл». Из этого складывается журнал решений в отчёте:
// сколько входов было по сигналам и чем отличается результат от входов «по настроению».
//
// Выключается в Настройках (decisionPrompt = false). Вопрос необязательный — можно пропустить.
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { updateTrade } from '../../services/trades';
import { addPaperDecision } from '../../services/paperTrades';
import { ENTRY_KIND_LABELS } from '../../services/analytics/decisionJournal';

const OTHER_KINDS = ['own_strategy', 'own_analysis', 'emotion', 'other'];

export default function EntryDecisionModal({ ask, onClose }) {
  const [choice, setChoice] = useState(null); // { kind, paperId?, strategyName? }
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  if (!ask) return null;

  const papers = ask.papers || [];

  const save = async () => {
    if (!choice) { onClose(); return; }
    setSaving(true);
    try {
      const at = new Date().toISOString();
      await updateTrade(ask.tradeId, {
        entryDecision: {
          kind: choice.kind,
          paperId: choice.paperId || null,
          strategyName: choice.strategyName || null,
          note: note.trim() || null,
          at,
        },
      });
      if (choice.paperId) {
        await addPaperDecision(choice.paperId, { at, action: 'entered', via: 'app', reason: 'вход из Калькулятора' });
      }
      toast.success('Причина входа записана');
      onClose();
    } catch (e) {
      toast.error('Не удалось записать: ' + (e.message || 'ошибка'));
    }
    setSaving(false);
  };

  const chip = (on) => ({
    padding: '8px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, textAlign: 'left',
    border: `1px solid ${on ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
    background: on ? 'color-mix(in srgb, var(--accent-primary) 14%, transparent)' : 'var(--bg-surface-2)',
    color: 'var(--text-primary)',
  });

  return (
    <div className="calc-modal-overlay" onClick={onClose}>
      <div className="calc-modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>Почему вошли?</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 16px' }}>
          {ask.ticker} · {ask.direction === 'short' ? 'шорт' : 'лонг'}. Одна отметка — и отчёт сможет сравнить входы по сигналам
          с входами по своему решению.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {papers.map((p) => (
            <button key={p.id} style={chip(choice?.paperId === p.id)}
              onClick={() => setChoice({ kind: 'signal', paperId: p.id, strategyName: p.entryStrategyName || null })}>
              По сигналу «{p.entryStrategyName || 'стратегия'}»{p.entryTimeframe ? ` (${p.entryTimeframe})` : ''} — бумажная сделка открыта
            </button>
          ))}
          {!papers.length && (
            <button style={chip(choice?.kind === 'signal')} onClick={() => setChoice({ kind: 'signal' })}>
              {ENTRY_KIND_LABELS.signal}
            </button>
          )}
          {OTHER_KINDS.map((k) => (
            <button key={k} style={chip(choice?.kind === k)} onClick={() => setChoice({ kind: k })}>
              {ENTRY_KIND_LABELS[k]}
            </button>
          ))}
        </div>

        <textarea
          className="input" style={{ marginTop: 12, minHeight: 56 }}
          value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Короткая заметка (необязательно)"
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving || !choice}>
            {saving ? 'Сохраняю…' : 'Записать'}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Пропустить</button>
        </div>
      </div>
    </div>
  );
}
