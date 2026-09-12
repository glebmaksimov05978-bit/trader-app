// src/components/settings/Settings.js
import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { availableTimeframes } from '../../services/marketData/candles';
import { TARIFF_OPTIONS, TARIFFS, DEFAULT_TARIFF, commissionRateFor } from '../../services/analytics/commission';
import { describeSchedule } from '../../services/marketData/tradingSchedule';
import toast from 'react-hot-toast';

export default function Settings() {
  const { user, userProfile, updateUserProfile } = useAuth();
  const [form, setForm] = useState({
    displayName: '',
    tinkoffToken: '',
    depositSize: '',
    maxRiskPerTrade: '',
    dailyLossLimit: '',
    askJournalExtra: true,
    preferredTimeframe: '', // '' = авто по длительности сделки
    brokerTariff: DEFAULT_TARIFF,
    // Какие сессии смотрит фоновый робот. Лежат в alertPrefs вместе с остальными
    // настройками уведомлений — именно оттуда их читает робот.
    sessionMorning: true,
    sessionMain: true,
    sessionEvening: true,
    paperIgnoreRiskSizing: false,
    paperTelegram: true,
  });
  const [saving, setSaving] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [askExtra, setAskExtra] = useState(null); // null = не загружен ещё

  useEffect(() => {
    if (userProfile) {
      setForm(f => ({
        ...f,
        displayName: userProfile.displayName || '',
        tinkoffToken: userProfile.tinkoffToken || '',
        depositSize: String(userProfile.depositSize ?? 0),
        maxRiskPerTrade: String(userProfile.maxRiskPerTrade || 1),
        dailyLossLimit: String(userProfile.dailyLossLimit || 3),
        preferredTimeframe: userProfile.preferredTimeframe || '',
        brokerTariff: userProfile.brokerTariff || DEFAULT_TARIFF,
        sessionMorning: userProfile.alertPrefs?.sessionMorning !== false,
        sessionMain: userProfile.alertPrefs?.sessionMain !== false,
        sessionEvening: userProfile.alertPrefs?.sessionEvening !== false,
        paperIgnoreRiskSizing: userProfile.alertPrefs?.paperIgnoreRiskSizing === true,
        paperTelegram: userProfile.alertPrefs?.paperTelegram !== false,
      }));
      // askExtra инициализируем только один раз
      if (askExtra === null) {
        setAskExtra(userProfile.askJournalExtra === true);
      }
    }
  }, [userProfile]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await updateUserProfile({
        displayName: form.displayName,
        tinkoffToken: form.tinkoffToken,
        depositSize: parseFloat(form.depositSize),
        maxRiskPerTrade: parseFloat(form.maxRiskPerTrade),
        dailyLossLimit: parseFloat(form.dailyLossLimit),
        askJournalExtra: askExtra === true,
        preferredTimeframe: form.preferredTimeframe || null,
        brokerTariff: form.brokerTariff,
        // Мержим, а не перезаписываем: в alertPrefs лежат ещё и настройки самих
        // уведомлений, у которых пока нет своего экрана, — перезапись стёрла бы их.
        alertPrefs: {
          ...(userProfile?.alertPrefs || {}),
          sessionMorning: form.sessionMorning,
          sessionMain: form.sessionMain,
          sessionEvening: form.sessionEvening,
          paperIgnoreRiskSizing: form.paperIgnoreRiskSizing,
          paperTelegram: form.paperTelegram,
        },
      });
      toast.success('Настройки сохранены');
    } catch (e) {
      // Swallowing the real reason here is exactly what made a past failed save (empty
      // strategy write) impossible to diagnose without a temporary console.log — always
      // surface e.message (see project-testing-conventions memory).
      toast.error('Ошибка сохранения: ' + (e.message || 'неизвестная ошибка'));
    }
    setSaving(false);
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">⚙️ Настройки</h1>
        <p className="page-subtitle">Профиль и интеграции</p>
      </div>

      <div style={{maxWidth: 600}}>
        <div className="card" style={{marginBottom:20}}>
          <div className="section-title">
            <div className="section-title-icon">👤</div>
            Профиль
            {/* Real user report: on a multi-account setup it wasn't obvious WHICH
                account's settings this page was even showing. */}
            {user?.email && (
              <span className="text-xs text-muted" style={{fontWeight:400, marginLeft:8}}>
                {user.email}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-3">
            <div className="input-group">
              <label className="input-label">Имя</label>
              <input className="input" value={form.displayName}
                onChange={e => set('displayName', e.target.value)} placeholder="Имя трейдера"/>
            </div>
            {/* Нужен, чтобы настроить OWNER_UID в воркере отправки заявок (см.
                workers/telegram-webhook/README.md) — без него владелец не мог найти
                свой uid иначе как через консоль разработчика. Не секрет: uid сам по
                себе бесполезен без пароля и Firebase-токена. */}
            {user?.uid && (
              <div className="input-group">
                <label className="input-label">
                  Ваш ID (uid)
                  <span className="text-xs text-muted" style={{fontWeight:400}}> — нужен для настройки отправки заявок</span>
                </label>
                <div style={{display:'flex', gap:8}}>
                  <input className="input" value={user.uid} readOnly style={{fontFamily:'monospace', fontSize:12}} />
                  <button
                    type="button" className="btn btn-secondary btn-sm"
                    onClick={() => { navigator.clipboard.writeText(user.uid).catch(() => {}); toast.success('Скопировано'); }}
                  >
                    Копировать
                  </button>
                </div>
              </div>
            )}
            {/* A single "Сохранить все настройки" button at the very bottom of a long
                page was easy to miss — the trader looked for a save control right next
                to the field they'd just edited and didn't find one (real user report). */}
            <button className="btn btn-secondary btn-sm" onClick={save} disabled={saving} style={{alignSelf:'flex-start'}}>
              {saving ? <><div className="spinner" style={{width:12,height:12}}/> Сохранение...</> : '💾 Сохранить имя'}
            </button>
          </div>
        </div>

        <div className="card" style={{marginBottom:20}}>
          <div className="section-title">
            <div className="section-title-icon">🔑</div>
            Т-Инвестиции API
          </div>
          <p className="text-sm text-secondary" style={{marginBottom:12}}>
            Токен используется для подгрузки цен, параметров фьючерсов и импорта сделок из Т-Инвестиций.
            Получить можно в <a href="https://www.tinkoff.ru/invest/" target="_blank" rel="noreferrer" style={{color:'var(--accent-primary)'}}>личном кабинете Т-Инвестиций</a>.
          </p>
          <div className="input-group">
            <label className="input-label">API токен</label>
            <div className="pass-wrap" style={{position:'relative'}}>
              <input
                className="input"
                // Real user report (2026-08-17): their Т-Инвестиции API-токен showed up
                // IN the real login page's password field. Root cause: this field used
                // type="password" purely for visual masking, but browsers (Chrome
                // especially) ignore autoComplete="off"/data-lpignore for password-TYPE
                // inputs specifically — they still offer to save it as a site credential,
                // and can later autofill that saved value into any OTHER password field
                // on the same origin, including the real login form. type="text" + CSS
                // masking (-webkit-text-security) gets the same visual dots without ever
                // registering as a password field, so the browser's credential manager
                // never touches it.
                type="text"
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                value={form.tinkoffToken}
                onChange={e => set('tinkoffToken', e.target.value)}
                placeholder="t.xxx..."
                style={{paddingRight:44, WebkitTextSecurity: showToken ? 'none' : 'disc', textSecurity: showToken ? 'none' : 'disc'}}
              />
              <button
                type="button"
                style={{position:'absolute',right:12,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',fontSize:16}}
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? '🙈' : '👁'}
              </button>
            </div>
            <div className="input-hint">Токен хранится в вашем профиле Firestore, не передаётся третьим лицам</div>
          </div>
        </div>

        <TariffCard tariffId={form.brokerTariff} onChange={(id) => set('brokerTariff', id)} onSave={save} saving={saving} />

        <OrderWorkerCard userProfile={userProfile} updateUserProfile={updateUserProfile} />

        {/* Часы работы фонового робота. Раньше он был жёстко прибит к 10:00-18:40 МСК и
            всю вечернюю сессию не видел вообще — а по фьючерсам это живая половина дня.
            Теперь сессии берутся из общего расписания, а трейдер решает, какие смотреть. */}
        <div className="card" style={{marginBottom:20}}>
          <div className="section-title">
            <div className="section-title-icon">⏰</div>
            Когда работает робот
          </div>
          <p className="text-sm text-secondary" style={{marginBottom:16}}>
            Робот проверяет открытые позиции в фоне и шлёт уведомления в Telegram —
            даже когда приложение закрыто. Здесь выбирается, какие сессии он смотрит.
            Утро и вечер обычно тоньше по ликвидности, и их можно выключить, чтобы
            не получать лишних сигналов.
          </p>

          <div className="flex flex-col gap-2" style={{marginBottom:16}}>
            {[
              ['sessionMorning', 'Утренняя сессия'],
              ['sessionMain', 'Основная сессия'],
              ['sessionEvening', 'Вечерняя сессия'],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2" style={{cursor:'pointer'}}>
                <input
                  type="checkbox"
                  checked={form[key] !== false}
                  onChange={e => set(key, e.target.checked)}
                />
                <span style={{fontWeight:600}}>{label}</span>
              </label>
            ))}
          </div>

          <div className="text-xs text-muted" style={{lineHeight:1.7}}>
            <div><b>Фьючерсы:</b> {describeSchedule('future')}</div>
            <div><b>Акции:</b> {describeSchedule('stock')}</div>
            <div style={{marginTop:8}}>
              С 23 марта 2026 фьючерсы торгуются без остановок на клиринг в течение дня —
              клиринг один, с 23:50 до 00:30. В эти минуты торгов нет, последняя цена
              висит старая, поэтому робот в них ничего не считает и не шлёт.
            </div>
          </div>

          <button className="btn btn-primary" style={{marginTop:16}} onClick={save} disabled={saving}>
            {saving ? 'Сохранение…' : '💾 Сохранить'}
          </button>
        </div>

        {/* Бумажные сделки ведёт робот, реальных денег они не касаются — поэтому здесь
            можно позволить то, что для настоящей торговли было бы опасно. */}
        <div className="card" style={{marginBottom:20}}>
          <div className="section-title">
            <div className="section-title-icon">📄</div>
            Бумажные сделки
          </div>
          <p className="text-sm text-secondary" style={{marginBottom:16}}>
            Виртуальные сделки, которые робот открывает сам по списку радара, чтобы было
            видно, как стратегия торгует без вашего вмешательства. Денег не тратят и в
            Журнал, депозит и отчёты не попадают.
          </p>

          <label className="flex items-center gap-2" style={{cursor:'pointer', marginBottom:12}}>
            <input
              type="checkbox"
              checked={form.paperIgnoreRiskSizing === true}
              onChange={e => set('paperIgnoreRiskSizing', e.target.checked)}
            />
            <span style={{fontWeight:600}}>Открывать даже те, на которые не хватает денег</span>
          </label>

          <label className="flex items-center gap-2" style={{cursor:'pointer', marginBottom:12}}>
            <input
              type="checkbox"
              checked={form.paperTelegram !== false}
              onChange={e => set('paperTelegram', e.target.checked)}
            />
            <span style={{fontWeight:600}}>Присылать их в Telegram</span>
          </label>

          <div className="text-xs text-muted" style={{lineHeight:1.7, marginBottom:12}}>
            Бумажные сообщения помечены значком 📄 и словом «бумажная» в первой строке —
            в общем потоке видно с одного взгляда, где реальные деньги, а где наблюдение.
            Кнопок «Снял часть» и «Закрыл целиком» у них нет: эти кнопки записывают ВАШЕ
            решение, а бумажную сделку целиком ведёт робот. Если наблюдение начнёт шуметь,
            выключите эту галочку — сигналы по настоящим позициям продолжат приходить.
          </div>

          <div className="text-xs text-muted" style={{lineHeight:1.7}}>
            Обычно робот пропускает сигнал, если по вашему проценту риска на него не
            набирается даже одного контракта — так же, как это было бы в реальной торговле.
            Из-за этого дорогие инструменты с широким стопом (например фьючерс на индекс
            при небольшом депозите) вообще никогда не появятся в наблюдении.
            <div style={{marginTop:8}}>
              С включённой галочкой такой сигнал всё равно открывается — условным объёмом в
              1 контракт, с пометкой, что реально войти в него вы бы сейчас не смогли.
              На настоящие сделки в Калькуляторе это не влияет никак: там расчёт риска
              остаётся обязательным.
            </div>
          </div>

          <button className="btn btn-primary" style={{marginTop:16}} onClick={save} disabled={saving}>
            {saving ? 'Сохранение…' : '💾 Сохранить'}
          </button>
        </div>

        <div className="card" style={{marginBottom:20}}>
          <div className="section-title">
            <div className="section-title-icon">📊</div>
            Торговые параметры
          </div>
          <div className="flex flex-col gap-3">
            <div className="input-group">
              <label className="input-label">Размер депозита (₽)</label>
              <input className="input" type="number" value={form.depositSize}
                onChange={e => set('depositSize', e.target.value)}/>
            </div>
            <div className="input-group">
              <label className="input-label">Риск на сделку (%)</label>
              <div className="input-prefix">
                <span className="input-prefix-text">%</span>
                <input className="input" type="number" step="0.1" value={form.maxRiskPerTrade}
                  onChange={e => set('maxRiskPerTrade', e.target.value)}/>
              </div>
            </div>
            <div className="input-group">
              <label className="input-label">Дневной лимит убытка (%)</label>
              <div className="input-prefix">
                <span className="input-prefix-text">%</span>
                <input className="input" type="number" step="0.5" value={form.dailyLossLimit}
                  onChange={e => set('dailyLossLimit', e.target.value)}/>
              </div>
            </div>
            <div className="input-group">
              <label className="input-label">Приоритетный таймфрейм анализа</label>
              <select className="input" value={form.preferredTimeframe} onChange={e => set('preferredTimeframe', e.target.value)}>
                <option value="">Автоматически (по длительности сделки)</option>
                {availableTimeframes(!!form.tinkoffToken).map(tf => (
                  <option key={tf.key} value={tf.key}>{tf.label}</option>
                ))}
              </select>
              <div className="input-hint">
                Технический анализ в Журнале/Радаре/Калькуляторе по умолчанию будет открываться на этом
                таймфрейме. Можно всегда переключить вручную у конкретной сделки — это только стартовый выбор.
              </div>
            </div>
          </div>
        </div>


        <div className="card" style={{marginBottom:20}}>
          <div className="section-title">
            <div className="section-title-icon">📓</div>
            Журнал сделок
          </div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 0'}}>
            <div>
              <div style={{fontSize:14,fontWeight:600,color:'var(--text-primary)'}}>Запрашивать детали при сохранении</div>
              <div style={{fontSize:12,color:'var(--text-muted)',marginTop:2}}>Эмоция, стратегия и заметки при нажатии "В журнал"</div>
            </div>
            <button
              onClick={async () => {
                const newVal = !askExtra;
                setAskExtra(newVal);
                try {
                  await updateUserProfile({ askJournalExtra: newVal });
                  toast.success(newVal ? 'Детали будут запрашиваться' : 'Детали не будут запрашиваться');
                } catch { toast.error('Ошибка сохранения'); }
              }}
              style={{
                width:48, height:26, borderRadius:13, border:'none', cursor:'pointer',
                background: askExtra ? 'var(--accent-primary)' : 'var(--bg-surface-3)',
                position:'relative', transition:'background 0.2s', flexShrink:0,
              }}
            >
              <div style={{
                width:20, height:20, borderRadius:'50%', background:'#fff',
                position:'absolute', top:3,
                left: askExtra ? 25 : 3,
                transition:'left 0.2s',
                boxShadow:'0 1px 4px rgba(0,0,0,0.3)',
              }}/>
            </button>
          </div>
        </div>

        <button className="btn btn-primary btn-lg" onClick={save} disabled={saving}>
          {saving ? <><div className="spinner" style={{width:16,height:16}}/> Сохранение...</> : '💾 Сохранить все настройки'}
        </button>
      </div>
    </div>
  );
}

// Адрес воркера, который отправляет заявки брокеру, — не сам торговый токен (тот живёт
// только на сервере, см. workers/telegram-webhook/README.md), а публичный адрес, куда
// приложение стучится. Показывает живую проверку готовности через fetchOrderConfig,
// чтобы не гадать, настроено ли всё на сервере правильно.
function OrderWorkerCard({ userProfile, updateUserProfile }) {
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cfg, setCfg] = useState(null);

  useEffect(() => {
    setUrl(userProfile?.orderWorkerUrl || '');
  }, [userProfile]);

  const check = async () => {
    setChecking(true);
    setCfg(null);
    try {
      const { fetchOrderConfig } = await import('../../services/broker');
      const res = await fetchOrderConfig({ ...userProfile, orderWorkerUrl: url });
      setCfg(res || { enabled: false, reason: 'сервер не ответил' });
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await updateUserProfile({ orderWorkerUrl: url.trim() });
      toast.success('Адрес сохранён');
    } catch (e) {
      toast.error('Ошибка сохранения: ' + (e.message || 'неизвестная ошибка'));
    }
    setSaving(false);
  };

  return (
    <div className="card" style={{marginBottom:20}}>
      <div className="section-title">
        <div className="section-title-icon">⚡</div>
        Отправка заявок брокеру
      </div>
      <p className="text-sm text-secondary" style={{marginBottom:12}}>
        Кнопка «Купить сразу» в Калькуляторе работает через ваш личный сервер (Cloudflare
        Worker) — сам торговый токен туда не попадает, он остаётся на сервере. Подробная
        инструкция по настройке: <code>workers/telegram-webhook/README.md</code> в проекте.
      </p>
      <div className="input-group">
        <label className="input-label">Адрес воркера</label>
        <input
          className="input" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://traderpro-telegram-webhook.ваш-аккаунт.workers.dev"
        />
        <div className="input-hint">Тот же адрес, что уже используется для кнопок в Telegram-уведомлениях.</div>
      </div>
      <div className="flex gap-2" style={{marginTop:8, flexWrap:'wrap'}}>
        <button className="btn btn-secondary btn-sm" onClick={save} disabled={saving || !url.trim()}>
          {saving ? 'Сохранение...' : '💾 Сохранить адрес'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={check} disabled={checking || !url.trim()}>
          {checking ? 'Проверяю...' : '🔍 Проверить готовность'}
        </button>
      </div>
      {cfg && (
        <div className="text-sm" style={{
          marginTop:12, padding:'10px 14px', borderRadius:'var(--radius-sm)',
          background: cfg.enabled ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.08)',
          border: `1px solid ${cfg.enabled ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.3)'}`,
          color: cfg.enabled ? 'var(--green)' : 'var(--gold)',
        }}>
          {cfg.enabled
            ? `Готово к работе. Разрешённые тикеры: ${cfg.whitelist?.join(', ') || '—'}${cfg.maxOrderRub ? `, потолок заявки ${cfg.maxOrderRub.toLocaleString('ru-RU')} ₽` : ''}.`
            : cfg.killSwitch
              ? 'Отправка выключена стоп-краном на сервере (TRADING_DISABLED).'
              : `Сервер отвечает, но отправка ещё не настроена: ${cfg.reason || 'не заданы торговый токен, номер счёта или белый список тикеров'}.`}
        </div>
      )}
    </div>
  );
}

// Тариф Т-Банка — единственный источник ставки комиссии для всего приложения (Калькулятор,
// Журнал, Сопровождение). Раньше в каждом из них была своя копия числа 0.0006 (0.06%),
// которое не совпадало ни с одним реальным тарифом брокера — трейдер получал в приложении
// одну прибыль, а в реальном отчёте брокера другую, и расхождение накапливалось молча.
function TariffCard({ tariffId, onChange, onSave, saving }) {
  const tariff = TARIFFS[tariffId] || TARIFFS[DEFAULT_TARIFF];
  const rows = [
    ['stock', 'Акции / облигации / ETF'],
    ['future', 'Фьючерсы'],
    ['currency', 'Валюта'],
  ];
  return (
    <div className="card" style={{marginBottom:20}}>
      <div className="section-title">
        <div className="section-title-icon">💳</div>
        Тариф Т-Банка
      </div>
      <p className="text-sm text-secondary" style={{marginBottom:12}}>
        От тарифа зависит ставка комиссии, которую приложение подставляет по умолчанию в
        Калькуляторе, Журнале и Сопровождении. Число всегда можно поправить руками в
        конкретной сделке — здесь только то, что подставляется по умолчанию.
      </p>
      <div className="input-group">
        <label className="input-label">Мой тариф</label>
        <select className="input" value={tariffId} onChange={(e) => onChange(e.target.value)}>
          {TARIFF_OPTIONS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        {tariff.monthlyFee > 0 && (
          <div className="input-hint">
            {tariff.monthlyFee} ₽/мес, бесплатно при остатке от {tariff.freeAboveBalance.toLocaleString('ru-RU')} ₽
          </div>
        )}
      </div>
      <div className="table-wrapper" style={{marginTop:8}}>
        <table className="table table-compact">
          <thead><tr><th>Инструмент</th><th style={{textAlign:'right'}}>Комиссия за сторону</th></tr></thead>
          <tbody>
            {rows.map(([type, label]) => {
              const { rate, approx, note } = commissionRateFor(tariffId, type);
              return (
                <tr key={type}>
                  <td>{label}</td>
                  <td style={{textAlign:'right'}}>
                    {(rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%
                    {approx && <span className="text-xs text-muted" title={note}> ~</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.some(([type]) => commissionRateFor(tariffId, type).approx) && (
        <div className="text-xs text-muted" style={{marginTop:8, lineHeight:1.6}}>
          ~ — ставка для этого тарифа поддержкой не подтверждена, взята ставка «Инвестора» как
          единственная известная. Если знаете точное число — впишите его вручную в конкретной
          сделке, приложение не будет его менять.
        </div>
      )}
      {tariffId === 'trader' && (
        <div className="text-xs text-muted" style={{marginTop:8, lineHeight:1.6}}>
          Комиссия за фьючерсы на «Трейдере» на самом деле считается по обороту ВСЕГО счёта
          за календарный день (до 5 млн ₽/день — 0,040%, до 10 млн ₽/день — 0,03%, дальше
          ниже) — приложение считает комиссию каждой сделки отдельно и не видит суммарный
          дневной оборот по всем инструментам, поэтому всегда берёт первую ступень. При
          обороте до 5 млн ₽/день это точное число; при бОльшем — реальная комиссия ниже
          показанной, то есть приложение немного завышает расход, а не занижает.
        </div>
      )}
      <button className="btn btn-secondary btn-sm" style={{marginTop:12}} onClick={onSave} disabled={saving}>
        {saving ? 'Сохранение...' : '💾 Сохранить тариф'}
      </button>
    </div>
  );
}
