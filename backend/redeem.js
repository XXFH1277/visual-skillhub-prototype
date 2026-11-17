import { randomInt, randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { PACKAGES } from "../shared/pricing.js";

// 兑换码：管理员按套餐批量生成，放到发卡小铺里卖；商家买到后在工作台兑换成积分。
// A code is a bearer secret: one use, optional expiry, can be voided (one code or a whole batch).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L
export const normalizeCode = (raw) => String(raw || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
const makeCode = () => Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
export const showCode = (c) => c.replace(/(.{4})(?=.)/g, "$1-");
const SETTINGS = ["siteUrl", ...PACKAGES.map((p) => `shop${p.price}`)];

export function registerRedeem({ app, store }) {
  const db = store.db;
  const adminOnly = (req, _res, next) => (req.user?.role === "admin" ? next() : next(new AppError("只有管理员可以操作", 403)));
  db.exec(`CREATE TABLE IF NOT EXISTS redeem_batches (id TEXT PRIMARY KEY, price INTEGER NOT NULL, credits INTEGER NOT NULL, count INTEGER NOT NULL,
             owner TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', expires_at TEXT, voided INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS redeem_codes (code TEXT PRIMARY KEY, batch_id TEXT NOT NULL, voided INTEGER NOT NULL DEFAULT 0,
             redeemed_by TEXT, redeemed_at TEXT);
           CREATE INDEX IF NOT EXISTS redeem_codes_batch ON redeem_codes(batch_id);
           CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const settings = () => Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().filter((r) => SETTINGS.includes(r.key)).map((r) => [r.key, r.value]));

  // Wrong guesses: five in ten minutes locks that account out of redeeming for ten minutes.
  const misses = new Map();
  const locked = (id) => {
    const m = misses.get(id);
    if (!m) return false;
    if (Date.now() - m.first > 10 * 60_000) return misses.delete(id), false;
    return m.count >= 5;
  };
  const miss = (id) => {
    const m = misses.get(id);
    if (!m || Date.now() - m.first > 10 * 60_000) misses.set(id, { first: Date.now(), count: 1 });
    else m.count++;
  };

  // Shop links for the credits page (where to buy each package).
  app.get("/api/shop", (_req, res) => {
    const s = settings();
    res.json({ links: Object.fromEntries(PACKAGES.map((p) => [p.price, s[`shop${p.price}`] || ""])) });
  });

  app.post("/api/redeem", (req, res) => {
    const id = req.user.id;
    if (locked(id)) throw new AppError("输错太多次，请 10 分钟后再试", 429);
    const code = normalizeCode(req.body?.code);
    const row = code.length === 12 && db.prepare("SELECT c.*, b.credits, b.price, b.expires_at, b.voided AS batch_voided FROM redeem_codes c JOIN redeem_batches b ON b.id=c.batch_id WHERE c.code=?").get(code);
    if (!row) {
      miss(id);
      throw new AppError("兑换码不对，请检查后再试");
    }
    if (row.redeemed_by) throw new AppError(row.redeemed_by === id ? "这个兑换码你已经兑换过了" : "这个兑换码已经被使用");
    if (row.voided || row.batch_voided) throw new AppError("这个兑换码已作废，请联系卖家");
    if (row.expires_at && row.expires_at < new Date().toISOString()) throw new AppError("这个兑换码已过期，请联系卖家");
    const at = new Date().toISOString();
    const account = store.transaction(() => {
      // The guard in the WHERE makes a second, simultaneous redemption a no-op.
      const done = db.prepare("UPDATE redeem_codes SET redeemed_by=?, redeemed_at=? WHERE code=? AND redeemed_by IS NULL AND voided=0").run(id, at, code);
      if (!done.changes) throw new AppError("这个兑换码已经被使用");
      db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(row.credits, id);
      db.prepare("INSERT INTO ledger(job_id,kind,amount,created_at,user_id) VALUES(?,?,?,?,?)").run(`兑换码 ${showCode(code).slice(0, 4)}…·¥${row.price}·${code}`, "redeem", row.credits, at, id);
      return store.users.view(store.users.get(id));
    });
    misses.delete(id);
    res.json({ credits: row.credits, price: row.price, balance: account.balance });
  });

  /* ---------- admin ---------- */
  app.get("/api/admin/codes", adminOnly, (_req, res) => {
    const batches = db
      .prepare(
        `SELECT b.*, (SELECT count(*) FROM redeem_codes c WHERE c.batch_id=b.id AND c.redeemed_by IS NOT NULL) AS redeemed,
           (SELECT count(*) FROM redeem_codes c WHERE c.batch_id=b.id AND c.voided=1) AS voided_codes
         FROM redeem_batches b ORDER BY b.created_at DESC LIMIT 200`,
      )
      .all()
      .map((b) => ({ id: b.id, price: b.price, credits: b.credits, count: b.count, owner: b.owner, note: b.note, expiresAt: b.expires_at, voided: !!b.voided, createdAt: b.created_at, redeemed: b.redeemed, voidedCodes: b.voided_codes }));
    // Per promoter: codes redeemed and the money they stand for.
    const owners = db
      .prepare(
        `SELECT b.owner AS owner, count(*) AS codes, coalesce(sum(b.price),0) AS yuan FROM redeem_codes c JOIN redeem_batches b ON b.id=c.batch_id
         WHERE c.redeemed_by IS NOT NULL GROUP BY b.owner ORDER BY yuan DESC`,
      )
      .all();
    res.json({ batches, owners, settings: settings(), packages: PACKAGES });
  });
  app.post("/api/admin/codes", adminOnly, (req, res) => {
    const b = req.body || {};
    const pack = PACKAGES.find((p) => p.price === Number(b.price));
    if (!pack) throw new AppError("请选择套餐");
    const count = Number(b.count);
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new AppError("数量在 1 到 500 之间");
    const days = b.expiresDays === "" || b.expiresDays == null ? 0 : Number(b.expiresDays);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new AppError("有效期天数无效");
    const id = randomUUID();
    const now = new Date();
    const expires = days ? new Date(now.getTime() + days * 864e5).toISOString() : null;
    const codes = store.transaction(() => {
      db.prepare("INSERT INTO redeem_batches(id,price,credits,count,owner,note,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)").run(
        id, pack.price, pack.credits, count, String(b.owner || "").trim().slice(0, 20), String(b.note || "").trim().slice(0, 40), expires, now.toISOString(),
      );
      const add = db.prepare("INSERT OR IGNORE INTO redeem_codes(code,batch_id) VALUES(?,?)");
      const out = [];
      while (out.length < count) {
        const c = makeCode();
        if (add.run(c, id).changes) out.push(c);
      }
      return out;
    });
    res.status(201).json({ id, codes: codes.map(showCode) });
  });
  // One line per unused code (or per redeem link), ready to import into the shop.
  app.get("/api/admin/codes/:id/export", adminOnly, (req, res) => {
    const batch = db.prepare("SELECT * FROM redeem_batches WHERE id=?").get(req.params.id);
    if (!batch) throw new AppError("没有这批兑换码", 404);
    const rows = db.prepare("SELECT code FROM redeem_codes WHERE batch_id=? AND redeemed_by IS NULL AND voided=0 ORDER BY rowid").all(batch.id);
    const base = String(settings().siteUrl || req.query.origin || "").replace(/\/+$/, "");
    const lines = rows.map((r) => (req.query.format === "link" ? `${base}/#/redeem/${showCode(r.code)}` : showCode(r.code)));
    res.set({ "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="codes-${batch.price}-${batch.id.slice(0, 8)}.txt"`, "Cache-Control": "no-store" });
    res.send(lines.join("\n") + (lines.length ? "\n" : ""));
  });
  app.post("/api/admin/codes/:id/void", adminOnly, (req, res) => {
    const r = db.prepare("UPDATE redeem_batches SET voided=1 WHERE id=?").run(req.params.id);
    if (!r.changes) throw new AppError("没有这批兑换码", 404);
    res.json({ ok: true });
  });
  // Look up one code: who redeemed it and when, or void it alone.
  app.get("/api/admin/code/:code", adminOnly, (req, res) => {
    const code = normalizeCode(req.params.code);
    const row = db.prepare("SELECT c.*, b.price, b.credits, b.owner, b.expires_at, b.voided AS batch_voided FROM redeem_codes c JOIN redeem_batches b ON b.id=c.batch_id WHERE c.code=?").get(code);
    if (!row) throw new AppError("没有这个兑换码", 404);
    const who = row.redeemed_by && store.users.get(row.redeemed_by);
    res.json({
      code: showCode(code),
      price: row.price,
      credits: row.credits,
      owner: row.owner,
      status: row.redeemed_by ? "redeemed" : row.voided || row.batch_voided ? "voided" : row.expires_at && row.expires_at < new Date().toISOString() ? "expired" : "unused",
      redeemedBy: who ? { name: who.name, phone: who.phone } : null,
      redeemedAt: row.redeemed_at,
    });
  });
  app.post("/api/admin/code/:code/void", adminOnly, (req, res) => {
    const r = db.prepare("UPDATE redeem_codes SET voided=1 WHERE code=? AND redeemed_by IS NULL").run(normalizeCode(req.params.code));
    if (!r.changes) throw new AppError("没有这个兑换码，或已经被兑换");
    res.json({ ok: true });
  });
  app.post("/api/admin/settings", adminOnly, (req, res) => {
    const up = db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    for (const k of SETTINGS) {
      if (typeof req.body?.[k] !== "string") continue;
      const v = req.body[k].trim().slice(0, 300);
      if (v && !/^https?:\/\//i.test(v)) throw new AppError("链接要以 http:// 或 https:// 开头");
      up.run(k, v);
    }
    res.json({ settings: settings() });
  });
}
