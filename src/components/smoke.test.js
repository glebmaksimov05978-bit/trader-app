// Дымовая проверка новых экранов: каждый компонент отрисовывается на реалистичных данных без
// исключений и показывает ключевые тексты. Запуск: npx react-scripts test --watchAll=false
// (полноценной проверки глазами не заменяет, но ловит обращение к несуществующим полям и т.п.).
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, userProfile: { tinkoffToken: '', taPrefs: { fibonacci: false } }, updateUserProfile: async () => {} }),
}));
jest.mock('../services/firebase', () => ({ db: {}, auth: {} }));
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(), addDoc: jest.fn(), updateDoc: jest.fn(), deleteDoc: jest.fn(), doc: jest.fn(), query: jest.fn(),
  where: jest.fn(), getDocs: jest.fn(), serverTimestamp: jest.fn(), arrayUnion: jest.fn(), orderBy: jest.fn(),
  writeBatch: jest.fn(), getDoc: jest.fn(), setDoc: jest.fn(), runTransaction: jest.fn(), onSnapshot: jest.fn(),
  initializeFirestore: jest.fn(), getFirestore: jest.fn(),
}));
jest.mock('../services/tinkoff', () => ({ TinkoffAPI: class {} , moneyToFloat: () => 0 }));

const StrategyOverview = require('./cockpit/StrategyOverview').default;
const MyStrategies = require('./capital/MyStrategies').default;
const TaSettingsCard = require('./settings/TaSettingsCard').default;
const ChartDrawingToolbar = require('./shared/ChartDrawingToolbar').default;
const PaperActions = require('./cockpit/PaperActions').default;
const EntryDecisionModal = require('./calculator/EntryDecisionModal').default;

const strategies = [
  { id: 'A', name: 'Пробой', horizon: 'short', timeframe: 'H1', followed: true, conditions: [{ id: 'rsi_below', enabled: true, param: 35 }] },
  { id: 'B', name: 'Откат', conditions: [] },
  { id: 'C', name: 'Наблюдаемая', horizon: 'long', timeframe: 'D1', followed: true, observe: true, conditions: [] },
];

describe('новые экраны', () => {
  test('Обзор: плашки с названием, подписью и горячими тикерами', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StrategyOverview
          strategies={[strategies[0], strategies[2]]}
          knownIds={strategies.map((s) => s.id)}
          groups={[{ key: 'A', label: 'Пробой', open: 2, closed: 3, pnl: 1200, winrate: 66.6, avgHoldDays: 1.5, timeframes: ['H1'] }]}
          radar={{ A: { total: 5, hot: 2, hotItems: [{ ticker: 'SBER' }, { ticker: 'GAZP' }] } }}
          pending={{ A: 1 }}
          onPick={() => {}} onOpenTicker={() => {}} onToggleObserve={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Пробой');
    expect(html).toContain('краткосрок · Ч1');
    expect(html).toContain('SBER');
    expect(html).toContain('ждут вашей отметки: 1');
    expect(html).toContain('наблюдаю'); // у «Наблюдаемой»
  });

  test('Обзор: стратегия без паспорта подсказывает, где его задать', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StrategyOverview strategies={[strategies[1]]} groups={[]} radar={{}} onPick={() => {}} />
      </MemoryRouter>,
    );
    expect(html).toContain('задайте горизонт и таймфрейм');
  });

  test('Мои стратегии: статусы и кнопки', () => {
    const html = renderToStaticMarkup(
      <MyStrategies
        strategies={strategies} activeStrategyId="A" editingId="A"
        onPersist={async () => {}} onSetActive={() => {}} onEdit={() => {}} saving={false}
      />,
    );
    expect(html).toContain('Мои стратегии');
    expect(html).toContain('в Сопровождении');
    expect(html).toContain('Добавить в Сопровождение'); // у «Откат»
    expect(html).toContain('наблюдение');
  });

  test('Настройки ТА: блоки и пример плашки без выключенных блоков', () => {
    const html = renderToStaticMarkup(
      <TaSettingsCard value={{ fibonacci: false, patterns: false }} onChange={() => {}} onSave={() => {}} saving={false} dirty />,
    );
    expect(html).toContain('Технический анализ');
    expect(html).toContain('Полосы Боллинджера');
    expect(html).not.toContain('Уровни Фибоначчи · '); // блок выключен — в примере его нет
    expect(html).toContain('показано блоков: 7 из 9');
    expect(html).not.toContain('Фигуры-кандидаты</h4>');
  });

  test('Панель рисования', () => {
    const html = renderToStaticMarkup(
      <ChartDrawingToolbar
        open tool="trend" onTool={() => {}} onToggle={() => {}} color="#6485d8" onColor={() => {}}
        magnet onMagnet={() => {}} label="" onLabel={() => {}} hasSelected={false} onDeleteSelected={() => {}}
        count={3} onClearAll={() => {}} hint="подсказка"
      />,
    );
    expect(html).toContain('Рисование · 3');
    expect(html).toContain('Трендовая линия');
    expect(html).toContain('Очистить');
  });

  test('Мои действия по бумажному сигналу', () => {
    const trade = {
      id: 'p1', ticker: 'SBER', direction: 'long', status: 'open', entryStrategyName: 'Пробой',
      decisions: [{ at: '2026-10-14T10:00:00Z', action: 'entered', via: 'broker', qty: 10 }],
    };
    const html = renderToStaticMarkup(<PaperActions trade={trade} journalTrades={[]} userProfile={{}} onDecision={() => {}} />);
    expect(html).toContain('Что вы сделали по этому сигналу');
    expect(html).toContain('Вы: вошли');
    expect(html).toContain('по данным Т-Банка');
    expect(html).toContain('Проверить по Т-Банку');
  });

  test('Окно «Почему вошли?»', () => {
    const html = renderToStaticMarkup(
      <EntryDecisionModal
        ask={{ tradeId: 't1', ticker: 'SBER', direction: 'long', papers: [{ id: 'p1', entryStrategyName: 'Пробой', entryTimeframe: 'H1' }] }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('Почему вошли?');
    expect(html).toContain('По сигналу «Пробой» (H1)');
    expect(html).toContain('Эмоции');
  });
});
