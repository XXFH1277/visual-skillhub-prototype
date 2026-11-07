import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { Users } from "./users.js";

export const SKILLS = {
  upscale: { name: "4K 清晰度提升", cost: 10 },
  product: { name: "电商产品图", cost: 10 },
  detail: { name: "详情页模块", cost: 30 },
  poster: { name: "海报 / 菜单", cost: 15 },
  interior: { name: "装修效果图", cost: 25 },
};
export { AppError };

// SQLite owns all job transitions and per-account credit accounting (wallets live in users).
export class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS wallet (id INTEGER PRIMARY KEY CHECK(id=1), balance INTEGER NOT NULL CHECK(balance>=0));
      INSERT OR IGNORE INTO wallet VALUES(1,500);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, source_id TEXT,
        status TEXT NOT NULL, phase TEXT NOT NULL, params TEXT NOT NULL,
        cost INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        error TEXT, manifest TEXT);
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY, job_id TEXT, kind TEXT NOT NULL,
        amount INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(job_id,kind));
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,created_at);`);
    this.users = new Users(this);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  balance(userId) {
    return this.db.prepare("SELECT balance FROM users WHERE id=?").get(userId)?.balance ?? 0;
  }
  account(userId) {
    return {
      balance: this.balance(userId),
      ledger: this.db
        .prepare(
          "SELECT job_id AS jobId,kind,amount,created_at AS createdAt FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100",
        )
        .all(userId)
        .map((l) => (l.kind === "grant" ? { ...l, note: l.jobId, jobId: null } : l)),
    };
  }
  decode(row) {
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      sourceId: row.source_id,
      status: row.status,
      phase: row.phase,
      params: JSON.parse(row.params),
      cost: row.cost,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      error: row.error,
      manifest: row.manifest ? JSON.parse(row.manifest) : null,
    };
  }
  get(id) {
    return this.decode(
      this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id),
    );
  }
  byKey(key) {
    return this.decode(
      this.db.prepare("SELECT * FROM jobs WHERE request_key=?").get(key),
    );
  }
  // Fine-tuned versions made from a job's pictures (any depth), newest first.
  tweaksOf(jobId) {
    return this.db
      .prepare("SELECT * FROM jobs WHERE json_extract(params,'$.tweakOf.jobId')=? ORDER BY created_at DESC LIMIT 50")
      .all(jobId)
      .map((r) => this.decode(r))
      .map((j) => ({
        id: j.id,
        status: j.status,
        phase: j.phase,
        error: j.error,
        frame: j.params.tweakOf.frame,
        instruction: j.params.instruction,
        asset: j.manifest?.assets?.find((a) => ["image", "module"].includes(a.role))?.name || null,
        createdAt: j.createdAt,
      }));
  }
  list(userId) {
    return this.db
      .prepare("SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 100")
      .all(userId)
      .map((r) => this.decode(r));
  }
  next() {
    return this.decode(
      this.db
        .prepare(
          "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1",
        )
        .get(),
    );
  }
  create(params, requestKey, { id = randomUUID(), sourceId = null, userId } = {}) {
    if (!userId) throw new AppError("请先登录", 401);
    return this.transaction(() => {
      const old = this.byKey(requestKey);
      if (old) {
        if (old.userId !== userId) throw new AppError("提交编号冲突，请刷新后重试", 409);
        return old;
      }
      const count = params.count;
      if (
        !Object.hasOwn(SKILLS, params.skillId) ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 12
      )
        throw new AppError("无效的技能或张数");
      if (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')",
          )
          .get().n >= 5
      )
        throw new AppError("队列已满，请稍后提交", 429);
      if (
        this.db
          .prepare("SELECT count(*) AS n FROM jobs WHERE user_id=? AND status IN ('queued','running')")
          .get(userId).n >= 3
      )
        throw new AppError("你已有 3 个任务在排队，请等它们完成后再提交", 429);
      // Style-library covers are workspace maintenance, not a merchant generation.
      const cost = params.operation === "cover" ? 0 : SKILLS[params.skillId].cost * count;
      if (this.balance(userId) < cost)
        throw new AppError("积分不足，请联系管理员充值", 402);
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO jobs(id,request_key,source_id,status,phase,params,cost,created_at,updated_at,error,manifest,user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          requestKey,
          sourceId,
          "queued",
          "等待生成",
          JSON.stringify(params),
          cost,
          now,
          now,
          null,
          null,
          userId,
        );
      if (cost) {
        this.db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(cost, userId);
        this.db
          .prepare("INSERT INTO ledger(job_id,kind,amount,created_at,user_id) VALUES(?,?,?,?,?)")
          .run(id, "reserve", -cost, now, userId);
      }
      return this.get(id);
    });
  }
  start(id) {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET status='running',phase='生成底图',updated_at=? WHERE id=? AND status='queued'",
        )
        .run(new Date().toISOString(), id).changes > 0
    );
  }
  phase(id, phase) {
    this.db
      .prepare(
        "UPDATE jobs SET phase=?,updated_at=? WHERE id=? AND status='running'",
      )
      .run(phase, new Date().toISOString(), id);
  }
  succeed(id, manifest) {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET status='succeeded',phase='已完成',manifest=?,updated_at=? WHERE id=? AND status='running'",
        )
        .run(JSON.stringify(manifest), new Date().toISOString(), id).changes > 0
    );
  }
  fail(id, message, status = "failed") {
    return this.transaction(() => {
      const job = this.get(id);
      if (!job || !["queued", "running"].includes(job.status)) return false;
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE jobs SET status=?,phase=?,error=?,updated_at=? WHERE id=?",
        )
        .run(
          status,
          status === "cancelled" ? "已取消" : "生成失败",
          message,
          now,
          id,
        );
      if (job.cost) {
        this.db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(job.cost, job.userId);
        this.db
          .prepare("INSERT INTO ledger(job_id,kind,amount,created_at,user_id) VALUES(?,?,?,?,?)")
          .run(id, "refund", job.cost, now, job.userId);
      }
      return true;
    });
  }
  recover() {
    for (const row of this.db
      .prepare("SELECT id FROM jobs WHERE status='running'")
      .all())
      this.fail(row.id, "服务重启中断了生成，积分已退回，请重新生成");
  }
  close() {
    this.db.close();
  }
}
