// v14.2: dates are typed and shown as dd-mm-yyyy (day first) whatever the browser's language.
// The browser's own date field (<input type="date">) shows and reads dates in the order of the browser's language:
// a browser set to English (United States) reads 05/09/2026 as 9 May 2026, one set to English (India / UK) as
// 5 September 2026 — the same keystrokes store different dates. The XML always holds yyyy-mm-dd (xs:date), which the
// MCA PDF prints as dd/mm/yyyy. Pure functions; the UI (app.js) uses them for every date cell and the setup dates.
import { isoDate } from './periods.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** yyyy-mm-dd → dd-mm-yyyy (anything else is returned unchanged) */
export function dmyOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso ?? '');
}
/** yyyy-mm-dd → "5 September 2026" */
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m && isoDate(iso) ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}
/**
 * typed text → { iso } or { error }. Day first: dd-mm-yyyy, d-m-yyyy, with - / . or space between, or 8 digits
 * ddmmyyyy; yyyy-mm-dd is accepted as it is (unambiguous). Empty text → { iso: '' }.
 */
export function isoOfDmy(text) {
  const s = String(text ?? '').trim();
  if (!s) return { iso: '' };
  let d, mo, y;
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [, y, mo, d] = m;
  else if ((m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/.exec(s))) [, d, mo, y] = m;
  else if ((m = /^(\d{2})(\d{2})(\d{4})$/.exec(s))) [, d, mo, y] = m;
  else return { error: `'${s}' is not a date. Type it day first as dd-mm-yyyy, e.g. 05-09-2026 for 5 September 2026.` };
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (!isoDate(iso)) return { error: `'${s}' is not a date (day ${Number(d)}, month ${Number(mo)}, year ${y}). Type it day first as dd-mm-yyyy, e.g. 05-09-2026 for 5 September 2026.` };
  return { iso };
}
