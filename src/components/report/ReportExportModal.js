// src/components/report/ReportExportModal.js
//
// Окно «Выгрузить отчёт»: период, срез, стратегии и разделы — и кнопки «Скачать PDF» / «Скачать Word». Модель отчёта строится
// чистой функцией (services/report/exportReport.js), рисуют её pdfDoc.js и docxDoc.js; тяжёлые библиотеки подгружаются только
// по нажатию. Выбор запоминается в браузере.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import Icon from '../shared/Icon';
import { SCOPES } from '../../services/analytics/periodReport';
import {
  PERIOD_PRESETS, SECTIONS, DEFAULT_SECTIONS, resolvePeriod, buildExportReport, toDateInput, fmtMoney, plural,
} from '../../services/report/exportReport';
import ReportScheduleTab from './ReportScheduleTab';
import { buildPdfBlob, buildDocxBlob, downloadBlob, reportFileName } from '../../services/report/exportClient';
import './ReportExport.css';

const LS_KEY = 'tp_report_export_v1';
const readPrefs = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; } };
const writePrefs = (p) => { try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* приватный режим */ } };
const tzOffset = () => -new Date().getTimezoneOffset();

export default function ReportExportModal({
  open, onClose, realTrades = [], paperTrades = [], strategyList = [], defaultScope = 'real', defaultStrategies = [],
  profile = {}, legPnl = null, habitsFn = null, userName = '', pageRange = null, canSchedule = false, updateUserProfile = null,
}) {
  const [tab, setTab] = useState('now');
  const saved = useMemo(readPrefs, []);
  const [preset, setPreset] = useState(saved.preset || 'last_month');
  const [from, setFrom] = useState(saved.from || '');
  const [to, setTo] = useState(saved.to || '');
  const [scope, setScope] = useState(defaultScope);
  const [picked, setPicked] = useState(defaultStrategies);
  const [sections, setSections] = useState(Array.isArray(saved.sections) && saved.sections.length ? saved.sections : DEFAULT_SECTIONS);
  const [busy, setBusy] = useState('');

  useEffect(() => { if (open) { setScope(defaultScope); setPicked(defaultStrategies); setTab('now'); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // «Как на странице»: период, который сейчас открыт в отчёте
  const pageDates = useMemo(() => {
    if (!pageRange?.key) return null;
    if (pageRange.type === 'year') return { from: `${pageRange.key}-01-01`, to: `${pageRange.key}-12-31` };
    const [y, m] = pageRange.key.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
  }, [pageRange]);

  const period = useMemo(() => {
    try {
      if (preset === 'page' && pageDates) return resolvePeriod({ preset: 'custom', from: pageDates.from, to: pageDates.to, tzOffsetMin: tzOffset() });
      if (preset === 'custom') return resolvePeriod({ preset: 'custom', from, to, tzOffsetMin: tzOffset() });
      return resolvePeriod({ preset, tzOffsetMin: tzOffset() });
    } catch { return null; }
  }, [preset, from, to, pageDates]);
  const customError = preset === 'custom' && (!from || !to || !period) ? (from && to ? 'Дата конца раньше даты начала' : 'Укажите обе даты') : '';

  const model = useMemo(() => {
    if (!open || !period) return null;
    return buildExportReport({
      realTrades, paperTrades, scope, strategyNames: picked, period, sections, profile, legPnl, habitsFn, userName,
    });
  }, [open, period, realTrades, paperTrades, scope, picked, sections, profile, legPnl, habitsFn, userName]);

  if (!open) return null;

  const toggleSection = (id) => setSections((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const toggleStrategy = (name) => setPicked((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]));
  const remember = () => writePrefs({ preset: preset === 'page' ? 'last_month' : preset, from, to, sections });

  async function run(kind) {
    if (!model) return;
    if (!sections.length) { toast.error('Выберите хотя бы один раздел'); return; }
    setBusy(kind);
    try {
      remember();
      const blob = kind === 'pdf' ? await buildPdfBlob(model) : await buildDocxBlob(model);
      downloadBlob(blob, reportFileName(model, kind === 'pdf' ? 'pdf' : 'docx'));
      toast.success(kind === 'pdf' ? 'PDF готов — проверьте загрузки' : 'Word готов — проверьте загрузки');
    } catch (e) {
      toast.error(`Не удалось собрать файл: ${e?.message || 'ошибка'}`);
    }
    setBusy('');
  }

  const summary = model && !customError
    ? (model.empty ? 'За этот период закрытых сделок нет — отчёт получится пустым.'
      : `${model.meta.period.title}: ${model.stats.total} ${plural(model.stats.total, ['сделка', 'сделки', 'сделок'])}, ${fmtMoney(model.stats.pnl)}`)
    : '';

  return createPortal(
    <div className="rx-overlay" role="dialog" aria-modal="true" aria-label="Выгрузить отчёт" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="rx-modal">
        <header className="rx-head">
          <div>
            <h2>Выгрузить отчёт</h2>
            <p>Красиво оформленный файл за любой период — PDF или Word</p>
          </div>
          <button type="button" className="rx-x" aria-label="Закрыть" onClick={onClose}><Icon name="close" size={16} /></button>
        </header>

        {canSchedule && (
          <div className="rx-tabs" role="tablist" aria-label="Режим">
            <button type="button" role="tab" aria-selected={tab === 'now'} className={tab === 'now' ? 'on' : ''} onClick={() => setTab('now')}>Скачать сейчас</button>
            <button type="button" role="tab" aria-selected={tab === 'schedule'} className={tab === 'schedule' ? 'on' : ''} onClick={() => setTab('schedule')}>По расписанию</button>
          </div>
        )}

        {tab === 'schedule' && canSchedule ? (
          <ReportScheduleTab profile={profile} updateUserProfile={updateUserProfile} strategyList={strategyList} defaultSections={sections} />
        ) : (<>
        <div className="rx-body">
          <section className="rx-block">
            <h3>Период</h3>
            <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Период">
              {pageDates && <option value="page">Как на странице: {pageRange.label}</option>}
              {PERIOD_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {preset === 'custom' && (
              <div className="rx-dates">
                <label>С <input type="date" className="input" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
                <label>По <input type="date" className="input" value={to} min={from || undefined} max={toDateInput(Date.now(), tzOffset())} onChange={(e) => setTo(e.target.value)} /></label>
              </div>
            )}
            {customError && <p className="rx-error">{customError}</p>}
            {period && !customError && <p className="rx-note">{period.rangeText} · для сравнения берётся {period.prev.title.toLowerCase()}</p>}
          </section>

          <section className="rx-block">
            <h3>Какие сделки</h3>
            <div className="rx-seg" role="tablist" aria-label="Срез">
              {SCOPES.map((s) => <button key={s.id} type="button" className={scope === s.id ? 'on' : ''} onClick={() => setScope(s.id)}>{s.label}</button>)}
            </div>
            {strategyList.length > 1 && (
              <div className="rx-chips" aria-label="Стратегии">
                <button type="button" className={`rx-chip ${picked.length === 0 ? 'on' : ''}`} onClick={() => setPicked([])}>Все стратегии</button>
                {strategyList.map((s) => (
                  <button key={s.name} type="button" className={`rx-chip ${picked.includes(s.name) ? 'on' : ''}`} onClick={() => toggleStrategy(s.name)}>{s.name}</button>
                ))}
              </div>
            )}
          </section>

          <section className="rx-block">
            <h3>Что внутри</h3>
            <div className="rx-sections">
              {SECTIONS.map((s) => (
                <label key={s.id} className="rx-check">
                  <input type="checkbox" checked={sections.includes(s.id)} onChange={() => toggleSection(s.id)} />
                  <span><b>{s.label}</b><small>{s.hint}</small></span>
                </label>
              ))}
            </div>
          </section>
        </div>

        <footer className="rx-foot">
          <p className={`rx-summary ${model?.empty ? 'warn' : ''}`}>{summary}</p>
          <div className="rx-actions">
            <button type="button" className="btn btn-primary" disabled={!!busy || !model || !!customError} onClick={() => run('pdf')}>
              <Icon name="download" size={14} /> {busy === 'pdf' ? 'Собираю PDF…' : 'Скачать PDF'}
            </button>
            <button type="button" className="btn btn-secondary" disabled={!!busy || !model || !!customError} onClick={() => run('docx')}>
              <Icon name="file" size={14} /> {busy === 'docx' ? 'Собираю Word…' : 'Скачать Word'}
            </button>
          </div>
        </footer>
        </>)}
      </div>
    </div>,
    document.body,
  );
}
