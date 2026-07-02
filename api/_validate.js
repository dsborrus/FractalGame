// api/_validate.js — pure validation helpers (unit-tested in tests/).
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
}

export function validScore(n) {
  return Number.isInteger(n) && n > 0 && n < 10_000_000;
}
