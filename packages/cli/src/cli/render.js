// Human-readable terminal rendering: the tables printed when --json is off.
// Width-aware, so wide CJK glyphs do not break column alignment.

function _printTextNotImplemented(label) {
  // Goes to stderr so it never corrupts a JSON pipe consumer.
  process.stderr.write(`${label} (text mode) is not implemented yet. Use --json.\n`);
}

// Width-aware truncation that counts wide CJK glyphs as 2 columns so columns
// stay aligned in a monospace terminal.
function _displayWidth(str) {
  let w = 0;
  for (const ch of String(str || "")) {
    const code = ch.codePointAt(0);
    // Rough CJK / fullwidth range — good enough for table alignment.
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function _padRight(str, width) {
  const w = _displayWidth(str);
  return w >= width ? str : str + " ".repeat(width - w);
}

function _truncate(str, max) {
  let out = "";
  let w = 0;
  for (const ch of String(str || "")) {
    const cw = _displayWidth(ch);
    if (w + cw > max - 1) {
      out += "…";
      return out;
    }
    out += ch;
    w += cw;
  }
  return out;
}

function _printRows(rows, columns) {
  if (!rows || rows.length === 0) return;
  const widths = columns.map((c) => Math.max(_displayWidth(c.title), ...rows.map((r) => Math.min(c.max || 80, _displayWidth(String(r[c.key] != null ? r[c.key] : ""))))));
  const sep = "  ";
  const header = columns.map((c, i) => _padRight(c.title, widths[i])).join(sep);
  process.stdout.write(header + "\n");
  process.stdout.write(columns.map((_, i) => "-".repeat(widths[i])).join(sep) + "\n");
  for (const r of rows) {
    const line = columns.map((c, i) => {
      const v = r[c.key] != null ? String(r[c.key]) : "";
      return _padRight(_truncate(v, widths[i]), widths[i]);
    }).join(sep);
    process.stdout.write(line + "\n");
  }
}

function _printAccountList(result) {
  if (!result || !result.success) {
    process.stderr.write((result && result.error) ? result.error + "\n" : "failed\n");
    return;
  }
  const rows = result.accounts || [];
  if (!rows.length) {
    process.stdout.write("(no accounts configured)\n");
    return;
  }
  _printRows(rows, [
    { key: "id", title: "ID", max: 24 },
    { key: "email", title: "EMAIL", max: 40 },
    { key: "provider", title: "PROVIDER", max: 12 },
    { key: "imap_host", title: "IMAP HOST", max: 30 },
    { key: "description", title: "DESCRIPTION", max: 30 },
  ]);
  process.stdout.write(`\n${rows.length} account(s)\n`);
}

function _printEmailList(result) {
  if (!result || !result.success) {
    process.stderr.write((result && result.error) ? result.error + "\n" : "failed\n");
    return;
  }
  const rows = (result.emails || []).map((e) => ({
    flag: (e.unread ? "●" : " ") + (e.is_flagged || e.flagged ? "★" : " ") + (e.has_attachments ? "📎" : " "),
    date: String(e.date || "").slice(0, 16),
    folder: e.folder || "",
    from: e.from || "",
    subject: e.subject || "",
    id: e.id || e.uid || "",
  }));
  if (!rows.length) {
    process.stdout.write("(no emails)\n");
    if (result.failed_accounts && result.failed_accounts.length) {
      for (const fa of result.failed_accounts) {
        process.stderr.write(`account ${fa.account || fa.account_id || ""} failed: ${fa.error || ""}\n`);
      }
    }
    return;
  }
  _printRows(rows, [
    { key: "flag", title: "STATE", max: 5 },
    { key: "date", title: "DATE", max: 16 },
    { key: "folder", title: "FOLDER", max: 18 },
    { key: "from", title: "FROM", max: 32 },
    { key: "subject", title: "SUBJECT", max: 60 },
    { key: "id", title: "UID", max: 12 },
  ]);
  const totalFound = result.total_found != null ? result.total_found : result.total_in_folder;
  process.stdout.write(`\n${rows.length} shown` + (totalFound != null ? ` (of ${totalFound})` : "") + "\n");
}

function _printFolderList(result) {
  if (!result || !result.success) {
    process.stderr.write((result && result.error) ? result.error + "\n" : "failed\n");
    return;
  }
  const rows = result.folders || [];
  _printRows(rows, [
    { key: "path", title: "PATH", max: 40 },
    { key: "delimiter", title: "DELIM", max: 5 },
    { key: "attributes", title: "FLAGS", max: 30 },
  ]);
  process.stdout.write(`\n${rows.length} folder(s) in ${result.account || "account"}\n`);
}

module.exports = {
  _printTextNotImplemented,
  _displayWidth,
  _padRight,
  _truncate,
  _printRows,
  _printAccountList,
  _printEmailList,
  _printFolderList,
};
