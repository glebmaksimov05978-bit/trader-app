# TraderPro — Приложение для трейдера

Полнофункциональное приложение для управления торговлей на российском рынке фьючерсов (MOEX).

## Стек
- **Frontend**: React 18, React Router v6, Recharts
- **Backend**: Firebase Firestore + Firebase Auth
- **AI**: Claude API через Vercel Serverless Function
- **Интеграция**: Tinkoff Invest API v2
- **Деплой**: Vercel

---

## Разделы приложения

### 🧮 Калькулятор сделки
- Ввод тикера, цены входа, стоп-лосса, тейк-профита
- Авторасчёт контрактов, ГО, комиссии, R/R, точки безубытка
- Загрузка цены и параметров через Tinkoff Invest API

### 📓 Журнал сделок
- Добавление сделок вручную (тикер, дата, направление, вход/выход, объём, P&L)
- Фильтрация по направлению и статусу
- Статистика: винрейт, profit factor, матожидание, серии

### 💰 Управление капиталом
- Настройка депозита, дневного лимита убытка, просадки
- Визуальные индикаторы использования лимитов
- Калькулятор максимального количества контрактов

### 🤖 AI Советник
- Анализ журнала сделок (паттерны ошибок)
- Психологический коуч
- Разбор конкретной сделки
- Свободный чат по трейдингу

### ⚙️ Админ-панель
- Создание пользователей
- Управление ролями

---

## Быстрый старт

### 1. Клонирование и установка зависимостей

```bash
git clone <your-repo>
cd trader-app
npm install
```

### 2. Firebase

1. Создайте проект на [console.firebase.google.com](https://console.firebase.google.com)
2. Включите **Authentication** → Email/Password
3. Создайте базу **Firestore** (режим production)
4. В настройках проекта → Веб-приложение → скопируйте конфиг
5. Задеплойте правила безопасности:

```bash
npm install -g firebase-tools
firebase login
firebase init firestore
firebase deploy --only firestore:rules,firestore:indexes
```

### 3. Переменные окружения

Скопируйте `.env.example` → `.env.local`:

```bash
cp .env.example .env.local
```

Заполните значениями из Firebase Console.

### 4. Создание первого пользователя-администратора

В Firebase Console → Authentication → Add user вручную, затем в Firestore добавьте документ:

```
Collection: users
Document ID: <uid пользователя>
Fields:
  uid: "<uid>"
  email: "admin@example.com"
  displayName: "Администратор"
  role: "admin"
  depositSize: 100000
  dailyLossLimit: 3
  maxRiskPerTrade: 1
```

### 5. Запуск локально

```bash
npm start
```

---

## Деплой на Vercel

### 1. Установка Vercel CLI

```bash
npm install -g vercel
vercel login
```

### 2. Деплой

```bash
vercel --prod
```

### 3. Переменные окружения в Vercel

В Vercel Dashboard → Settings → Environment Variables добавьте:

```
REACT_APP_FIREBASE_API_KEY
REACT_APP_FIREBASE_AUTH_DOMAIN
REACT_APP_FIREBASE_PROJECT_ID
REACT_APP_FIREBASE_STORAGE_BUCKET
REACT_APP_FIREBASE_MESSAGING_SENDER_ID
REACT_APP_FIREBASE_APP_ID
ANTHROPIC_API_KEY
```

---

## Tinkoff Invest API

1. Войдите в [Т-Инвестиции](https://www.tinkoff.ru/invest/)
2. Настройки → API → Создать токен (Full Access)
3. Вставьте токен в приложении: Настройки → API токен

Поддерживаемые операции:
- Поиск фьючерсов по тикеру
- Загрузка последней цены
- Получение параметров контракта (шаг цены, ГО, лот)

---

## Структура файлов

```
src/
├── components/
│   ├── layout/         # Sidebar, MobileNav, AppLayout
│   ├── auth/           # LoginPage
│   ├── dashboard/      # Dashboard с графиками
│   ├── calculator/     # Калькулятор сделки
│   ├── journal/        # Журнал + TradeModal
│   ├── capital/        # Управление капиталом
│   ├── advisor/        # AI Советник
│   ├── settings/       # Настройки профиля
│   └── admin/          # Админ-панель
├── context/
│   ├── AuthContext.js  # Firebase Auth + профиль
│   └── ThemeContext.js # Тёмная/светлая тема
├── services/
│   ├── firebase.js     # Инициализация Firebase
│   ├── tinkoff.js      # Tinkoff Invest API
│   └── trades.js       # CRUD сделок + статистика
├── utils/
│   └── calculator.js   # Логика расчёта позиции
└── styles/
    └── globals.css     # Вся дизайн-система
api/
└── advisor.js          # Vercel Edge Function → Claude API
```

---

## Git workflow

```bash
# После скачивания файлов:
cd /path/to/your/project
cp -r /path/to/downloaded/src ./src
git add .
git commit -m "feat: add trader pro application"
git push
# Vercel автоматически задеплоит
```

---

## Кастомизация

### Изменение темы
Все цвета в `src/styles/globals.css` → `:root` и `[data-theme="light"]`

### Комиссия по умолчанию
В `src/utils/calculator.js` → `commissionRate: 0.0006`

### Добавление нового раздела
1. Создайте `src/components/mypage/MyPage.js`
2. Добавьте роут в `src/App.js`
3. Добавьте пункт меню в `src/components/layout/Sidebar.js`
