// src/components/calculator/OrderModal.js
//
// Подтверждение заявки. Единственное окно в приложении, после которого тратятся
// настоящие деньги, поэтому оно устроено иначе, чем остальные.
//
// Порядок такой: сначала СЕРВЕР говорит, что именно уйдёт брокеру (сухой прогон — все
// проверки выполнены, но заявка не отправлена), трейдер видит его ответ, и только потом
// появляется кнопка отправки. Показывать «что будет» силами браузера было бы враньём:
// лот, точный тикер и допустимость инструмента знает сервер, а не форма.
//
// Отправка возможна только по явному нажатию. Ни авто-подтверждения, ни «отправить, если
// сигнал сильный» здесь нет и не будет — решение всегда за человеком.
import React, { useEffect, useRef, useState } from 'react';
import { placeOrder } from '../../services/broker';

const money = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString('ru-RU')} ₽`);

export default function OrderModal({ open, onClose, onPlaced, userProfile, intent }) {
  const [orderType, setOrderType] = useState('limit');
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  // Ключ идемпотентности живёт от открытия окна до отправки: двойное нажатие или повтор
  // после обрыва связи не превратятся в две заявки — брокер вернёт ту же самую.
  const requestId = useRef(null);

  useEffect(() => {
    if (!open) return;
    requestId.current = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).slice(0, 36);
    setResult(null);
    setError(null);
  }, [open]);

  // Сухой прогон при каждом изменении типа заявки: то, что видит трейдер, всегда ответ
  // сервера на ровно те параметры, которые сейчас выставлены.
  useEffect(() => {
    if (!open || !intent) return;
    let cancelled = false;
    (async () => {
      setChecking(true);
      setError(null);
      setPreview(null);
      const res = await placeOrder({
        userProfile, ...intent, orderType,
        price: orderType === 'limit' ? intent.price : null,
        requestId: requestId.current, dryRun: true,
      });
      if (cancelled) return;
      if (res.ok) setPreview(res.preview); else setError(res.error);
      setChecking(false);
    })();
    return () => { cancelled = true; };
  }, [open, intent, orderType, userProfile]);

  if (!open) return null;

  const send = async () => {
    setSending(true);
    setError(null);
    const res = await placeOrder({
      userProfile, ...intent, orderType,
      price: orderType === 'limit' ? intent.price : null,
      requestId: requestId.current,
    });
    setSending(false);
    if (res.ok) {
      setResult(res.order);
      onPlaced?.(res);
    } else {
      setError(res.error);
    }
  };

  const dirWord = intent?.direction === 'sell' ? 'Продать' : 'Купить';

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">{dirWord} через Т-Банк</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {result ? (
            <>
              <div style={{
                padding: '14px 16px', borderRadius: 'var(--radius-sm)',
                background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)',
              }}>
                <div style={{ fontWeight: 700, color: 'var(--green)', marginBottom: 6 }}>Заявка отправлена</div>
                <div className="text-sm text-secondary" style={{ lineHeight: 1.6 }}>
                  Статус: {result.status || 'принята брокером'}.
                  {result.lotsExecuted != null && <> Исполнено лотов: {result.lotsExecuted}.</>}
                  {result.executedPrice ? <> Средняя цена: {result.executedPrice}.</> : null}
                </div>
              </div>
              <div className="text-xs text-muted" style={{ lineHeight: 1.6 }}>
                Приложение не следит за судьбой заявки — если она лимитная и ещё не исполнилась,
                смотрите её в Т-Банке. Сделку в журнал заведите как обычно, когда позиция откроется.
              </div>
            </>
          ) : (
            <>
              {/* Тип заявки — тот самый выбор «лимитная или рыночная», который трейдер
                  просил оставить за собой. Лимитная стоит первой не случайно: она
                  исполнится по цене, которую он видел, или не исполнится вовсе. */}
              <div className="input-group">
                <label className="input-label">Тип заявки</label>
                <div className="flex gap-2">
                  <button
                    className={`btn btn-sm ${orderType === 'limit' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setOrderType('limit')}
                  >
                    Лимитная{intent?.price ? ` по ${intent.price}` : ''}
                  </button>
                  <button
                    className={`btn btn-sm ${orderType === 'market' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setOrderType('market')}
                  >
                    Рыночная
                  </button>
                </div>
                <div className="input-hint">
                  {orderType === 'limit'
                    ? 'Исполнится по вашей цене или не исполнится. Если рынок ушёл — заявка просто повиснет.'
                    : 'Исполнится сразу по текущей цене. При широком спреде цена может заметно отличаться от расчётной.'}
                </div>
              </div>

              {checking && <div className="text-sm text-muted">Сервер проверяет заявку…</div>}

              {preview && (
                <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface-2)' }}>
                  <div className="stat-row">
                    <span className="stat-row-label">Инструмент</span>
                    <span className="stat-row-value">{preview.ticker} · {preview.name}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-row-label">Направление</span>
                    <span className="stat-row-value">{preview.direction === 'sell' ? 'продажа' : 'покупка'}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-row-label">Количество</span>
                    <span className="stat-row-value">
                      {preview.lots} {preview.lots === 1 ? 'лот' : 'лота(ов)'}
                      {preview.lotSize > 1 && <span className="text-muted"> = {preview.units} шт.</span>}
                    </span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-row-label">Цена</span>
                    <span className="stat-row-value">{preview.price != null ? preview.price : 'по рынку'}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-row-label">Сумма (оценка)</span>
                    <span className="stat-row-value">{money(preview.estimateRub)}</span>
                  </div>
                </div>
              )}

              {error && (
                <div style={{
                  padding: '11px 14px', borderRadius: 'var(--radius-sm)',
                  background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
                  color: 'var(--red)', fontSize: 13, lineHeight: 1.6,
                }}>
                  {error}
                </div>
              )}

              <div className="text-xs text-muted" style={{ lineHeight: 1.6 }}>
                Заявка уйдёт на ваш счёт в Т-Банке. Приложение ничего не отправляет само —
                только по этому нажатию.
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          {result ? (
            <button className="btn btn-primary" onClick={onClose}>Готово</button>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
              <button
                className="btn btn-primary"
                onClick={send}
                disabled={!preview || checking || sending}
              >
                {sending ? 'Отправляю…' : `${dirWord} ${preview ? `${preview.lots} лот(а)` : ''}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
