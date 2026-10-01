// Date input handling for the email services: relative shortcuts (7d, 3w, today,
// last-week...) expanded to YYYY-MM-DD, plus parsing into the shape IMAP SEARCH
// and the SQLite cache both want.

const { formatDateTime } = require("../format");

function _dateOnly(raw) {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw);
}

function _isoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Expand relative date shortcuts (today, yesterday, last-week, and <N><unit>
// with unit ∈ m h d w mo y) into a concrete date string. Lives in core so BOTH
// the CLI and the MCP server get the behavior the MCP schema advertises — the
// MCP path used to pass "2d" straight through, where new Date("2d") => NaN and
// the filter was silently dropped.
function _expandRelativeDate(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  const now = new Date();
  if (value === "today") return _isoDate(now);
  if (value === "yesterday") {
    const d = new Date(now); d.setDate(d.getDate() - 1); return _isoDate(d);
  }
  if (value === "last-week" || value === "lastweek") {
    const d = new Date(now); d.setDate(d.getDate() - 7); return _isoDate(d);
  }
  if (value === "last-month" || value === "lastmonth") {
    const d = new Date(now); d.setMonth(d.getMonth() - 1); return _isoDate(d);
  }
  const m = value.match(/^(\d+)\s*(mo|m|h|d|w|y)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const d = new Date(now);
    if (unit === "m") d.setMinutes(d.getMinutes() - n);
    else if (unit === "h") d.setHours(d.getHours() - n);
    else if (unit === "d") d.setDate(d.getDate() - n);
    else if (unit === "w") d.setDate(d.getDate() - n * 7);
    else if (unit === "mo") d.setMonth(d.getMonth() - n);
    else if (unit === "y") d.setFullYear(d.getFullYear() - n);
    if (unit === "d" || unit === "w" || unit === "mo" || unit === "y") return _isoDate(d);
    return d.toISOString();
  }
  return String(raw || "").trim(); // pass through to the strict parser
}

function _parseDateInput(raw, { end = false } = {}) {
  const raw0 = String(raw || "").trim();
  const value = _expandRelativeDate(raw0);
  if (!value) return { date: null, sql: "" };

  const unparseable = () => ({ date: null, sql: "", warning: `Ignored unparseable date "${raw0}"` });

  if (_dateOnly(value)) {
    const start = new Date(`${value}T00:00:00`);
    if (Number.isNaN(start.getTime())) return unparseable();
    if (end) {
      const before = new Date(start.getTime());
      before.setDate(before.getDate() + 1);
      return { date: before, sql: `${value} 23:59:59` };
    }
    return { date: start, sql: `${value} 00:00:00` };
  }

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return unparseable();
  const sql = formatDateTime(d) || value;
  if (end) return { date: new Date(d.getTime() + 1000), sql };
  return { date: d, sql };
}

module.exports = {
  _dateOnly,
  _isoDate,
  _expandRelativeDate,
  _parseDateInput,
};
