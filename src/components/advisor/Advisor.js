// src/components/advisor/Advisor.js
import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, calcStats } from '../../services/trades';
import toast from 'react-hot-toast';
import './Advisor.css';

const MODES = [
  { id: 'journal', icon: '📊', label: 'Анализ журнала', desc: 'Паттерны ошибок и слабые места' },
  { id: 'chart', icon: '📈', label: 'Анализ графика', desc: 'Загрузи скриншот — AI разберёт' },
  { id: 'trade', icon: '🔍', label: 'Разбор сделки', desc: 'Детальный анализ конкретной позиции' },
  { id: 'psychology', icon: '🧠', label: 'Психологический коуч', desc: 'Работа с эмоциями и дисциплиной' },
  { id: 'chat', icon: '💬', label: 'Свободный вопрос', desc: 'Любой вопрос по трейдингу' },
];

export default function Advisor() {
  const { user, userProfile } = useAuth();
  const [mode, setMode] = useState('journal');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [selectedTrade, setSelectedTrade] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [chartQuestion, setChartQuestion] = useState('Проведи технический анализ этого графика. Определи тренд, ключевые уровни поддержки и сопротивления, паттерны, и скажи стоит ли входить в сделку.');
  const chatEndRef = useRef(null);
  const fileInputRef = useRef(null);

  // Receive question from calculator
  useEffect(() => {
    const q = sessionStorage.getItem('advisorQuestion');
    if (q) {
      sessionStorage.removeItem('advisorQuestion');
      setMode('chat');
      setTimeout(() => sendMessage(q), 300);
    }
  // eslint-disable-next-line
  }, []);

  useEffect(() => {
    if (!user) return;
    getUserTrades(user.uid).then(t => {
      setTrades(t);
      setStats(calcStats(t));
    });
  }, [user]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const buildSystemPrompt = () => {
    const profile = `Трейдер: ${userProfile?.displayName || 'Аноним'}, депозит: ${userProfile?.depositSize || 100000} ₽, риск/сделку: ${userProfile?.maxRiskPerTrade || 1}%`;
    const statsText = stats ? `
Статистика: ${stats.total} сделок, винрейт ${stats.winrate.toFixed(1)}%, profit factor ${stats.profitFactor.toFixed(2)},
матожидание ${stats.expectancy.toFixed(0)} ₽, макс. просадка ${stats.maxDrawdown.toFixed(0)} ₽,
макс. серия убытков ${stats.maxLossStreak}.` : 'Статистики пока нет.';

    const recentTrades = trades.slice(0, 20).map(t => {
      const d = t.date?.seconds ? new Date(t.date.seconds * 1000).toLocaleDateString('ru-RU') : t.date || '';
      return `${d} ${t.ticker} ${t.direction} вход:${t.entryPrice} выход:${t.exitPrice||'—'} P&L:${t.pnl||'—'} ₽ ${t.emotion||''} ${t.setup||''} ${t.notes||''}`;
    }).join('\n');

    return `Ты — профессиональный торговый советник и технический аналитик для трейдера на российском рынке фьючерсов MOEX.
${profile}
${statsText}

Последние сделки:
${recentTrades || 'Нет данных'}

Отвечай на русском языке. Будь конкретным. Используй данные из журнала. Давай практичные советы.
При анализе графиков: определяй тренд, уровни, паттерны свечей, дивергенции, объёмы если видны.
Используй markdown для форматирования.`;
  };

  // Convert image file to base64
  const imageToBase64 = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve({ base64, mediaType: file.type });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleImageSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Выберите изображение');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Файл слишком большой. Максимум 5MB');
      return;
    }
    setSelectedImage(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const removeImage = () => {
    setSelectedImage(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const sendMessage = async (messageText, imageFile) => {
    const text = messageText || input;
    if (!text.trim() && !imageFile && !selectedImage) return;
    if (loading) return;

    let userContent;

    // Build message content with optional image
    if (imageFile || selectedImage) {
      const file = imageFile || selectedImage;
      try {
        const { base64, mediaType } = await imageToBase64(file);
        userContent = [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          { type: 'text', text: text || chartQuestion }
        ];
      } catch {
        toast.error('Ошибка загрузки изображения');
        return;
      }
    } else {
      userContent = text;
    }

    const userMsg = { role: 'user', content: userContent };
    const displayMsg = {
      role: 'user',
      content: text || chartQuestion,
      hasImage: !!(imageFile || selectedImage),
      imagePreview: imagePreview
    };

    const newMessages = [...messages, userMsg];
    setMessages(m => [...m, displayMsg]);
    setInput('');
    removeImage();
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
      if (data.error) throw new Error(data.error);
      const assistantMsg = { role: 'assistant', content: data.content };
      setMessages(m => [...m, assistantMsg]);
    } catch (err) {
      toast.error('Ошибка AI советника. Проверьте API ключ в настройках Vercel.');
      setMessages(m => m.slice(0, -1));
    } finally {
      setLoading(false);
    }
  };

  const getInitialMessage = () => {
    switch (mode) {
      case 'journal': return `Проанализируй мой журнал сделок. Найди паттерны ошибок, слабые места и дай конкретные рекомендации.`;
      case 'psychology': return `Проанализируй мои эмоциональные состояния во время торговли. Есть ли корреляция между эмоциями и результатами?`;
      case 'trade':
        const t = trades.find(t => t.id === selectedTrade);
        if (!t) return '';
        return `Разбери эту сделку: ${t.ticker} ${t.direction} вход ${t.entryPrice}, выход ${t.exitPrice}, P&L ${t.pnl} ₽. Заметки: ${t.notes || 'нет'}.`;
      default: return input;
    }
  };

  const startAnalysis = () => {
    if (mode === 'chart') {
      if (!selectedImage) {
        toast.error('Загрузите скриншот графика');
        return;
      }
      sendMessage(chartQuestion, selectedImage);
      return;
    }
    const msg = getInitialMessage();
    if (!msg) { toast.error('Выберите сделку для разбора'); return; }
    setMessages([]);
    setTimeout(() => sendMessage(msg), 100);
  };

  const renderMarkdown = (text) => {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/^### (.*$)/gm, '<h3 style="font-size:14px;font-weight:700;margin:10px 0 4px">$1</h3>')
      .replace(/^## (.*$)/gm, '<h2 style="font-size:15px;font-weight:700;margin:12px 0 6px">$1</h2>')
      .replace(/^- (.*$)/gm, '<li>$1</li>')
      .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul style="padding-left:16px;margin:6px 0">$1</ul>')
      .split('\n\n').join('<br/><br/>');
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">🤖 AI Советник</h1>
        <p className="page-subtitle">Анализ торговли и графиков с помощью искусственного интеллекта</p>
      </div>

      <div className="advisor-layout">
        {/* Sidebar */}
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
                  onClick={() => { setMode(m.id); setMessages([]); removeImage(); }}
                >
                  <span className="advisor-mode-icon">{m.icon}</span>
                  <div>
                    <div className="advisor-mode-label">{m.label}</div>
                    <div className="advisor-mode-desc">{m.desc}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* Chart mode controls */}
            {mode === 'chart' && (
              <div style={{marginTop:16}}>
                <div className="input-group" style={{marginBottom:10}}>
                  <label className="input-label">Вопрос к AI</label>
                  <textarea
                    className="input"
                    rows={3}
                    value={chartQuestion}
                    onChange={e => setChartQuestion(e.target.value)}
                    style={{resize:'vertical', fontSize:12}}
                  />
                </div>

                {/* Image upload area */}
                {imagePreview ? (
                  <div style={{position:'relative', marginBottom:10}}>
                    <img
                      src={imagePreview}
                      alt="График"
                      style={{width:'100%', borderRadius:12, border:'1px solid var(--border-medium)'}}
                    />
                    <button
                      onClick={removeImage}
                      style={{
                        position:'absolute', top:8, right:8,
                        background:'rgba(0,0,0,0.7)', border:'none',
                        borderRadius:'50%', width:28, height:28,
                        color:'#fff', cursor:'pointer', fontSize:14,
                        display:'flex', alignItems:'center', justifyContent:'center'
                      }}
                    >✕</button>
                  </div>
                ) : (
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                      border:'2px dashed var(--border-medium)',
                      borderRadius:12, padding:'20px',
                      textAlign:'center', cursor:'pointer',
                      marginBottom:10,
                      transition:'all 0.2s'
                    }}
                    onMouseOver={e => e.currentTarget.style.borderColor='var(--accent-primary)'}
                    onMouseOut={e => e.currentTarget.style.borderColor='var(--border-medium)'}
                  >
                    <div style={{fontSize:28, marginBottom:6}}>📸</div>
                    <div style={{fontSize:12, color:'var(--text-secondary)', fontWeight:500}}>
                      Загрузить скриншот графика
                    </div>
                    <div style={{fontSize:11, color:'var(--text-muted)', marginTop:2}}>
                      PNG, JPG до 5MB
                    </div>
                  </div>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{display:'none'}}
                  onChange={handleImageSelect}
                />
              </div>
            )}

            {/* Trade selector */}
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
                disabled={loading || (mode === 'trade' && !selectedTrade) || (mode === 'chart' && !selectedImage)}
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

        {/* Chat */}
        <div className="advisor-chat">
          <div className="card advisor-messages-card">
            <div className="advisor-messages">
              {messages.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">
                    {mode === 'chart' ? '📈' : '🤖'}
                  </div>
                  <div className="empty-state-title">
                    {mode === 'chart' ? 'Загрузите скриншот графика' : 'AI Советник готов'}
                  </div>
                  <div className="empty-state-text">
                    {mode === 'chart'
                      ? 'Сделайте скриншот графика из TradingView или Тинькофф и загрузите — AI проведёт технический анализ'
                      : mode === 'chat'
                      ? 'Задайте вопрос по трейдингу'
                      : 'Нажмите «Запустить анализ»'}
                  </div>
                </div>
              ) : (
                messages.map((msg, i) => (
                  <div key={i} className={`advisor-message ${msg.role}`}>
                    <div className="advisor-message-avatar">
                      {msg.role === 'user' ? (userProfile?.displayName || 'Вы')[0] : '🤖'}
                    </div>
                    <div className="advisor-message-bubble">
                      {/* Show image preview if message had image */}
                      {msg.hasImage && msg.imagePreview && (
                        <img
                          src={msg.imagePreview}
                          alt="График"
                          style={{width:'100%', borderRadius:8, marginBottom:8, maxHeight:200, objectFit:'cover'}}
                        />
                      )}
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

            {/* Input row with image attach */}
            <div className="advisor-input-row">
              {/* Image attach button */}
              <button
                className="btn btn-ghost"
                style={{padding:'10px 12px', borderRadius:12, flexShrink:0}}
                onClick={() => fileInputRef.current?.click()}
                title="Прикрепить скриншот графика"
              >
                📎
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{display:'none'}}
                onChange={handleImageSelect}
              />
              <div style={{flex:1, position:'relative'}}>
                {imagePreview && (
                  <div style={{
                    position:'absolute', bottom:'calc(100% + 4px)', left:0,
                    display:'flex', alignItems:'center', gap:8,
                    background:'var(--bg-surface-2)', borderRadius:8,
                    padding:'6px 10px', border:'1px solid var(--border-subtle)'
                  }}>
                    <img src={imagePreview} alt="" style={{width:32, height:32, borderRadius:4, objectFit:'cover'}}/>
                    <span style={{fontSize:12, color:'var(--text-secondary)'}}>График прикреплён</span>
                    <button onClick={removeImage} style={{background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', fontSize:14}}>✕</button>
                  </div>
                )}
                <input
                  className="input"
                  style={{borderRadius:12}}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
                  placeholder={imagePreview ? 'Задайте вопрос по графику...' : 'Спросите что-нибудь...'}
                  disabled={loading}
                />
              </div>
              <button
                className="btn btn-primary"
                onClick={() => sendMessage()}
                disabled={loading || (!input.trim() && !selectedImage)}
                style={{borderRadius:12, padding:'10px 16px', flexShrink:0}}
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
