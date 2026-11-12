import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";
import { CHECKIN_WEEK, CHECKIN_EXPIRE_DAYS, SIGNUP_CREDITS } from "../shared/pricing.js";

export const ADMIN_ID = "admin";
const now = () => new Date().toISOString();
// Check-in days roll over at midnight Beijing time, where the merchants are.
const dayOf = (at) => new Date(at.getTime() + 8 * 3600000).toISOString().slice(0, 10);
const hashPassword = (password, salt = randomBytes(16)) =>
  `${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
const checkPassword = (password, stored) => {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  return timingSafeEqual(Buffer.from(hash, "hex"), scryptSync(password, Buffer.from(salt, "hex"), 32));
};
// Spend roughly the same time on unknown phones as on wrong passwords.
const DUMMY = hashPassword("not-a-real-password");

export function cleanPhone(value) {
  const phone = String(value || "").replace(/[\s-]/g, "");
  if (!/^\+?\d{6,15}$/.test(phone)) throw new AppError("请填写正确的手机号");
  return phone;
}
function cleanPassword(value) {
  if (typeof value !== "string" || value.length < 6 || value.length > 64) throw new AppError("密码 6–64 位");
  return value;
}
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const inviteCode = () => [...randomBytes(8)].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");

// Merchant accounts, invite codes and per-account credit wallets.
export class Users {
  constructor(store) {
    this.store = store;
    const db = (this.db = store.db);
    db.exec(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, phone TEXT UNIQUE, name TEXT NOT NULL, pass TEXT,
        role TEXT NOT NULL, balance INTEGER NOT NULL CHECK(balance>=0),
        invite TEXT, created_at TEXT NOT NULL, last_login TEXT);
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY, credits INTEGER NOT NULL, max_uses INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
        revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkins (
        user_id TEXT NOT NULL, day TEXT NOT NULL, streak INTEGER NOT NULL, amount INTEGER NOT NULL,
        PRIMARY KEY(user_id, day));`);
    // The original single-workspace wallet and everything made before accounts belong to the admin.
    if (!this.get(ADMIN_ID)) {
      const legacy = db.prepare("SELECT balance FROM wallet WHERE id=1").get()?.balance ?? 500;
      db.prepare("INSERT INTO users(id,phone,name,pass,role,balance,created_at) VALUES(?,?,?,?,?,?,?)").run(
        ADMIN_ID, null, "管理员", null, "admin", legacy, now(),
      );
    }
    this.adopt("jobs");
    this.adopt("ledger");
  }
  // Give a table an owner column; rows from before accounts existed belong to the admin.
  adopt(table) {
    if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === "user_id"))
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
    this.db.prepare(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`).run(ADMIN_ID);
    this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_user ON ${table}(user_id)`);
  }
  get(id) {
    return this.db.prepare("SELECT * FROM users WHERE id=?").get(id) || null;
  }
  view(u) {
    return u && { id: u.id, name: u.name, phone: u.phone, role: u.role, balance: u.balance, createdAt: u.created_at, lastLogin: u.last_login };
  }
  register({ phone, password, name, invite }) {
    phone = cleanPhone(phone);
    password = cleanPassword(password);
    name = String(name || "").trim().slice(0, 20) || phone.slice(-4) + " 的店";
    const code = String(invite || "").trim().toUpperCase();
    if (!code) throw new AppError("请填写邀请码");
    const pass = hashPassword(password);
    return this.store.transaction(() => {
      const inv = this.db.prepare("SELECT * FROM invites WHERE code=?").get(code);
      if (!inv || inv.revoked || inv.used >= inv.max_uses) throw new AppError("邀请码无效或已用完", 403);
      if (this.db.prepare("SELECT id FROM users WHERE phone=?").get(phone)) throw new AppError("这个手机号已经注册，请直接登录", 409);
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO users(id,phone,name,pass,role,balance,invite,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, phone, name, pass, "user", inv.credits, code, now());
      this.db.prepare("UPDATE invites SET used=used+1 WHERE code=?").run(code);
      if (inv.credits)
        this.db.prepare("INSERT INTO ledger(job_id,kind,amount,created_at,user_id) VALUES(?,?,?,?,?)").run(null, "signup", inv.credits, now(), id);
      return this.get(id);
    });
  }
  verify(phone, password) {
    const u = this.db.prepare("SELECT * FROM users WHERE phone=?").get(cleanPhone(phone));
    const ok = checkPassword(String(password || ""), u?.pass || DUMMY);
    if (!u || !ok) throw new AppError("手机号或密码不正确", 401);
    return u;
  }
  touch(id) {
    this.db.prepare("UPDATE users SET last_login=? WHERE id=?").run(now(), id);
  }
  setPassword(id, password) {
    this.db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPassword(cleanPassword(password)), id);
  }
  setPhone(id, phone) {
    phone = cleanPhone(phone);
    const other = this.db.prepare("SELECT id FROM users WHERE phone=?").get(phone);
    if (other && other.id !== id) throw new AppError("这个手机号已被其他账号使用", 409);
    this.db.prepare("UPDATE users SET phone=? WHERE id=?").run(phone, id);
  }
  list() {
    return this.db
      .prepare(
        `SELECT u.*, (SELECT count(*) FROM jobs j WHERE j.user_id=u.id) AS jobs,
          (SELECT -coalesce(sum(amount),0) FROM ledger l WHERE l.user_id=u.id AND l.kind IN ('reserve','refund')) AS spent
         FROM users u ORDER BY u.created_at DESC`,
      )
      .all()
      .map((u) => ({ ...this.view(u), invite: u.invite, jobs: u.jobs, spent: u.spent }));
  }
  grant(id, amount, note = "") {
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100000) throw new AppError("充值数量无效");
    return this.store.transaction(() => {
      const u = this.get(id);
      if (!u) throw new AppError("账号不存在", 404);
      if (u.balance + amount < 0) throw new AppError("扣减后余额不能为负");
      this.db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(amount, id);
      this.db
        .prepare("INSERT INTO ledger(job_id,kind,amount,created_at,user_id) VALUES(?,?,?,?,?)")
        .run(note ? String(note).slice(0, 40) : null, "grant", amount, now(), id);
      return this.view(this.get(id));
    });
  }
  /* ---- daily check-in ---- */
  // Where the account stands today: checked in or not, the streak, and what the next check-in gives.
  checkin(id, at = new Date()) {
    const today = dayOf(at);
    const last = this.db.prepare("SELECT day, streak FROM checkins WHERE user_id=? ORDER BY day DESC LIMIT 1").get(id);
    const done = last?.day === today;
    const alive = last && (done || last.day === dayOf(new Date(at.getTime() - 86400000)));
    const streak = alive ? last.streak : 0;
    const next = done ? streak : streak + 1;
    return { today: done, streak, amount: CHECKIN_WEEK[(next - 1) % 7], position: ((next - 1) % 7) + 1, week: CHECKIN_WEEK, expireDays: CHECKIN_EXPIRE_DAYS };
  }
  doCheckin(id, at = new Date()) {
    return this.store.transaction(() => {
      const state = this.checkin(id, at);
      if (state.today) throw new AppError("今天已经签到过了", 409);
      const today = dayOf(at);
      const streak = state.streak + 1;
      this.db.prepare("INSERT INTO checkins(user_id,day,streak,amount) VALUES(?,?,?,?)").run(id, today, streak, state.amount);
      this.db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(state.amount, id);
      this.db.prepare("INSERT INTO ledger(job_id,kind,amount,created_at,user_id) VALUES(?,?,?,?,?)").run(`连续第 ${streak} 天·${today}·${id}`, "checkin", state.amount, at.toISOString(), id);
      return { got: state.amount, ...this.checkin(id, at), balance: this.get(id).balance };
    });
  }
  // Check-in credits lapse after 30 days. Spending uses them first (oldest first), so only what
  // was never spent lapses: old check-in credits − everything spent since the first check-in − already lapsed.
  expire(id, at = new Date()) {
    const first = this.db.prepare("SELECT min(created_at) AS t FROM ledger WHERE user_id=? AND kind='checkin'").get(id)?.t;
    if (!first) return 0;
    const cutoff = new Date(at.getTime() - CHECKIN_EXPIRE_DAYS * 86400000).toISOString();
    const sum = (where, ...args) => this.db.prepare(`SELECT coalesce(sum(amount),0) AS n FROM ledger WHERE user_id=? AND ${where}`).get(id, ...args).n;
    const old = sum("kind='checkin' AND created_at < ?", cutoff);
    if (!old) return 0;
    const spent = Math.max(0, -sum("kind IN ('reserve','refund') AND created_at >= ?", first));
    const lapsed = -sum("kind='expire'");
    const due = Math.min(old - spent - lapsed, this.get(id)?.balance ?? 0);
    if (due <= 0) return 0;
    return this.store.transaction(() => {
      this.db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(due, id);
      this.db.prepare("INSERT OR REPLACE INTO ledger(job_id,kind,amount,created_at,user_id) VALUES(?,?,?,?,?)").run(`签到积分满 ${CHECKIN_EXPIRE_DAYS} 天·${at.toISOString()}·${id}`, "expire", -due, at.toISOString(), id);
      return due;
    });
  }
  // Has this account ever been topped up (a package or any positive grant)?
  paid(id) {
    return !!this.db.prepare("SELECT 1 FROM ledger WHERE user_id=? AND kind='grant' AND amount>0 LIMIT 1").get(id);
  }
  invites() {
    return this.db
      .prepare("SELECT * FROM invites ORDER BY created_at DESC")
      .all()
      .map((i) => ({ code: i.code, credits: i.credits, maxUses: i.max_uses, used: i.used, note: i.note, revoked: !!i.revoked, createdAt: i.created_at }));
  }
  createInvite({ credits = SIGNUP_CREDITS, maxUses = 10, note = "" } = {}) {
    credits = Number(credits);
    maxUses = Number(maxUses);
    if (!Number.isInteger(credits) || credits < 0 || credits > 10000) throw new AppError("赠送积分 0–10000");
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) throw new AppError("可用人数 1–1000");
    const code = inviteCode();
    this.db
      .prepare("INSERT INTO invites(code,credits,max_uses,note,created_at) VALUES(?,?,?,?,?)")
      .run(code, credits, maxUses, String(note || "").slice(0, 40), now());
    return code;
  }
  revokeInvite(code) {
    this.db.prepare("UPDATE invites SET revoked=1 WHERE code=?").run(String(code || ""));
  }
}
