/**
 * NYSE trading calendar and market-state logic.
 *
 * This module is the single authority on "what is a trading session" and "is the market
 * open right now". Everything else in the app defers to it.
 *
 * Two conventions that prevent a whole class of bugs:
 *
 * 1. **A session is identified by a `yyyy-MM-dd` string in New York terms**, never by a
 *    `Date`. A `Date` is an instant, and the instant "2024-03-15T00:00:00" means a
 *    different calendar day depending on where you are standing. Storing session dates as
 *    strings makes the date unambiguous and matches the Postgres `date` column exactly.
 *
 * 2. **Never read the host clock's local time.** `new Date().getHours()` returns the wrong
 *    hour on a laptop outside New York — which is the actual situation here, since this
 *    machine is set to Asia/Hong_Kong. All wall-clock reasoning goes through
 *    `America/New_York` via `date-fns-tz`, so DST is handled by the tz database rather
 *    than by hand.
 */

import { formatInTimeZone } from 'date-fns-tz'

export const MARKET_TZ = 'America/New_York'

/** A trading session date in New York terms, formatted `yyyy-MM-dd`. */
export type SessionDate = string

export type MarketState = 'PRE' | 'REGULAR' | 'POST' | 'CLOSED'

/** Minutes from ET midnight for each session boundary. */
const PRE_OPEN_MIN = 4 * 60 // 04:00 ET
const REGULAR_OPEN_MIN = 9 * 60 + 30 // 09:30 ET
const REGULAR_CLOSE_MIN = 16 * 60 // 16:00 ET
const EARLY_CLOSE_MIN = 13 * 60 // 13:00 ET on half-days
const POST_CLOSE_MIN = 20 * 60 // 20:00 ET

// ── date helpers (string-based, timezone-free) ───────────────────────────────────

/** The New York calendar date of an instant, as `yyyy-MM-dd`. */
export function toSessionDate(instant: Date): SessionDate {
  return formatInTimeZone(instant, MARKET_TZ, 'yyyy-MM-dd')
}

/** Minutes since New York midnight for an instant. */
export function toMinutesET(instant: Date): number {
  const hhmm = formatInTimeZone(instant, MARKET_TZ, 'HH:mm')
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function parseYMD(d: SessionDate): { y: number; m: number; d: number } {
  const [y, m, day] = d.split('-').map(Number)
  return { y, m, d: day }
}

function ymd(y: number, m: number, d: number): SessionDate {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Day of week for a session date. 0 = Sunday .. 6 = Saturday.
 * Uses Zeller-style arithmetic on the date parts so no `Date` (and therefore no timezone)
 * is involved.
 */
export function dayOfWeek(date: SessionDate): number {
  const { y, m, d } = parseYMD(date)
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const yy = m < 3 ? y - 1 : y
  return (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1] + d) % 7
}

export function isWeekend(date: SessionDate): boolean {
  const dow = dayOfWeek(date)
  return dow === 0 || dow === 6
}

/** Add days to a session date, staying entirely in string/integer arithmetic. */
export function addDays(date: SessionDate, days: number): SessionDate {
  const { y, m, d } = parseYMD(date)
  // Date.UTC is safe here: we are doing pure calendar arithmetic in a fixed zone (UTC),
  // then reading the result back as UTC parts. No local timezone is consulted.
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000
  const dt = new Date(t)
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

// ── holiday computation ─────────────────────────────────────────────────────────

/** The nth given weekday of a month, e.g. the 3rd Monday of January. */
function nthWeekdayOfMonth(y: number, month: number, weekday: number, n: number): SessionDate {
  const first = ymd(y, month, 1)
  const firstDow = dayOfWeek(first)
  const offset = (weekday - firstDow + 7) % 7
  return addDays(first, offset + (n - 1) * 7)
}

/** The last given weekday of a month, e.g. the last Monday of May. */
function lastWeekdayOfMonth(y: number, month: number, weekday: number): SessionDate {
  const daysInMonth = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  const last = ymd(y, month, daysInMonth)
  const lastDow = dayOfWeek(last)
  return addDays(last, -((lastDow - weekday + 7) % 7))
}

/**
 * Easter Sunday, via the anonymous Gregorian algorithm (Meeus/Jones/Butcher).
 * Needed only because Good Friday — the market holiday — is defined relative to it.
 */
function easterSunday(y: number): SessionDate {
  const a = y % 19
  const b = Math.floor(y / 100)
  const c = y % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return ymd(y, month, day)
}

/**
 * Apply the NYSE observed-holiday rule to a fixed-date holiday.
 *
 * Saturday → observed the preceding Friday; Sunday → observed the following Monday.
 *
 * The documented exception is New Year's Day: when January 1 falls on a Saturday the
 * exchange does *not* close on December 31 of the prior year. Callers handle that by
 * passing `observeSaturdayAsFriday: false`.
 */
function observed(date: SessionDate, observeSaturdayAsFriday = true): SessionDate | null {
  const dow = dayOfWeek(date)
  if (dow === 6) return observeSaturdayAsFriday ? addDays(date, -1) : null
  if (dow === 0) return addDays(date, 1)
  return date
}

const holidayCache = new Map<number, Set<SessionDate>>()

/** All NYSE full-day closures for a calendar year. */
export function holidaysForYear(y: number): Set<SessionDate> {
  const cached = holidayCache.get(y)
  if (cached) return cached

  const out = new Set<SessionDate>()
  const add = (d: SessionDate | null) => {
    if (d) out.add(d)
  }

  add(observed(ymd(y, 1, 1), false)) // New Year's Day (no Friday-before rule)
  add(nthWeekdayOfMonth(y, 1, 1, 3)) // MLK Jr. Day — 3rd Monday in January
  add(nthWeekdayOfMonth(y, 2, 1, 3)) // Washington's Birthday — 3rd Monday in February
  add(addDays(easterSunday(y), -2)) // Good Friday
  add(lastWeekdayOfMonth(y, 5, 1)) // Memorial Day — last Monday in May
  if (y >= 2022) add(observed(ymd(y, 6, 19))) // Juneteenth, an NYSE holiday from 2022
  add(observed(ymd(y, 7, 4))) // Independence Day
  add(nthWeekdayOfMonth(y, 9, 1, 1)) // Labor Day — 1st Monday in September
  add(nthWeekdayOfMonth(y, 11, 4, 4)) // Thanksgiving — 4th Thursday in November
  add(observed(ymd(y, 12, 25))) // Christmas Day

  holidayCache.set(y, out)
  return out
}

/** True when the exchange is fully closed on this date (weekend or holiday). */
export function isHoliday(date: SessionDate): boolean {
  const { y } = parseYMD(date)
  return holidaysForYear(y).has(date)
}

/** True when this date is a regular trading session (not a weekend, not a holiday). */
export function isSessionDate(date: SessionDate): boolean {
  return !isWeekend(date) && !isHoliday(date)
}

/**
 * True when the session closes early, at 13:00 ET.
 *
 * The recurring NYSE early closes are:
 * - the day after Thanksgiving;
 * - July 3, when it is itself a trading day and July 4 is the observed holiday;
 * - December 24, when it is a trading day.
 */
export function isHalfDay(date: SessionDate): boolean {
  if (!isSessionDate(date)) return false
  const { y, m, d } = parseYMD(date)

  // Day after Thanksgiving.
  const thanksgiving = nthWeekdayOfMonth(y, 11, 4, 4)
  if (date === addDays(thanksgiving, 1)) return true

  // July 3, when the 4th is the observed holiday.
  if (m === 7 && d === 3 && isHoliday(ymd(y, 7, 4))) return true

  // Christmas Eve.
  if (m === 12 && d === 24) return true

  return false
}

/** Closing time, in minutes from ET midnight, for a given session. */
export function closeMinuteFor(date: SessionDate): number {
  return isHalfDay(date) ? EARLY_CLOSE_MIN : REGULAR_CLOSE_MIN
}

// ── market state ────────────────────────────────────────────────────────────────

/**
 * Current market state for an instant.
 *
 * On a half-day the regular session ends at 13:00 ET, and after-hours trading ends at
 * 17:00 rather than 20:00.
 */
export function marketStateAt(instant: Date): MarketState {
  const date = toSessionDate(instant)
  if (!isSessionDate(date)) return 'CLOSED'

  const minutes = toMinutesET(instant)
  const close = closeMinuteFor(date)
  const postClose = isHalfDay(date) ? close + 4 * 60 : POST_CLOSE_MIN

  if (minutes < PRE_OPEN_MIN) return 'CLOSED'
  if (minutes < REGULAR_OPEN_MIN) return 'PRE'
  if (minutes < close) return 'REGULAR'
  if (minutes < postClose) return 'POST'
  return 'CLOSED'
}

export function isMarketOpen(instant: Date): boolean {
  return marketStateAt(instant) === 'REGULAR'
}

/**
 * The most recent session that has fully closed as of `instant`.
 *
 * This is the correct "as of" date for any completed-session metric. Mid-session it returns
 * the *previous* session, because today's bar isn't final yet — using today's partial bar
 * as if it were a close is how intraday noise leaks into historical statistics.
 */
export function lastCompletedSession(instant: Date): SessionDate {
  const today = toSessionDate(instant)
  const minutes = toMinutesET(instant)

  if (isSessionDate(today) && minutes >= closeMinuteFor(today)) return today
  return previousSession(today)
}

/** The session immediately before this date. */
export function previousSession(date: SessionDate): SessionDate {
  let d = addDays(date, -1)
  // A gap of more than a week would mean the holiday table is wrong, so fail loudly
  // rather than spin.
  for (let i = 0; i < 10; i++) {
    if (isSessionDate(d)) return d
    d = addDays(d, -1)
  }
  throw new Error(`previousSession: no trading day within 10 days before ${date}`)
}

/** The session immediately after this date. */
export function nextSession(date: SessionDate): SessionDate {
  let d = addDays(date, 1)
  for (let i = 0; i < 10; i++) {
    if (isSessionDate(d)) return d
    d = addDays(d, 1)
  }
  throw new Error(`nextSession: no trading day within 10 days after ${date}`)
}

/**
 * All trading sessions in `[from, to]`, inclusive of both ends when they are sessions.
 *
 * This is the authority for "what bars should exist" — never assume a fixed count of bars
 * between two dates, because holidays vary by year.
 */
export function sessionsBetween(from: SessionDate, to: SessionDate): SessionDate[] {
  if (from > to) return []
  const out: SessionDate[] = []
  let d = from
  while (d <= to) {
    if (isSessionDate(d)) out.push(d)
    d = addDays(d, 1)
  }
  return out
}

/** Count of sessions in `[from, to]`. */
export function countSessions(from: SessionDate, to: SessionDate): number {
  return sessionsBetween(from, to).length
}

/**
 * The session date `n` sessions back from `date` (n = 0 returns `date` itself if it is a
 * session). Useful for "give me 252 trading days of history".
 */
export function sessionsAgo(date: SessionDate, n: number): SessionDate {
  let d = isSessionDate(date) ? date : previousSession(date)
  for (let i = 0; i < n; i++) d = previousSession(d)
  return d
}

// ── presentation ────────────────────────────────────────────────────────────────

/**
 * How long a quote may be considered fresh, in milliseconds, given the market state.
 *
 * Free data providers rate-limit aggressively, and there is no reason to re-request a
 * quote for a market that is closed — the price cannot change until it reopens.
 */
export function quoteTtlMs(state: MarketState): number {
  switch (state) {
    case 'REGULAR':
      return 60_000 // 1 minute
    case 'PRE':
    case 'POST':
      return 300_000 // 5 minutes
    case 'CLOSED':
      return 3_600_000 // 1 hour; the daily refresh handles the real update
  }
}

/**
 * A human-readable market-status label.
 *
 * Deliberately explicit about staleness: after the close it names the session the data
 * came from, so a stale day-change is never presented as if it were live.
 */
export function marketStatusLabel(instant: Date): { state: MarketState; label: string } {
  const state = marketStateAt(instant)
  const date = toSessionDate(instant)

  switch (state) {
    case 'REGULAR':
      return { state, label: isHalfDay(date) ? 'Open · early close 1:00pm ET' : 'Open' }
    case 'PRE':
      return { state, label: 'Pre-market' }
    case 'POST':
      return { state, label: 'After hours' }
    case 'CLOSED': {
      const last = lastCompletedSession(instant)
      const [y, m, d] = last.split('-').map(Number)
      const label = formatInTimeZone(
        new Date(Date.UTC(y, m - 1, d, 12)),
        MARKET_TZ,
        'EEE MMM d',
      )
      return { state, label: `Closed · as of ${label}` }
    }
  }
}
