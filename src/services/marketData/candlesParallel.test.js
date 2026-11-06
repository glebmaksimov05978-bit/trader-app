// Загрузка свечей Т-Банка окнами: окна идут по несколько сразу (быстрее на телефоне), но не больше четырёх одновременно,
// результат тот же — по порядку, без повторов на стыках окон.
let mockInFlight = 0;
let mockMaxInFlight = 0;
let mockCalls = [];

jest.mock('../tinkoff', () => ({
  moneyToFloat: (m) => Number(m?.units || 0) + Number(m?.nano || 0) / 1e9,
  TinkoffAPI: class {
    async getShareByTicker() { return { figi: 'FIGI-X' }; }
    async getFutureByTicker() { return { figi: 'FIGI-F' }; }
    async request(endpoint, body) {
      mockCalls.push(body);
      mockInFlight += 1; mockMaxInFlight = Math.max(mockMaxInFlight, mockInFlight);
      await new Promise((r) => setTimeout(r, 5));
      mockInFlight -= 1;
      // одна свеча в начале окна + общая на стыке окон (чтобы проверить повторы)
      const t = new Date(body.from).toISOString();
      const edge = new Date(body.to).toISOString();
      const mk = (time, v) => ({ time, isComplete: true, open: { units: v }, high: { units: v + 1 }, low: { units: v - 1 }, close: { units: v }, volume: 10 });
      return { candles: [mk(t, 100), mk(edge, 101)] };
    }
  },
}));

const { fetchDailyCandles } = require('./candles');

beforeEach(() => { mockInFlight = 0; mockMaxInFlight = 0; mockCalls = []; });

test('М15 по токену: 36 окон по суткам, одновременно не больше четырёх, свечи по порядку и без повторов', async () => {
  const to = new Date('2026-11-06T12:00:00Z');
  const out = await fetchDailyCandles({ ticker: 'SBER', instrumentType: 'stock', toDate: to, tinkoffToken: 'tok', timeframe: 'M15' });
  expect(mockCalls.length).toBe(36);
  expect(mockMaxInFlight).toBeGreaterThan(1);
  expect(mockMaxInFlight).toBeLessThanOrEqual(4);
  // порядок по возрастанию времени и ни одной повторной свечи на стыках окон
  const times = out.map((c) => c.date.getTime());
  expect([...times].sort((a, b) => a - b)).toEqual(times);
  expect(new Set(times).size).toBe(times.length);
  expect(out.length).toBeGreaterThan(30);
});

test('мало окон (D1) — тоже работает и не создаёт лишних запросов', async () => {
  const out = await fetchDailyCandles({ ticker: 'SBER', instrumentType: 'stock', toDate: new Date('2026-11-06T12:00:00Z'), tinkoffToken: 'tok', timeframe: 'D1' });
  expect(mockCalls.length).toBe(Math.ceil(960 / 360));
  expect(out.length).toBeGreaterThan(0);
});
