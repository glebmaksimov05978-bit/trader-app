// src/components/advisor/Advisor.js
import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, calcStats } from '../../services/trades';
import toast from 'react-hot-toast';
import './Advisor.css';

const MODES = [
  { id: 'journal',    icon: '📊', label: 'Анализ журнала',     desc: 'Паттерны ошибок и слабые места' },
  { id: 'calculator', icon: '🧮', label: 'Из калькулятора',    desc: 'Разбор сделки из калькулятора' },
  { id: 'trade',      icon: '🔍', label: 'Разбор сделки',      desc: 'Детальный анализ конкретной позиции' },
  { id: 'psychology', icon: '🧠', label: 'Психологический коуч', desc: 'Работа с эмоциями и дисциплиной' },
  { id: 'chat',       icon: '💬', label: 'Свободный вопрос',   desc: 'Любой вопрос по трейдингу' },
];

export default function Advisor() {
  const { user, userProfile, isPro } = useAuth();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState('journal');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [selectedTrade, setSelectedTrade] = useState('');
  const [calcData, setCalcData] = useState(null);
  const chatEndRef = useRef(null);

  useEffect(() => {
    if (!user) return;
    getUserTrades(user.uid).then(t => {
      setTrades(t);
      setStats(calcStats(t));
    });
  }, [user]);

  // Загружаем данные из калькулятора если пришли оттуда
  useEffect(() => {
    if (searchParams.get('from') === 'calculator') {
      const data = {
        ticker:     searchParams.get('ticker')     || '',
        name:       searchParams.get('name')       || '',
        direction:  searchParams.get('direction')  || '',
        entry:      searchParams.get('entry')      || '',
        sl:         searchParams.get('sl')         || '',
        tp:         searchParams.get('tp')         || '',
        contracts:  searchParams.get('contracts')  || '',
        rr:         searchParams.get('rr')         || '',
        riskAmount: searchParams.get('riskAmount') || '',
        totalLoss:  searchParams.get('totalLoss')  || '',
        totalProfit:searchParams.get('totalProfit')|| '',
        commission: searchParams.get('commission') || '',
        breakeven:  searchParams.get('breakeven')  || '',
        deposit:    searchParams.get('deposit')    || '',
        type:       searchParams.get('type')       || 'future',
      };
      setCalcData(data);
      setMode('calculator');
    }
  }, [searchParams]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const buildSystemPrompt = () => {
    const profile = `Трейдер: ${userProfile?.displayName || 'Аноним'}, депозит: ${userProfile?.depositSize || 100000} ₽, риск/сделку: ${userProfile?.maxRiskPerTrade || 1}%`;
    const statsText = stats ? `
Статистика: ${stats.total} сделок, винрейт ${stats.winrate.toFixed(1)}%, profit factor ${stats.profitFactor.toFixed(2)},
матожидание ${stats.expectancy.toFixed(0)} ₽, макс. просадка ${stats.maxDrawdown.toFixed(0)} ₽,
макс. серия убытков ${stats.maxLossStreak}, средний профит ${stats.avgWin.toFixed(0)} ₽, средний убыток ${stats.avgLoss.toFixed(0)} ₽.` : 'Статистики пока нет.';

    const recentTrades = trades.slice(0, 20).map(t => {
      const d = t.date?.seconds ? new Date(t.date.seconds * 1000).toLocaleDateString('ru-RU') : t.date || '';
      return `${d} ${t.ticker} ${t.direction} вход:${t.entryPrice} выход:${t.exitPrice||'—'} P&L:${t.pnl||'—'} ₽ ${t.emotion||''} ${t.setup||''} ${t.notes||''}`;
    }).join('\n');

    let calcContext = '';
    if (mode === 'calculator' && calcData) {
      const dir = calcData.direction === 'long' ? 'Лонг' : 'Шорт';
      const isFuture = calcData.type === 'future';
      calcContext = `\n\nДАННЫЕ ИЗ КАЛЬКУЛЯТОРА (сделка которую хочет открыть трейдер):\n` +
        `Инструмент: ${calcData.ticker}${calcData.name ? ' (' + calcData.name + ')' : ''}\n` +
        `Тип: ${isFuture ? 'Фьючерс' : 'Акция'}\n` +
        `Направление: ${dir}\n` +
        `Цена входа: ${calcData.entry}\n` +
        `Стоп-лосс: ${calcData.sl}\n` +
        `Тейк-профит: ${calcData.tp || 'не указан'}\n` +
        `Контрактов: ${calcData.contracts}\n` +
        `Risk/Reward: 1:${calcData.rr}\n` +
        `Риск на сделку: ${calcData.riskAmount} ₽ (из депозита ${calcData.deposit} ₽)\n` +
        `Макс. убыток с комиссией: ${calcData.totalLoss} ₽\n` +
        `Потенц. прибыль с комиссией: ${calcData.totalProfit} ₽\n` +
        `Комиссия: ${calcData.commission} ₽\n` +
        `Точка безубытка: ${calcData.breakeven}`;
    }

    return `Ты — профессиональный торговый советник и психологический коуч для трейдера на российском рынке фьючерсов (MOEX).
${profile}
${statsText}

Последние сделки:
${recentTrades || 'Нет данных'}${calcContext}

Отвечай на русском языке. Будь конкретным, используй данные из журнала. Давай практичные советы.
Используй markdown для форматирования. Будь честным, даже если нужно указать на ошибки.`;
  };

  const getInitialMessage = () => {
    switch (mode) {
      case 'journal':
        return `Проанализируй мой журнал сделок. Найди паттерны ошибок, слабые места и дай конкретные рекомендации по улучшению.`;
      case 'psychology':
        return `Проанализируй мои эмоциональные состояния во время торговли. Есть ли корреляция между эмоциями и результатами? Как мне улучшить психологическую устойчивость?`;
      case 'trade':
        const t = trades.find(t => t.id === selectedTrade);
        if (!t) return '';
        return `Разбери эту сделку подробно: ${t.ticker} ${t.direction} ${t.date}, вход ${t.entryPrice}, выход ${t.exitPrice}, P&L ${t.pnl} ₽. Заметки: ${t.notes || 'нет'}. Что было сделано правильно и неправильно?`;
      default:
        return input;
    }
  };

  const sendMessage = async (messageText) => {
    const text = messageText || input;
    if (!text.trim() || loading) return;

    const userMsg = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          systemPrompt: buildSystemPrompt(),
        }),
      });

      if (!response.ok) throw new Error('API error');
      const data = await response.json();
      const assistantMsg = { role: 'assistant', content: data.content };
      setMessages(m => [...m, assistantMsg]);
    } catch (err) {
      toast.error('Ошибка AI советника. Проверьте настройки API.');
      setMessages(m => m.slice(0, -1));
    } finally {
      setLoading(false);
    }
  };

  const startAnalysis = () => {
    const msg = getInitialMessage();
    if (!msg) {
      toast.error('Выберите сделку для разбора');
      return;
    }
    setMessages([]);
    setTimeout(() => sendMessage(msg), 100);
  };

  const renderMarkdown = (text) => {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/^### (.*$)/gm, '<h3>$1</h3>')
      .replace(/^## (.*$)/gm, '<h2>$1</h2>')
      .replace(/^# (.*$)/gm, '<h1>$1</h1>')
      .replace(/^- (.*$)/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<[h|u|l])/gm, '')
      .split('\n').join('<br/>');
  };

  // Полный заблокированный экран для free пользователей
  if (!isPro) {
    return (
      <div className="page" style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'70vh'}}>
        <div style={{
          maxWidth:460, width:'100%', textAlign:'center',
          padding:'40px 32px',
          background:'linear-gradient(145deg,#0f1829,#131d35)',
          border:'1px solid rgba(255,255,255,0.08)',
          borderRadius:28,
          boxShadow:'0 40px 80px rgba(0,0,0,0.4)',
        }}>
          <div style={{fontSize:56, marginBottom:12, filter:'drop-shadow(0 0 20px rgba(79,70,229,0.4))'}}>🤖</div>
          <div style={{
            display:'inline-flex', alignItems:'center', gap:6,
            background:'linear-gradient(135deg,rgba(245,158,11,0.15),rgba(251,191,36,0.1))',
            border:'1px solid rgba(245,158,11,0.3)',
            borderRadius:20, padding:'5px 14px', marginBottom:14,
          }}>
            <span>⭐</span>
            <span style={{fontSize:11,fontWeight:700,color:'#fbbf24',letterSpacing:'0.5px'}}>ТОЛЬКО ДЛЯ PRO</span>
          </div>
          <h2 style={{fontFamily:"'Syne',sans-serif",fontSize:26,fontWeight:800,color:'#f0f4ff',margin:'0 0 8px'}}>AI Советник</h2>
          <p style={{fontSize:13,color:'rgba(255,255,255,0.4)',lineHeight:1.7,marginBottom:24}}>
            Персональный торговый коуч анализирует твой журнал,<br/>находит паттерны ошибок и помогает расти
          </p>
          <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:24,textAlign:'left',background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.06)',borderRadius:14,padding:'14px 18px'}}>
            {[['📊','Анализ журнала','Паттерны ошибок и слабые места'],['🧠','Психологический коуч','Эмоции и дисциплина'],['🔍','Разбор сделки','Детальный анализ позиции'],['📈','Анализ графиков','Загрузи скриншот — AI разберёт'],['💬','Свободный вопрос','Любой вопрос по трейдингу']].map(([icon,title,desc]) => (
              <div key={title} style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={{fontSize:16,flexShrink:0}}>{icon}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:600,color:'#f0f4ff'}}>{title}</div>
                  <div style={{fontSize:11,color:'rgba(255,255,255,0.3)'}}>{desc}</div>
                </div>
                <span style={{width:14,height:14,borderRadius:'50%',background:'linear-gradient(135deg,#10b981,#059669)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:8,color:'#fff',flexShrink:0}}>✓</span>
              </div>
            ))}
          </div>
          <div style={{background:'rgba(79,70,229,0.08)',border:'1px solid rgba(79,70,229,0.2)',borderRadius:14,padding:'14px',marginBottom:14}}>
            <div style={{display:'flex',alignItems:'baseline',justifyContent:'center',gap:4,marginBottom:2}}>
              <span style={{fontSize:34,fontWeight:800,color:'#f0f4ff',fontFamily:"'Syne',sans-serif"}}>299</span>
              <span style={{fontSize:16,color:'rgba(255,255,255,0.5)'}}>₽</span>
              <span style={{fontSize:12,color:'rgba(255,255,255,0.3)',marginLeft:4}}>/месяц</span>
            </div>
            <div style={{fontSize:11,color:'rgba(255,255,255,0.3)'}}>или <strong style={{color:'rgba(255,255,255,0.5)'}}>2 490 ₽</strong> / год — экономия 40%</div>
          </div>
          <button style={{width:'100%',padding:14,border:'none',borderRadius:14,background:'linear-gradient(135deg,#4f46e5,#7c3aed)',color:'#fff',fontFamily:"'DM Sans',sans-serif",fontSize:14,fontWeight:700,cursor:'pointer',boxShadow:'0 8px 24px rgba(79,70,229,0.4)'}}
            onClick={() => alert('Оплата скоро будет доступна!')}>
            ⚡ Перейти на Pro — 299 ₽/мес
          </button>
          <p style={{fontSize:11,color:'rgba(255,255,255,0.2)',marginTop:8}}>Отмена в любой момент · Безопасная оплата</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">🤖 AI Советник</h1>
        <p className="page-subtitle">Анализ торговли с помощью искусственного интеллекта</p>
      </div>

      <div className="advisor-layout">
        {/* Left: mode selector */}
        <div className="advisor-sidebar">
          <div className="card">
            <div className="section-title">
              <div className="section-title-icon">🎯</div>
              Режим
            </div>
            <div className="flex flex-col gap-2">
              {MODES.map(m => (
                <button
                  key={m.id}
                  className={`advisor-mode-btn ${mode === m.id ? 'active' : ''}`}
                  onClick={() => { setMode(m.id); setMessages([]); }}
                >
                  <span className="advisor-mode-icon">{m.icon}</span>
                  <div>
                    <div className="advisor-mode-label">{m.label}</div>
                    <div className="advisor-mode-desc">{m.desc}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* Trade selector for 'trade' mode */}
            {mode === 'trade' && (
              <div className="input-group" style={{marginTop:16}}>
                <label className="input-label">Выберите сделку</label>
                <select className="input" value={selectedTrade} onChange={e => setSelectedTrade(e.target.value)}>
                  <option value="">— выберите —</option>
                  {trades.slice(0, 50).map(t => {
                    const d = t.date?.seconds ? new Date(t.date.seconds * 1000).toLocaleDateString('ru-RU') : t.date || '';
                    return (
                      <option key={t.id} value={t.id}>
                        {d} {t.ticker} {t.direction} {t.pnl !== null ? (t.pnl >= 0 ? '+' : '') + Math.round(t.pnl) + '₽' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {mode !== 'chat' && (
              <button
                className="btn btn-primary w-full"
                style={{marginTop:16}}
                onClick={startAnalysis}
                disabled={loading || (mode === 'trade' && !selectedTrade)}
              >
                {loading ? <><div className="spinner" style={{width:14,height:14}}/> Анализирую...</> : '▶ Запустить анализ'}
              </button>
            )}

            {/* Stats mini */}
            {stats && (
              <div style={{marginTop:16, padding:'12px', background:'var(--bg-surface-2)', borderRadius:'12px'}}>
                <div className="text-xs text-muted" style={{marginBottom:8}}>Данные для анализа:</div>
                <div className="stat-row" style={{padding:'4px 0'}}><span className="text-xs text-secondary">Сделок</span><span className="text-xs font-semibold">{stats.total}</span></div>
                <div className="stat-row" style={{padding:'4px 0'}}><span className="text-xs text-secondary">Винрейт</span><span className="text-xs font-semibold">{stats.winrate.toFixed(1)}%</span></div>
                <div className="stat-row" style={{padding:'4px 0'}}><span className="text-xs text-secondary">PF</span><span className="text-xs font-semibold">{stats.profitFactor.toFixed(2)}</span></div>
              </div>
            )}
          </div>
        </div>

        {/* Chat area */}
        <div className="advisor-chat">
        {/* Карточка с данными из калькулятора */}
        {mode === 'calculator' && calcData && (
          <div style={{
            margin:'16px 16px 0',
            padding:'14px 18px',
            background:'rgba(79,70,229,0.08)',
            border:'1px solid rgba(79,70,229,0.25)',
            borderRadius:16,
          }}>
            <div style={{fontSize:12, color:'var(--accent-primary)', fontWeight:700, marginBottom:10, letterSpacing:'0.5px'}}>
              🧮 ДАННЫЕ ИЗ КАЛЬКУЛЯТОРА
            </div>
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px 20px', fontSize:13}}>
              {[
                ['Инструмент', calcData.ticker + (calcData.name ? ` (${calcData.name})` : '')],
                ['Направление', calcData.direction === 'long' ? '📈 Лонг' : '📉 Шорт'],
                ['Цена входа', calcData.entry],
                ['Стоп-лосс', calcData.sl],
                ['Тейк-профит', calcData.tp || '—'],
                ['Контрактов', calcData.contracts],
                ['Risk/Reward', `1:${calcData.rr}`],
                ['Риск', `${calcData.riskAmount} ₽`],
                ['Макс. убыток', `${calcData.totalLoss} ₽`],
                ['Потенц. прибыль', `${calcData.totalProfit} ₽`],
              ].map(([label, value]) => (
                <div key={label} style={{display:'flex', justifyContent:'space-between', gap:8}}>
                  <span style={{color:'var(--text-muted)'}}>{label}</span>
                  <span style={{fontWeight:600, color:'var(--text-primary)'}}>{value}</span>
                </div>
              ))}
            </div>
          </div>
        )}
          <div className="card advisor-messages-card">
            <div className="advisor-messages" ref={el => { if (el) el.scrollTop = el.scrollHeight; }}>
              {messages.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">🤖</div>
                  <div className="empty-state-title">AI Советник готов</div>
                  <div className="empty-state-text">
                    {mode === 'chat'
                      ? 'Задайте вопрос по трейдингу'
                      : 'Нажмите «Запустить анализ», чтобы получить персональные рекомендации'}
                  </div>
                </div>
              ) : (
                messages.map((msg, i) => (
                  <div key={i} className={`advisor-message ${msg.role}`}>
                    <div className="advisor-message-avatar">
                      {msg.role === 'user' ? (userProfile?.displayName || 'Вы')[0] : '🤖'}
                    </div>
                    <div className="advisor-message-bubble">
                      {msg.role === 'assistant' ? (
                        <div
                          className="advisor-message-content"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                        />
                      ) : (
                        <div className="advisor-message-content">{msg.content}</div>
                      )}
                    </div>
                  </div>
                ))
              )}
              {loading && (
                <div className="advisor-message assistant">
                  <div className="advisor-message-avatar">🤖</div>
                  <div className="advisor-message-bubble">
                    <div className="advisor-typing">
                      <div className="loading-dot" />
                      <div className="loading-dot" />
                      <div className="loading-dot" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="advisor-input-row">
              <input
                className="input"
                style={{flex:1, borderRadius:'12px'}}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
                placeholder={mode === 'chat' ? 'Спросите что-нибудь...' : 'Дополните или задайте вопрос...'}
                disabled={loading}
              />
              <button
                className="btn btn-primary"
                onClick={() => sendMessage()}
                disabled={loading || !input.trim()}
                style={{borderRadius:12, padding:'10px 16px'}}
              >
                ➤
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
