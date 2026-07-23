// src/constants/trustedUids.js
//
// Accounts created before email verification was turned on — let through without the
// verification wall. Same list also gates internal tools not ready for clients yet
// (backtest) — not tied to the Firestore 'admin' role, so we don't have to touch real
// user profiles just to show one page. Lives in its own file (not App.js) so components
// like Sidebar.js can import it without creating a circular import through App.js.
export const TRUSTED_UIDS = [
  'fuUAD1JLQ5VbfJRbajYgjhw5pCn2', // admin@trader.com
  '1stzQToO77e61ubwLuo3g5KK1DI3', // gleb@trader.com
  'SK2s0DtLAxNRtHhV3HwEwTVuK292', // radartest.20260710@example.com — QA test account
];
