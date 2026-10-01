const { getMailbox, listMailboxNames, logMockCall, getMockFailure } = require("./mock_store");

function _textPart(m) {
  if (m.html) {
    // multipart/alternative so mailparser yields both parsed.text and parsed.html
    const boundary = "MOCKBOUND";
    return [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      m.body || "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      m.html,
      `--${boundary}--`,
      "",
    ];
  }
  return ["Content-Type: text/plain; charset=utf-8", "", m.body || ""];
}

function _buildSource(m) {
  const headers = [
    `Message-ID: ${m.messageId}`,
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${m.subject}`,
    `Date: ${m.date}`,
  ];
  if (m.listUnsubscribe) headers.push(`List-Unsubscribe: ${m.listUnsubscribe}`);
  const atts = m.attachments || [];
  if (!atts.length) {
    if (!m.html) return Buffer.from([...headers, "", m.body || ""].join("\n"));
    return Buffer.from([...headers, ..._textPart(m)].join("\n"));
  }
  // multipart/mixed: the text part first, then each attachment base64-encoded,
  // so the real parse path sees the same attachments the fixture declares.
  const boundary = "MOCKMIXED";
  const lines = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, ..._textPart(m)];
  for (const a of atts) {
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content || ""));
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType || "application/octet-stream"}; name="${a.filename}"`,
      `Content-Disposition: ${a.inline ? "inline" : "attachment"}; filename="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      content.toString("base64")
    );
  }
  lines.push(`--${boundary}--`, "");
  return Buffer.from(lines.join("\n"));
}

function _cloneMessage(m) {
  const source = _buildSource(m);
  return {
    uid: m.uid,
    envelope: {
      subject: m.subject,
      from: [{ address: m.from }],
      to: [{ address: m.to }],
      cc: m.cc ? [{ address: m.cc }] : [],
      messageId: m.messageId,
      date: new Date(m.date.replace(" ", "T") + "Z"),
    },
    flags: new Set([...m.flags]),
    internalDate: new Date(m.date.replace(" ", "T") + "Z"),
    source,
    size: m.size != null ? Number(m.size) : source.length,
    bodyStructure: {
      childNodes: (m.attachments || []).map((a) => ({
        disposition: "attachment",
        parameters: { filename: a.filename },
        type: (a.contentType || "application/octet-stream").split("/")[0],
        subtype: (a.contentType || "application/octet-stream").split("/")[1],
      })),
    },
  };
}

// Accept everything imapflow accepts as a UID range: a number, an array of
// numbers, or a sequence-set string ("1:3,7,9:*"). Returns a predicate.
function _uidMatcher(range) {
  if (Array.isArray(range)) {
    const set = new Set(range.map(Number));
    return (uid) => set.has(Number(uid));
  }
  if (typeof range === "number") return (uid) => Number(uid) === range;
  const parts = String(range || "").split(",").map((p) => p.trim()).filter(Boolean);
  const tests = parts.map((p) => {
    const [a, b] = p.split(":");
    const lo = a === "*" ? Infinity : Number(a);
    if (b === undefined) return (uid) => uid === lo;
    const hi = b === "*" ? Infinity : Number(b);
    const min = Math.min(lo, hi);
    const max = Math.max(lo, hi);
    return (uid) => uid >= min && uid <= max;
  });
  return (uid) => tests.some((t) => t(Number(uid)));
}

// A predicate returning true makes the command throw; returning "false" makes
// it resolve to false, which is how imapflow reports a NO from the server.
function _maybeFail(op, range) {
  const pred = getMockFailure(op);
  const hit = pred ? pred(range) : false;
  if (hit === "false") return true;
  if (hit) throw new Error(`mock ${op} failure`);
  return false;
}

class MockImapClient {
  constructor(account) {
    this._account = account;
    this._mailbox = "INBOX";
  }

  _log(op, extra = {}) {
    logMockCall({ op, account: this._account.id, mailbox: this._mailbox, ...extra });
  }

  _mb() {
    const mb = getMailbox(this._account.id, this._mailbox);
    if (!mb) throw new Error(`Mailbox not found: ${this._mailbox}`);
    return mb;
  }

  _touch(mb, m) {
    // CONDSTORE emulation: only when the fixture opted in with highestModseq.
    if (mb.highestModseq == null) return;
    mb.highestModseq = Number(mb.highestModseq) + 1;
    m.modseq = mb.highestModseq;
  }

  async mailboxOpen(name) {
    this._mailbox = name || "INBOX";
    this._log("mailboxOpen");
    const mb = getMailbox(this._account.id, this._mailbox);
    if (!mb) throw new Error(`Mailbox not found: ${this._mailbox}`);
    const messages = mb.messages || [];
    const unseen = messages.filter((m) => !m.flags.has("\\Seen")).length;
    const maxUid = messages.reduce((mx, m) => Math.max(mx, Number(m.uid)), 0);
    this.mailbox = {
      path: this._mailbox,
      exists: messages.length,
      unseen,
      // imapflow reports these as BigInt; mirror that so callers handle it.
      uidValidity: BigInt(mb.uidValidity != null ? mb.uidValidity : 1),
      // omitUidNext mimics servers (163) that leave UIDNEXT out of SELECT.
      ...(mb.omitUidNext ? {} : { uidNext: Math.max(Number(mb.uidNext || 0), maxUid + 1) }),
      ...(mb.highestModseq != null ? { highestModseq: BigInt(mb.highestModseq) } : {}),
    };
    return this.mailbox;
  }

  async getMailboxLock(name) {
    await this.mailboxOpen(name);
    return {
      release() {
        // no-op
      },
    };
  }

  async status(name, opts) {
    this._log("status", { target: name });
    const mb = getMailbox(this._account.id, name);
    if (!mb) throw new Error(`Mailbox not found: ${name}`);
    const messages = mb.messages || [];
    const out = { path: name };
    if (opts && opts.unseen) out.unseen = messages.filter((m) => !m.flags.has("\\Seen")).length;
    if (opts && opts.messages) out.messages = messages.length;
    return out;
  }

  async search(query, options) {
    this._log("search", { query });
    const mb = this._mb();
    const messages = mb.messages || [];

    // Support legacy-style array queries (used by older code).
    if (Array.isArray(query)) {
      const wantsUnseen = query.includes("UNSEEN");
      const list = wantsUnseen ? messages.filter((m) => !m.flags.has("\\Seen")) : messages;
      return list.map((m) => m.uid);
    }

    // Support ImapFlow SearchObject subset.
    const q = query && typeof query === "object" ? query : {};

    let list = messages;

    if (q.uid != null) {
      const match = _uidMatcher(q.uid);
      list = list.filter((m) => match(m.uid));
    }

    if (q.seen === false) {
      list = list.filter((m) => !m.flags.has("\\Seen"));
    }

    if (typeof q.from === "string" && q.from.trim()) {
      const needle = q.from.toLowerCase();
      list = list.filter((m) => String(m.from || "").toLowerCase().includes(needle));
    }
    if (typeof q.to === "string" && q.to.trim()) {
      const needle = q.to.toLowerCase();
      list = list.filter((m) => String(m.to || "").toLowerCase().includes(needle));
    }
    if (typeof q.cc === "string" && q.cc.trim()) {
      const needle = q.cc.toLowerCase();
      list = list.filter((m) => String(m.cc || "").toLowerCase().includes(needle));
    }
    if (typeof q.subject === "string" && q.subject.trim()) {
      const needle = q.subject.toLowerCase();
      list = list.filter((m) => String(m.subject || "").toLowerCase().includes(needle));
    }
    if (typeof q.text === "string" && q.text.trim()) {
      const needle = q.text.toLowerCase();
      list = list.filter((m) => {
        const hay = `${m.subject || ""} ${m.from || ""} ${m.to || ""} ${m.cc || ""} ${m.body || ""}`.toLowerCase();
        return hay.includes(needle);
      });
    }

    if (q.since instanceof Date && !Number.isNaN(q.since.getTime())) {
      list = list.filter((m) => {
        const d = new Date(String(m.date || "").replace(" ", "T") + "Z");
        return !Number.isNaN(d.getTime()) && d >= q.since;
      });
    }
    if (q.before instanceof Date && !Number.isNaN(q.before.getTime())) {
      list = list.filter((m) => {
        const d = new Date(String(m.date || "").replace(" ", "T") + "Z");
        return !Number.isNaN(d.getTime()) && d < q.before;
      });
    }

    // options.uid affects return type in real ImapFlow (uids vs seq). Mock is UID-only.
    void options;
    return list.map((m) => m.uid);
  }

  _project(m, mb, opts) {
    const msg = _cloneMessage(m);
    // mimic imapflow fetch response shape
    const out = { uid: msg.uid };
    if (opts.envelope) out.envelope = msg.envelope;
    if (opts.flags) out.flags = msg.flags;
    if (opts.internalDate) out.internalDate = msg.internalDate;
    if (opts.bodyStructure) out.bodyStructure = msg.bodyStructure;
    if (opts.size) out.size = msg.size;
    if (opts.source) {
      if (typeof opts.source === "object") {
        const start = Number(opts.source.start || 0);
        const end = opts.source.maxLength != null ? start + Number(opts.source.maxLength) : undefined;
        out.source = msg.source.subarray(start, end);
      } else {
        out.source = msg.source;
      }
    }
    if (mb.highestModseq != null) out.modseq = BigInt(m.modseq || 1);
    return out;
  }

  async *fetch(uids, opts, fetchOpts = {}) {
    this._log("fetch", { range: uids, opts, fetchOpts });
    const mb = this._mb();
    const match = _uidMatcher(uids);
    const changedSince = fetchOpts && fetchOpts.changedSince != null && mb.highestModseq != null
      ? Number(fetchOpts.changedSince)
      : null;
    for (const m of mb.messages || []) {
      if (!match(m.uid)) continue;
      if (changedSince != null && Number(m.modseq || 1) <= changedSince) continue;
      yield this._project(m, mb, opts);
    }
  }

  async fetchOne(uid, opts) {
    this._log("fetchOne", { range: uid, opts });
    const mb = this._mb();
    const m = (mb.messages || []).find((x) => x.uid === Number(uid));
    if (!m) return null;
    return this._project(m, mb, opts);
  }

  async messageFlagsAdd(uids, flags) {
    this._log("messageFlagsAdd", { range: uids, flags });
    if (_maybeFail("messageFlagsAdd", uids)) return false;
    const mb = this._mb();
    const match = _uidMatcher(uids);
    for (const m of mb.messages || []) {
      if (!match(m.uid)) continue;
      for (const f of flags) m.flags.add(f);
      this._touch(mb, m);
    }
    return true;
  }

  async messageFlagsRemove(uids, flags) {
    this._log("messageFlagsRemove", { range: uids, flags });
    if (_maybeFail("messageFlagsRemove", uids)) return false;
    const mb = this._mb();
    const match = _uidMatcher(uids);
    for (const m of mb.messages || []) {
      if (!match(m.uid)) continue;
      for (const f of flags) m.flags.delete(f);
      this._touch(mb, m);
    }
    return true;
  }

  async messageMove(uids, target) {
    this._log("messageMove", { range: uids, target });
    if (_maybeFail("messageMove", uids)) return false;
    const src = getMailbox(this._account.id, this._mailbox);
    const dst = getMailbox(this._account.id, target);
    if (!src) throw new Error(`Mailbox not found: ${this._mailbox}`);
    if (!dst) throw new Error(`Target mailbox not found: ${target}`);
    const match = _uidMatcher(uids);
    const keep = [];
    const uidMap = new Map();
    for (const m of src.messages || []) {
      if (match(m.uid)) {
        dst.messages.push(m);
        uidMap.set(m.uid, m.uid);
      } else {
        keep.push(m);
      }
    }
    src.messages = keep;
    return { path: this._mailbox, destination: target, uidMap };
  }

  async messageDelete(uids) {
    this._log("messageDelete", { range: uids });
    if (_maybeFail("messageDelete", uids)) return false;
    const src = this._mb();
    const match = _uidMatcher(uids);
    src.messages = (src.messages || []).filter((m) => !match(m.uid));
    return true;
  }

  async *list() {
    this._log("list");
    const names = listMailboxNames(this._account.id);
    for (const name of names) {
      yield {
        path: name,
        name,
        delimiter: "/",
        flags: new Set([]),
        specialUse: name.toLowerCase() === "trash" ? "\\Trash" : "",
      };
    }
  }
}

function createMockImapClient(account) {
  return new MockImapClient(account);
}

function createMockImapClientArrayList(account) {
  const client = createMockImapClient(account);
  const originalList = client.list.bind(client);

  client.list = async () => {
    const out = [];
    for await (const item of originalList()) {
      out.push(item);
    }
    return out;
  };

  return client;
}

module.exports = {
  createMockImapClient,
  createMockImapClientArrayList,
  _uidMatcher,
};
