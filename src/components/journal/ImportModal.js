// src/components/journal/ImportModal.js
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../context/AuthContext';
import { formatCurrency, formatNumber } from '../../utils/calculator';
import { parseTinkoffXlsx } from '../../services/import/tinkoffXlsx';
import { parseTinkoffPdfExact } from '../../services/import/tinkoffPdf';
import { parseTinkoffPdfViaAI } from '../../services/import/tinkoffPdfAi';
import { matchTransactionsToTrades, classifyForPreview, enrichPnl, commitImport, filterAlreadyImportedTransactions, sanityCheck } from '../../services/import/importTrades';
import { saveImportArtifacts } from '../../services/trades';
import { InfoTip } from '../shared/TechnicalAnalysisBlock';
import toast from 'react-hot-toast';
import './Journal.css';

const STAGES = [
  ['reading', 'Чтение файла'],
  ['parsing', 'Парсинг отчёта'],
  ['ai', 'AI-фолбэк'],
  ['fifo', 'Сопоставление FIFO'],
  ['dedup', 'Проверка дублей'],
];

const STATUS_LABEL = {
  new: { text: 'новая', cls: 'badge-green' },
  update: { text: 'обновление существующей', cls: 'badge-blue' },
  duplicate: { text: 'дубль — будет пропущено', cls: 'badge-gray' },
};

function fmtRange(candidate) {
  const o = candidate.openedAt ? new Date(candidate.openedAt).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';
  const c = candidate.closedAt ? new Date(candidate.closedAt).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : 'открыта';
  return `${o} → ${c}`;
}

export default function ImportModal({ existingTrades, onClose, onImported }) {
  const { user, userProfile } = useAuth();
  const [file, setFile] = useState(null);
  const [stage, setStage] = useState(null);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null); // { classified, repoCount, unmatchedCount, unexecutedCount, cancelledCount, flagged }
  const [checked, setChecked] = useState({});
  const [importing, setImporting] = useState(false);
  const [showHowTo, setShowHowTo] = useState(false);

  const handleFile = async (f) => {
    setFile(f);
    setError(null);
    setPreview(null);
    setStage('reading');
    try {
      let parseResult;
      if (f.name.toLowerCase().endsWith('.xlsx')) {
        setStage('parsing');
        parseResult = await parseTinkoffXlsx(f);
      } else if (f.name.toLowerCase().endsWith('.pdf')) {
        setStage('parsing');
        parseResult = await parseTinkoffPdfExact(f);
        if (!parseResult.ok) {
          setStage('ai');
          parseResult = await parseTinkoffPdfViaAI(f);
        }
      } else {
        throw new Error('Поддерживаются только .xlsx и .pdf файлы отчётов Т-Инвестиций');
      }

      if (!parseResult.ok) {
        throw new Error(parseResult.reason || 'Не удалось разобрать отчёт');
      }

      setStage('fifo');
      const newTransactions = filterAlreadyImportedTransactions(parseResult.transactions, existingTrades);
      const { matched, unmatchedClosings } = matchTransactionsToTrades(newTransactions, existingTrades);
      const enriched = await enrichPnl(matched, userProfile?.tinkoffToken);

      setStage('dedup');
      const classified = classifyForPreview(enriched, existingTrades)
        .map((c) => ({ ...c, warnings: sanityCheck(c.candidate, parseResult.reportPeriod) }));

      const initialChecked = {};
      classified.forEach((c, i) => { initialChecked[i] = c.status !== 'duplicate'; });
      setChecked(initialChecked);

      setPreview({
        classified,
        repoOperations: parseResult.repoOperations || [],
        unmatchedClosings,
        repoCount: parseResult.repoOperations?.length || 0,
        unmatchedCount: unmatchedClosings.length,
        unexecutedCount: parseResult.unexecutedCount || 0,
        cancelledCount: parseResult.cancelledCount || 0,
        flagged: parseResult.flaggedForReview || [],
        invalidRows: parseResult.invalidRows || [],
        unparsedDealNumbers: parseResult.unparsedDealNumbers || [],
      });
      setStage(null);
    } catch (e) {
      setError(e.message);
      setStage(null);
    }
  };

  const toggleAll = (val) => {
    const next = {};
    preview.classified.forEach((c, i) => { next[i] = c.status !== 'duplicate' ? val : false; });
    setChecked(next);
  };

  const handleImport = async () => {
    if (!preview) return;
    setImporting(true);
    try {
      const toImport = preview.classified
        .map((c, i) => ({ ...c, idx: i }))
        .filter((c) => checked[c.idx])
        .map((c) => c.candidate);

      const result = await commitImport(user.uid, toImport, existingTrades);

      // Saving unmatched/REPO artifacts is a "nice to have" for a future rebuild-journal
      // feature — it must never make a successful trade import look like it failed (that
      // invites the user to retry and create duplicates from a stale, pre-import dedup list).
      try {
        await saveImportArtifacts(user.uid, preview.unmatchedClosings, 'unmatched');
        await saveImportArtifacts(user.uid, preview.repoOperations, 'repo');
      } catch (artifactError) {
        console.error('Failed to save import artifacts (trades were still imported):', artifactError);
      }

      toast.success(
        `Создано ${result.created}, обновлено ${result.updated}, ` +
        `пропущено дублей ${result.skippedDuplicates}, не сопоставлено ${preview.unmatchedCount}, ` +
        `РЕПО-операций ${preview.repoCount}`
      );
      onImported();
    } catch (e) {
      toast.error('Ошибка импорта: ' + e.message);
    } finally {
      setImporting(false);
    }
  };

  // Portaled to document.body — rendered inline, .modal-overlay's position:fixed got
  // contained by the nearest .page ancestor instead of the real viewport, because .page
  // has `animation: fadeIn` and ANY ancestor with a non-none transform (even mid- or
  // post-animation, per spec) becomes the containing block for fixed descendants. The
  // overlay ended up sized to .page's box (which stops after the sidebar) instead of the
  // full screen — the modal visually "respected" the sidebar instead of centering on the
  // whole window (real user report/screenshot). Same root-cause class as the InfoTip fix
  // earlier — a portal sidesteps ancestor containment entirely, regardless of what CSS
  // any future page/animation adds above this component.
  return createPortal(
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      {/* The classification table's columns (checkbox, ticker, direction badge, date
          range, volume, P&L, status badge) don't fit inside 780px without truncating the
          last column — real user report/photo showed "СТАТ|" cut off with a horizontal
          scrollbar users didn't realize was there. Widened, capped to the viewport so it
          still fits on a laptop screen. */}
      <div className="modal" style={{maxWidth: 960, width: '96vw'}}>
        <div className="modal-header">
          <h2 className="modal-title">📥 Импорт отчёта Т-Инвестиций</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {!preview && (
            <>
              <div className="input-group">
                <label className="input-label">Файл отчёта (.xlsx или .pdf)</label>
                <input
                  className="input"
                  type="file"
                  accept=".xlsx,.pdf"
                  onChange={e => e.target.files[0] && handleFile(e.target.files[0])}
                />
              </div>

              <div style={{display:'flex', justifyContent:'flex-end', marginTop:8}}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowHowTo(v => !v)}
                >
                  ❓ Как это сделать?
                </button>
              </div>

              {showHowTo && (
                <div style={{marginTop:8, padding:'12px 16px', background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)', borderRadius:12, color:'var(--text-secondary)', fontSize:13, lineHeight:1.5}}>
                  Инструкция скоро появится здесь.
                </div>
              )}

              {stage && (
                <div style={{marginTop:16, display:'flex', flexDirection:'column', gap:8}}>
                  {STAGES.map(([key, label]) => {
                    const idx = STAGES.findIndex(s => s[0] === stage);
                    const thisIdx = STAGES.findIndex(s => s[0] === key);
                    const done = thisIdx < idx;
                    const active = key === stage;
                    if (key === 'ai' && stage !== 'ai' && !done) return null;
                    return (
                      <div key={key} style={{display:'flex', alignItems:'center', gap:8, fontSize:13,
                        color: active ? 'var(--accent-primary)' : done ? 'var(--green)' : 'var(--text-muted)'}}>
                        {active ? <div className="spinner" style={{width:14,height:14}}/> : done ? '✓' : '○'}
                        {label}
                      </div>
                    );
                  })}
                </div>
              )}

              {error && (
                <div style={{marginTop:16, padding:'12px 16px', background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:12, color:'var(--red)', fontSize:13}}>
                  {error}
                </div>
              )}
            </>
          )}

          {preview && preview.classified.length === 0 && (
            <div style={{textAlign:'center', padding:'32px 16px'}}>
              <div style={{fontSize:32, marginBottom:8}}>✅</div>
              <div style={{fontSize:15, fontWeight:600, marginBottom:6}}>Все сделки из этого отчёта уже загружены</div>
              <div style={{fontSize:13, color:'var(--text-muted)'}}>
                Новых сделок в файле не найдено — либо вы уже импортировали этот период, либо сделок в нём не было.
              </div>
            </div>
          )}

          {preview && preview.classified.length > 0 && (
            <>
              {/* Badges got their real names instead of Т-Инвестиций's report section
                  numbers (1.2/1.3), and the raw `title=` browser tooltip (a plain white
                  OS-styled box, clashing with the dark theme) swapped for the app's own
                  InfoTip — real user report on both counts. */}
              <div className="flex gap-2" style={{marginBottom:12, flexWrap:'wrap'}}>
                <span className="badge badge-blue" style={{display:'inline-flex', alignItems:'center', gap:5}}>
                  Неисполненные: {preview.unexecutedCount}
                  <InfoTip text="Заявки, которые вы выставили, но которые не исполнились до конца периода отчёта — не настоящие сделки, в журнал не попадают." />
                </span>
                <span className="badge badge-gray" style={{display:'inline-flex', alignItems:'center', gap:5}}>
                  Отменённые: {preview.cancelledCount}
                  <InfoTip text="Заявки, которые вы сами отменили до исполнения — не настоящие сделки, в журнал не попадают." />
                </span>
                <span className="badge badge-purple" style={{display:'inline-flex', alignItems:'center', gap:5}}>
                  Займы (РЕПО): {preview.repoCount}
                  <InfoTip text="РЕПО — займ у брокера под залог бумаг, не спекулятивная сделка. В журнал не попадают, но сохраняются отдельно на будущее." />
                </span>
                {preview.unmatchedCount > 0 && (
                  <span className="badge badge-red">Не сопоставлено: {preview.unmatchedCount}</span>
                )}
                {preview.flagged.length > 0 && (
                  <span className="badge badge-red">Требует проверки (ISIN не разрешён): {preview.flagged.length}</span>
                )}
                {preview.invalidRows?.length > 0 && (
                  <span className="badge badge-red">Невалидных строк от AI: {preview.invalidRows.length}</span>
                )}
                {preview.unparsedDealNumbers?.length > 0 && (
                  <span className="badge badge-red">Не распознано парсером: {preview.unparsedDealNumbers.length}</span>
                )}
                {preview.classified.some((c) => c.warnings?.length > 0) && (
                  <span className="badge badge-red">
                    ⚠️ Подозрительных позиций: {preview.classified.filter((c) => c.warnings?.length > 0).length}
                  </span>
                )}
              </div>

              {preview.unmatchedCount > 0 && (
                <div style={{marginBottom:12, padding:'12px 16px', background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:12, color:'var(--text-secondary)', fontSize:13, lineHeight:1.5}}>
                  ⚠️ {preview.unmatchedCount === 1 ? 'Одна сделка' : `${preview.unmatchedCount} сделки`} не сопоставилась — вероятно, позиция была открыта до начала периода отчёта.
                  Чтобы этого избежать, запросите у брокера отчёт за более широкий период (например, за весь год) или за месяц, когда позиция была открыта, и импортируйте его.
                </div>
              )}

              {preview.unparsedDealNumbers?.length > 0 && (
                <div style={{marginBottom:12, padding:'12px 16px', background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:12, color:'var(--text-secondary)', fontSize:13, lineHeight:1.5}}>
                  ⚠️ В отчёте есть {preview.unparsedDealNumbers.length === 1 ? 'строка' : 'строки'} с номером сделки
                  ({preview.unparsedDealNumbers.slice(0, 5).join(', ')}{preview.unparsedDealNumbers.length > 5 ? '…' : ''}),
                  которую парсер не смог разобрать в сделку — вероятно, потеряна. Проверьте эти сделки в отчёте вручную и добавьте их в журнал руками, если нужно.
                </div>
              )}

              <div className="flex gap-2" style={{marginBottom:8}}>
                <button className="btn btn-ghost btn-sm" onClick={() => toggleAll(true)}>Отметить все</button>
                <button className="btn btn-ghost btn-sm" onClick={() => toggleAll(false)}>Снять все</button>
              </div>

              <div className="table-wrapper" style={{maxHeight: 360, overflowY: 'auto'}}>
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th></th><th>Тикер</th><th>Направление</th><th>Открытие → Закрытие</th>
                      <th>Объём</th><th>P&L</th><th>Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.classified.map((c, i) => {
                      const t = c.candidate;
                      const isDup = c.status === 'duplicate';
                      return (
                        <tr key={i} style={isDup ? { opacity: 0.45 } : undefined}>
                          <td>
                            <input type="checkbox" checked={!!checked[i]}
                              onChange={e => setChecked(prev => ({ ...prev, [i]: e.target.checked }))} />
                          </td>
                          <td>
                            <span className="font-semibold">{t.ticker}</span>
                            {c.warnings?.length > 0 && (
                              <span title={c.warnings.join('; ')} style={{marginLeft:6, cursor:'help'}}>⚠️</span>
                            )}
                          </td>
                          <td>
                            <span className={`badge ${t.direction === 'long' ? 'badge-green' : 'badge-red'}`}>
                              {t.direction === 'long' ? '📈 Лонг' : '📉 Шорт'}
                            </span>
                          </td>
                          <td className="text-secondary" style={{whiteSpace:'nowrap'}}>{fmtRange(t)}</td>
                          <td>
                            {t.status === 'partial'
                              ? <span title="Осталось открыто / всего было">{formatNumber(t.remainingVolume)} / {formatNumber(t.volume)}</span>
                              : formatNumber(t.volume)}
                          </td>
                          <td>
                            {t.pnl !== null && t.pnl !== undefined
                              ? <span style={{ color: t.pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                                  {t.pnl >= 0 ? '+' : ''}{formatCurrency(Math.round(t.pnl))}
                                </span>
                              : t.pnlNeedsSpecs ? <span className="text-muted" title="Нет токена Тинькофф или спецификация недоступна">н/д</span> : '—'}
                          </td>
                          <td>
                            <span className={`badge ${STATUS_LABEL[c.status].cls}`}>{STATUS_LABEL[c.status].text}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          {preview && preview.classified.length === 0 ? (
            <button className="btn btn-primary" onClick={onClose}>Закрыть</button>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
              {preview && (
                <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
                  {importing ? <><div className="spinner" style={{width:14,height:14}}/> Импортируем...</> : `Импортировать (${Object.values(checked).filter(Boolean).length})`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
