/**
 * FCP interest form backend (Google Apps Script, bound to the "FCP Interest" sheet).
 *
 * Defenses against spam and sheet-bombing:
 *  1. Cloudflare Turnstile token verified server-side (secret never leaves Script Properties).
 *     Tokens are single-use, so a captured request can't be replayed.
 *  2. Hostname check: the Turnstile token must have been issued on your site.
 *  3. Honeypot field + minimum fill time (bots get a fake "ok" so they don't adapt).
 *  4. Strict validation: allowed fields only, length caps, fixed dropdown values, email format.
 *  5. One signup per email (cache + sheet lookup).
 *  6. Rate limits: max signups per 10 minutes and per day across the whole form.
 *  7. Formula-injection guard: cells starting with = + - @ are stored as plain text.
 *  8. A kill switch (FORM_OPEN = false) to stop all writes instantly.
 *
 * Script Properties to set (Project Settings > Script properties):
 *   TURNSTILE_SECRET   your Turnstile secret key
 *   ALLOWED_HOSTNAME   e.g. okoushiko.github.io
 *   FORM_OPEN          true
 */

const SHEET_NAME = 'Interest';
const HEADERS = ['Timestamp', 'Name', 'Email', 'School', 'Compute', 'Duration', 'How they would use it'];

const LIMITS = { name: 80, email: 120, school: 100, use: 1000 };
const COMPUTE = ['CPU only', 'GPU', 'Not sure yet'];
const DURATION = ['A few hours', 'Overnight', 'A few days', 'A week or more', 'Not sure yet'];

const MIN_FILL_MS = 4000;      // humans take longer than 4 s to fill this in
const WINDOW_LIMIT = 30;       // max signups per 10 minutes, whole site
const WINDOW_SECONDS = 600;
const DAILY_LIMIT = 300;       // max signups per day, whole site

function doPost(e) {
  let body;
  try {
    if (!e || !e.postData || e.postData.contents.length > 5000) return reply_(false, 'invalid');
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply_(false, 'invalid');
  }

  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('FORM_OPEN') !== 'true') return reply_(false, 'closed');

  // Bots: pretend it worked, write nothing.
  if (body.website) return reply_(true);
  if (typeof body.elapsed !== 'number' || body.elapsed < MIN_FILL_MS) return reply_(true);

  // Captcha first, so unverified traffic never touches the sheet or the counters.
  if (!verifyTurnstile_(body.token, props)) return reply_(false, 'captcha');

  const clean = validate_(body);
  if (!clean) return reply_(false, 'invalid');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return reply_(false, 'busy');
  try {
    if (!underRateLimit_(props)) return reply_(false, 'busy');

    const sheet = getSheet_();
    const cache = CacheService.getScriptCache();
    const emailKey = 'e:' + hash_(clean.email);
    if (cache.get(emailKey) || emailExists_(sheet, clean.email)) return reply_(false, 'duplicate');

    sheet.appendRow([
      new Date(),
      safe_(clean.name),
      safe_(clean.email),
      safe_(clean.school),
      clean.compute,
      clean.duration,
      safe_(clean.use)
    ]);
    cache.put(emailKey, '1', 21600);
    return reply_(true);
  } catch (err) {
    console.error(err);
    return reply_(false, 'server');
  } finally {
    lock.releaseLock();
  }
}

// Nothing is readable through GET.
function doGet() {
  return ContentService.createTextOutput('FCP signup endpoint').setMimeType(ContentService.MimeType.TEXT);
}

function verifyTurnstile_(token, props) {
  const secret = props.getProperty('TURNSTILE_SECRET');
  if (!secret || typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const res = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'post',
      payload: { secret: secret, response: token },
      muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText());
    if (!data.success) return false;
    const host = props.getProperty('ALLOWED_HOSTNAME');
    return !host || data.hostname === host;
  } catch (err) {
    console.error(err);
    return false;
  }
}

function validate_(b) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '').slice(0, max + 1);
  const name = str(b.name, LIMITS.name);
  const email = str(b.email, LIMITS.email).toLowerCase();
  const school = str(b.school, LIMITS.school);
  const use = typeof b.use === 'string' ? b.use.trim() : '';

  if (!name || name.length > LIMITS.name) return null;
  if (!school || school.length > LIMITS.school) return null;
  if (!use || use.length > LIMITS.use) return null;
  if (email.length > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  if (COMPUTE.indexOf(b.compute) === -1 || DURATION.indexOf(b.duration) === -1) return null;

  return { name: name, email: email, school: school, use: use, compute: b.compute, duration: b.duration };
}

function underRateLimit_(props) {
  const cache = CacheService.getScriptCache();
  const windowKey = 'w:' + Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const inWindow = Number(cache.get(windowKey) || 0);
  if (inWindow >= WINDOW_LIMIT) return false;

  const dayKey = 'day:' + Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  const today = Number(props.getProperty(dayKey) || 0);
  if (today >= DAILY_LIMIT) return false;

  cache.put(windowKey, String(inWindow + 1), WINDOW_SECONDS * 2);
  props.setProperty(dayKey, String(today + 1));
  return true;
}

function emailExists_(sheet, email) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  return !!sheet.getRange(2, 3, last - 1, 1)
    .createTextFinder(email).matchEntireCell(true).matchCase(false).findNext();
}

// Stop spreadsheet formula injection (e.g. =IMPORTXML(...)).
function safe_(v) {
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

function hash_(s) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s));
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || setup();
}

function reply_(ok, error) {
  return ContentService
    .createTextOutput(JSON.stringify(ok ? { ok: true } : { ok: false, error: error }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor: creates the tab, headers, and asks for permissions. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  // touch UrlFetchApp so the permission prompt includes external requests
  UrlFetchApp.getRequest('https://challenges.cloudflare.com');
  return sheet;
}
