// src/components/journal/ImportModal.js
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../context/AuthContext';
import { formatCurrency, formatNumber } from '../../utils/calculator';
import { parseTinkoffXlsx } from '../../services/import/tinkoffXlsx';
import { parseTinkoffPdfExact } from '../../services/import/tinkoffPdf';
import { parseTinkoffPdfViaAI } from '../../services/import/tinkoffPdfAi';
import { TinkoffAPI } from '../../services/tinkoff';
import { importFromTbankApi, buildApiDiagnostics } from '../../services/import/tbankApiImport';
import { matchTransactionsToTrades, classifyForPreview, enrichPnl, commitImport, filterAlreadyImportedTransactions, sanityCheck } from '../../services/import/importTrades';
import { saveImportArtifacts } from '../../services/trades';
import { InfoTip } from '../shared/TechnicalAnalysisBlock';
import toast from 'react-hot-toast';
import './Journal.css';

import Icon from '../shared/Icon';
const STAGES = [
  ['reading', 'Чтение файла'],
  ['parsing', 'Парсинг отчёта'],
  ['ai', 'AI-фолбэк'],
  ['fifo', 'Сопоставление FIFO'],
  ['dedup', 'Проверка дублей'],
];

// Этапы при загрузке прямо из Т-Банка (без файла).
const STAGES_API = [
  ['api', 'Загрузка сделок из Т-Банка'],
  ['fifo', 'Сопоставление FIFO'],
  ['dedup', 'Проверка дублей'],
];

const PERIODS = [
  { id: '90', label: '90 дней' },
  { id: '365', label: 'Год' },
  { id: 'all', label: 'Всё доступное время' },
];

// Когда ноги позиции записаны в журнал, дата может быть строкой, Date или Timestamp Firestore.
const legDate = (v) => (v?.toDate ? v.toDate() : new Date(v));

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

  // Источник: файл отчёта или загрузка сделок прямо из Т-Банка по токену из Настроек.
  const [mode, setMode] = useState('file');
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [period, setPeriod] = useState('365');
  const [apiProgress, setApiProgress] = useState(0);
  const hasToken = !!userProfile?.tinkoffToken;
  const stages = mode === 'api' ? STAGES_API : STAGES;

  // Список счетов — когда открыли вкладку «Из Т-Банка».
  useEffect(() => {
    if (mode !== 'api' || !hasToken || accounts.length) return undefined;
    let alive = true;
    (async () => {
      try {
        const list = (await new TinkoffAPI(userProfile.tinkoffToken).getAccounts()).filter((a) => a.status !== 'ACCOUNT_STATUS_CLOSED');
        if (!alive) return;
        setAccounts(list);
        setAccountId(userProfile?.tinkoffAccountId && list.some((a) => a.id === userProfile.tinkoffAccountId) ? userProfile.tinkoffAccountId : (list[0]?.id || ''));
        if (!list.length) setError('У токена нет доступных счетов');
      } catch (e) {
        if (alive) setError('Не удалось получить счета из Т-Банка: ' + e.message);
      }
    })();
    return () => { alive = false; };
  }, [mode, hasToken, accounts.length, userProfile]);

  // Общий путь для файла и для API: транзакции → FIFO → дубли → предпросмотр.
  const runPipeline = async (parseResult) => {
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

    // Загрузка из API: если в журнале за этот период уже есть сделки из другого источника (отчёт), а номера
    // сделок ни одной не совпали — не исключаем, что номера у отчёта и у API записываются по-разному и появятся дубли.
    let overlapWarning = null;
    const alreadyImportedCount = parseResult.transactions.length - newTransactions.length;
    if (parseResult.parseMethod === 'tbank-api' && parseResult.reportPeriod) {
      const { start, end } = parseResult.reportPeriod;
      const inPeriod = existingTrades.filter((t) => (t.legs || []).some((l) => {
        const d = legDate(l.timestampUtc);
        return d >= start && d <= end;
      }));
      if (inPeriod.length > 0 && parseResult.transactions.length > 0 && alreadyImportedCount === 0) {
        overlapWarning = `В журнале за этот период уже есть ${inPeriod.length} позиций (например, из отчёта), но номера сделок из Т-Банка с ними не совпали. `
          + 'Возможно, одни и те же сделки записаны дважды. Внимательно посмотрите на «новые» позиции ниже и не отмечайте те, что уже есть в журнале.';
      }
    }

    setPreview({
      classified,
      repoOperations: parseResult.repoOperations || [],
      unmatchedClosings,
      totalTransactions: parseResult.transactions.length,
      alreadyImportedCount,
      repoCount: parseResult.repoOperations?.length || 0,
      unmatchedCount: unmatchedClosings.length,
      unexecutedCount: parseResult.unexecutedCount || 0,
      cancelledCount: parseResult.cancelledCount || 0,
      flagged: parseResult.flaggedForReview || [],
      invalidRows: parseResult.invalidRows || [],
      unparsedDealNumbers: parseResult.unparsedDealNumbers || [],
      apiInfo: parseResult.apiInfo || null,
      overlapWarning,
    });
    setStage(null);
  };

  const handleApi = async () => {
    setError(null);
    setPreview(null);
    setApiProgress(0);
    setStage('api');
    try {
      if (!hasToken) throw new Error('Добавьте токен Т-Инвестиций в Настройках (достаточно права «только чтение»)');
      if (!accountId) throw new Error('Выберите счёт');
      const to = new Date();
      const from = period === 'all' ? new Date('2018-01-01T00:00:00Z') : new Date(to.getTime() - Number(period) * 86400000);
      const res = await importFromTbankApi(new TinkoffAPI(userProfile.tinkoffToken), { accountId, from, to, onProgress: setApiProgress });
      await runPipeline(res);
    } catch (e) {
      setError(e.message);
      setStage(null);
    }
  };

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

      await runPipeline(parseResult);
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
          <h2 className="modal-title">Импорт сделок Т-Инвестиций</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {!preview && (
            <>
              <div className="flex gap-2" style={{marginBottom:14}}>
                <button type="button" className={mode === 'file' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => { setMode('file'); setError(null); }}>Из файла отчёта</button>
                <button type="button" className={mode === 'api' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => { setMode('api'); setError(null); }}>Прямо из Т-Банка</button>
              </div>

              {mode === 'api' ? (
                !hasToken ? (
                  <div style={{padding:'12px 16px', background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)', borderRadius:12, color:'var(--text-secondary)', fontSize:13, lineHeight:1.5}}>
                    Для загрузки прямо из Т-Банка нужен токен Т-Инвестиций: добавьте его в Настройках. Достаточно права «только чтение» —
                    приложение ничего не покупает и не продаёт, оно лишь читает историю ваших сделок.
                  </div>
                ) : (
                  <>
                    <div className="input-group">
                      <label className="input-label">Счёт</label>
                      <select className="input" value={accountId} onChange={e => setAccountId(e.target.value)} disabled={!accounts.length}>
                        {accounts.length ? accounts.map(a => <option key={a.id} value={a.id}>{a.name || `Счёт …${String(a.id).slice(-4)}`}</option>) : <option>загружаю счета…</option>}
                      </select>
                    </div>
                    <div className="input-group">
                      <label className="input-label">За какой период</label>
                      <select className="input" value={period} onChange={e => setPeriod(e.target.value)}>
                        {PERIODS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                      <div style={{fontSize:12, color:'var(--text-muted)', marginTop:6, lineHeight:1.5}}>
                        Чем длиннее период, тем меньше «несопоставленных» закрытий: позиция, открытая раньше начала периода, не с чем сопоставить.
                      </div>
                    </div>
                    <button type="button" className="btn btn-primary" onClick={handleApi} disabled={!accountId || !!stage}>Загрузить сделки из Т-Банка</button>
                    <div style={{fontSize:12, color:'var(--text-muted)', marginTop:10, lineHeight:1.5}}>
                      Только чтение. Дальше будет предпросмотр — в журнал ничего не пишется, пока вы не нажмёте «Импортировать».
                    </div>
                  </>
                )
              ) : (
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
                      Как это сделать?
                    </button>
                  </div>

                  {showHowTo && (
                    <div style={{marginTop:8, padding:'12px 16px', background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)', borderRadius:12, color:'var(--text-secondary)', fontSize:13, lineHeight:1.5}}>
                      Инструкция скоро появится здесь.
                    </div>
                  )}
                </>
              )}

              {stage && (
                <div style={{marginTop:16, display:'flex', flexDirection:'column', gap:8}}>
                  {stages.map(([key, label]) => {
                    const idx = stages.findIndex(s => s[0] === stage);
                    const thisIdx = stages.findIndex(s => s[0] === key);
                    const done = thisIdx < idx;
                    const active = key === stage;
                    if (key === 'ai' && stage !== 'ai' && !done) return null;
                    return (
                      <div key={key} style={{display:'flex', alignItems:'center', gap:8, fontSize:13,
                        color: active ? 'var(--accent-primary)' : done ? 'var(--green)' : 'var(--text-muted)'}}>
                        {active ? <div className="spinner" style={{width:14,height:14}}/> : done ? '✓' : '○'}
                        {label}{key === 'api' && active && apiProgress > 0 ? ` — получено операций: ${apiProgress}` : ''}
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

          {preview?.apiInfo && (
            <div style={{marginBottom:12, padding:'12px 16px', background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)', borderRadius:12, fontSize:13, lineHeight:1.6, color:'var(--text-secondary)'}}>
              <div>
                Из Т-Банка: операций-сделок <b>{preview.apiInfo.stats.tradeOperations}</b>, исполнений <b>{preview.apiInfo.stats.deals}</b>
                {' '}(акции {preview.apiInfo.stats.byKind.stock}, фьючерсы {preview.apiInfo.stats.byKind.future}).
                {preview.apiInfo.skipped.length > 0 && <> Пропущено: <b style={{color:'var(--gold)'}}>{preview.apiInfo.skipped.length}</b>.</>}
              </div>
              {preview.apiInfo.skipped.length > 0 && (
                <ul style={{margin:'6px 0 0 18px', padding:0, fontSize:12, color:'var(--text-muted)'}}>
                  {preview.apiInfo.skipped.slice(0, 6).map((s, i) => (
                    <li key={i}>{s.ticker || '—'} {s.date ? new Date(s.date).toLocaleDateString('ru-RU') : ''}: {s.reason}</li>
                  ))}
                  {preview.apiInfo.skipped.length > 6 && <li>…и ещё {preview.apiInfo.skipped.length - 6}</li>}
                </ul>
              )}
              {preview.overlapWarning && (
                <div style={{marginTop:10, padding:'10px 12px', background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:10, color:'var(--text-secondary)'}}>
                  {preview.overlapWarning}
                </div>
              )}
              <div style={{marginTop:10}}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
                  navigator.clipboard.writeText(buildApiDiagnostics(preview.apiInfo))
                    .then(() => toast.success('Диагностика скопирована — вставьте её в чат'))
                    .catch(() => toast.error('Не удалось скопировать'));
                }}>Скопировать диагностику</button>
                <span style={{fontSize:12, color:'var(--text-muted)', marginLeft:8}}>если цифры ниже не сходятся с отчётом — вставьте её в чат (там нет токена и номера счёта)</span>
              </div>
            </div>
          )}

          {preview && preview.classified.length === 0 && (
            <div style={{textAlign:'center', padding:'32px 16px'}}>
              {preview.alreadyImportedCount > 0 ? (
                <>
                  <div style={{marginBottom:8, color:'var(--green)'}}><Icon name="checkCircle" size={34} /></div>
                  <div style={{fontSize:15, fontWeight:600, marginBottom:6}}>Эти сделки уже загружены в журнал этого аккаунта</div>
                  <div style={{fontSize:13, color:'var(--text-muted)'}}>
                    Уже есть в журнале: {preview.alreadyImportedCount} из {preview.totalTransactions} операций отчёта.
                  </div>
                </>
              ) : preview.unmatchedCount > 0 ? (
                <>
                  <div style={{marginBottom:8, color:'var(--gold)'}}><Icon name="warning" size={34} /></div>
                  <div style={{fontSize:15, fontWeight:600, marginBottom:6}}>Дублей нет, но сделки не с чем сопоставить</div>
                  <div style={{fontSize:13, color:'var(--text-muted)'}}>
                    В отчёте {preview.unmatchedCount} закрывающих операций, а покупок/продаж, которые они закрывают, в файле нет —
                    позиции были открыты раньше периода отчёта. Загрузите сначала более ранний период (или весь отчёт целиком), затем этот.
                  </div>
                </>
              ) : (
                <>
                  <div style={{marginBottom:8, color:'var(--text-muted)'}}><Icon name="file" size={34} /></div>
                  <div style={{fontSize:15, fontWeight:600, marginBottom:6}}>В отчёте не найдено сделок</div>
                  <div style={{fontSize:13, color:'var(--text-muted)'}}>
                    Операций в файле: {preview.totalTransactions}. Проверьте, что это брокерский отчёт Т-Инвестиций с разделом сделок.
                  </div>
                </>
              )}
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
                    Подозрительных позиций: {preview.classified.filter((c) => c.warnings?.length > 0).length}
                  </span>
                )}
              </div>

              {preview.unmatchedCount > 0 && (
                <div style={{marginBottom:12, padding:'12px 16px', background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:12, color:'var(--text-secondary)', fontSize:13, lineHeight:1.5}}>
                  {preview.unmatchedCount === 1 ? 'Одна сделка' : `${preview.unmatchedCount} сделки`} не сопоставилась — вероятно, позиция была открыта до начала периода отчёта.
                  Чтобы этого избежать, запросите у брокера отчёт за более широкий период (например, за весь год) или за месяц, когда позиция была открыта, и импортируйте его.
                </div>
              )}

              {preview.unparsedDealNumbers?.length > 0 && (
                <div style={{marginBottom:12, padding:'12px 16px', background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:12, color:'var(--text-secondary)', fontSize:13, lineHeight:1.5}}>
                  В отчёте есть {preview.unparsedDealNumbers.length === 1 ? 'строка' : 'строки'} с номером сделки
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
                              <span title={c.warnings.join('; ')} style={{marginLeft:6, cursor:'help', display:'inline-flex', verticalAlign:'middle', color:'var(--gold)'}}><Icon name="warning" size={13} /></span>
                            )}
                          </td>
                          <td>
                            <span className={`badge ${t.direction === 'long' ? 'badge-green' : 'badge-red'}`}>
                              {t.direction === 'long' ? 'Лонг' : 'Шорт'}
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
                                  {t.pnl > 0 ? '+' : ''}{formatCurrency(Math.round(t.pnl))}
                                </span>
                              : t.pnlNeedsSpecs ? <span className="text-muted" title="Нет токена Т-Инвестиций или спецификация недоступна">н/д</span> : '—'}
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
