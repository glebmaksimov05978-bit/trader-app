// src/components/cockpit/RadarPanel.js
//
// Радар входа внутри «Сопровождения» — тот же самый механизм, что уже работает в
// Журнале и на Дашборде (RadarLiveContext + services/radar.js), просто показан здесь,
// рядом с открытой позицией, чтобы не переключаться между вкладками. Ничего не
// дублирует: список инструментов и опрос стратегии — общие на всё приложение.
//
// Раньше добавить тикер можно было только из Журнала, и только вписав его руками —
// теперь здесь же открывается каталог: инструмент можно найти по названию, отметить
// сразу несколько и сразу выбрать таймфрейм проверки.
import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { useRadarLive } from '../../context/RadarLiveContext';
import { getRadarItems, addRadarItem, deleteRadarItem } from '../../services/radar';
import { getUserTrades } from '../../services/trades';
import { getActiveStrategy, getStrategies } from '../../services/analytics/strategy';
import { catalogEntry } from '../../services/marketData/instrumentCatalog';
import CollapsibleSection from './CollapsibleSection';
import InstrumentPicker from './InstrumentPicker';

export default function RadarPanel() {
  const { user, userProfile } = useAuth();
  const navigate = useNavigate();
  const { radarLive, setRadarLive, radarUpdatedAt, radarResults } = useRadarLive() || {};
  const [items, setItems] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ownTickers, setOwnTickers] = useState([]);
  // Какой стратегией сейчас смотрим список: 'all' — все тикеры разом, иначе только те,
  // что отслеживаются выбранной стратегией.
  const [filterId, setFilterId] = useState('all');
  const strategies = getStrategies(userProfile);
  const strategy = getActiveStrategy(userProfile);
  // Каждый тикер может смотреться по своей стратегии — резолвится так же, как в
  // RadarLiveContext: своя стратегия, если задана и ещё существует, иначе активная.
  const strategyOf = (item) => (item.strategyId && strategies.find((s) => s.id === item.strategyId)) || strategy;

  const load = () => { if (user) getRadarItems(user.uid).then(setItems).catch(() => setItems([])); };
  useEffect(load, [user]);

  // «Вы этим торговали» — самые частые тикеры из журнала. Читается один раз при первом
  // открытии каталога: на старте вкладки это лишний запрос, а внутри окна — самая
  // полезная подсказка, с чего начать список наблюдения.
  const openPicker = async () => {
    setPickerOpen(true);
    if (ownTickers.length || !user) return;
    try {
      const trades = await getUserTrades(user.uid);
      const counts = {};
      for (const t of trades) {
        const tk = (t.ticker || '').toUpperCase();
        if (tk) counts[tk] = (counts[tk] || 0) + 1;
      }
      setOwnTickers(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tk]) => tk));
    } catch {
      setOwnTickers([]);
    }
  };

  const handleAdd = async (picked, { timeframe, strategyId }) => {
    setSaving(true);
    try {
      // Последовательно, а не Promise.all: если на середине списка что-то упадёт,
      // добавленное до этого останется добавленным, и трейдер увидит честное «N из M».
      let ok = 0;
      for (const p of picked) {
        try {
          await addRadarItem(user.uid, { ticker: p.ticker, instrumentType: p.type || 'stock', timeframe, strategyId });
          ok += 1;
        } catch { /* считаем ниже */ }
      }
      if (ok === picked.length) toast.success(ok === 1 ? `${picked[0].ticker} в радаре` : `Добавлено: ${ok}`);
      else toast.error(`Добавлено ${ok} из ${picked.length}`);
      setPickerOpen(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item) => {
    setItems((cur) => cur.filter((i) => i.id !== item.id)); // мгновенно, без ожидания сети
    try {
      await deleteRadarItem(item.id);
    } catch {
      toast.error('Не удалось убрать из радара');
      load();
    }
  };

  // Сколько тикеров реально смотрится каждой стратегией — переключатель должен показывать
  // не просто список стратегий, а где сейчас что-то отслеживается.
  const countFor = (id) => items.filter((i) => strategyOf(i)?.id === id).length;
  const visible = filterId === 'all' ? items : items.filter((i) => strategyOf(i)?.id === filterId);

  return (
    <CollapsibleSection
      title="Радар входа"
      badge={items.length}
      actions={(
        <button className={`ck-radar-live ${radarLive ? 'on' : ''}`} onClick={() => setRadarLive?.(!radarLive)} title="Следить за списком автоматически">
          {radarLive ? '●' : '○'}
        </button>
      )}
    >
      {/* Переключатель, КАКИЕ тикеры сейчас показывать в списке — не путать с «активной
          стратегией» профиля ниже (та ровно одна и используется для новых сделок).
          «Активная: Все» звучало так, будто у профиля вдруг стало много активных
          стратегий сразу, — реальная жалоба «так не бывает». Это просто фильтр вида. */}
      {strategies.length > 1 && (
        <div className="ck-radar-strategy">
          Показывать:{' '}
          <select
            className="ck-select-dark ck-radar-filter-sel"
            value={filterId}
            onChange={(e) => setFilterId(e.target.value)}
            title="Показать тикеры конкретной стратегии"
          >
            <option value="all">Все инструменты ({items.length})</option>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>{s.name || 'Без названия'} ({countFor(s.id)})</option>
            ))}
          </select>
        </div>
      )}
      {/* По умолчанию новый тикер смотрится по активной стратегии профиля — но при
          добавлении можно выбрать другую именно для него (см. InstrumentPicker). */}
      <div className="ck-radar-strategy">
        По умолчанию для новых: <b>{strategy?.name || 'не выбрана'}</b>
        {' · '}<Link to="/settings">сменить</Link>
      </div>
      {radarUpdatedAt && (
        <div className="ck-radar-updated">
          обновлено {radarUpdatedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}

      <div className="ck-radar-list">
        {!items.length && (
          <div className="ck-radar-empty">Список пуст — выберите инструменты в каталоге ниже.</div>
        )}
        {!!items.length && !visible.length && (
          <div className="ck-radar-empty">
            По этой стратегии ни одного тикера. Переключите фильтр наверху или смените
            стратегию у нужного тикера.
          </div>
        )}
        {visible.map((it) => {
          const res = radarResults?.[it.id];
          const itemStrategy = strategyOf(it);
          const pct = res?.result?.total ? Math.round((res.result.passed / res.result.total) * 100) : null;
          const hot = pct != null && pct >= (itemStrategy?.readinessThreshold ?? 100);
          const known = catalogEntry(it.ticker);
          return (
            <div key={it.id} className="ck-radar-item">
              <button
                className={`ck-radar-row ${hot ? 'hot' : ''}`}
                onClick={() => navigate(`/calculator?ticker=${encodeURIComponent(it.ticker)}&type=${encodeURIComponent(it.instrumentType || 'stock')}`)}
                title="Открыть график инструмента"
              >
                <RadarRing pct={pct} hot={hot} />
                <div className="ck-radar-info">
                  <div className="ck-radar-ticker">
                    {it.ticker}
                    {known && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {known.name}</span>}
                  </div>
                  <div className="ck-radar-sub">
                    {res?.error ? res.error
                      : pct != null ? `${res.result.passed} из ${res.result.total} условий`
                        : 'ждёт проверки'}
                  </div>
                </div>
              </button>
              <button className="ck-radar-del" onClick={() => handleDelete(it)} title="Убрать из радара">✕</button>
            </div>
          );
        })}
      </div>

      <button className="ck-radar-add-btn" onClick={openPicker}>+ Выбрать инструменты</button>

      <InstrumentPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAdd={handleAdd}
        existing={items.map((i) => i.ticker)}
        ownTickers={ownTickers}
        strategies={strategies}
        defaultStrategyId={strategy?.id || null}
        tinkoffToken={userProfile?.tinkoffToken}
        saving={saving}
      />
    </CollapsibleSection>
  );
}

function RadarRing({ pct, hot }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  const value = pct ?? 0;
  const off = c * (1 - value / 100);
  const color = pct == null ? 'var(--text-muted)' : hot ? 'var(--gold)' : value >= 60 ? 'var(--accent-primary)' : 'var(--text-muted)';
  return (
    <div className="ck-radar-ring">
      <svg width="34" height="34">
        <circle cx="17" cy="17" r={r} fill="none" stroke="var(--bg-surface-3)" strokeWidth="3" />
        <circle
          cx="17" cy="17" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={c.toFixed(1)} strokeDashoffset={off.toFixed(1)}
          transform="rotate(-90 17 17)"
        />
      </svg>
      <span style={{ color }}>{pct ?? '—'}</span>
    </div>
  );
}
