import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { Users } from "./users.js";

export const SKILLS = {
  upscale: { name: "4K 清晰度提升", cost: 10 },
  product: { name: "电商产品图", cost: 10 },
  detail: { name: "详情页模块", cost: 10 },
  poster: { name: "海报 / 菜单", cost: 15 },
  interior: { name: "装修效果图", cost: 25 },
};
export { AppError };

// SQLite owns all job transitions and per-account credit accounting (wallets live in users).
export class Store {
  constructor(filename) {
    // How many jobs may wait or run at once: everyone together, and one account.
    this.queueLimit = Number(process.env.QUEUE_LIMIT) || 80;
    this.userLimit = Number(process.env.USER_JOB_LIMIT) || 6;
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
    if (this.inTransaction) return fn(); // already inside one: join it
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  balance(userId) {
    return this.db.prepare("SELECT balance FROM users WHERE id=?").get(userId)?.balance ?? 0;
  }
  account(userId) {
    this.users.expire(userId);
    return {
      balance: this.balance(userId),
      ledger: this.db
        .prepare(
          "SELECT job_id AS jobId,kind,amount,created_at AS createdAt FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100",
        )
        .all(userId)
        .map((l) => (l.kind === "grant" ? { ...l, note: l.jobId, jobId: null } : ["checkin", "expire"].includes(l.kind) ? { ...l, note: String(l.jobId || "").split("·")[0], jobId: null } : l)),
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
        instruction: j.params.redo ? "重新出了一张" : j.params.instruction,
        redo: !!j.params.redo,
        asset: j.manifest?.assets?.find((a) => ["image", "module"].includes(a.role))?.name || null,
        createdAt: j.createdAt,
      }));
  }
  // 4K versions made from this job's pictures (or from their fine-tunes).
  upscalesOf(jobIds) {
    if (!jobIds.length) return [];
    return this.db
      .prepare(`SELECT * FROM jobs WHERE source_id IN (${jobIds.map(() => "?").join(",")}) AND json_extract(params,'$.operation')='upscale' ORDER BY created_at DESC LIMIT 100`)
      .all(...jobIds)
      .map((r) => this.decode(r))
      .map((j) => ({ id: j.id, status: j.status, sourceId: j.sourceId, sourceAsset: j.params.sourceAsset, asset: j.manifest?.assets?.find((a) => ["image", "original"].includes(a.role))?.name || null }));
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
  // The next job to start, given what is running: accounts with fewer running jobs first, then
  // oldest first. Jobs not on the image API (local Codex) run one at a time.
  nextFair(running = []) {
    const queued = this.db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 200").all().map((r) => this.decode(r));
    const load = new Map();
    for (const j of running) load.set(j.userId, (load.get(j.userId) || 0) + 1);
    const api = (j) => j.params.providerMode === "api";
    const serialBusy = running.some((j) => !api(j));
    return queued
      .filter((j) => api(j) || !serialBusy)
      .map((j, order) => ({ j, order, load: load.get(j.userId) || 0 }))
      .sort((a, b) => a.load - b.load || a.order - b.order)[0]?.j || null;
  }
  // How many queued jobs are ahead of this one.
  ahead(job) {
    return this.db.prepare("SELECT count(*) AS n FROM jobs WHERE status='queued' AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM jobs WHERE id=?)))").get(job.createdAt, job.createdAt, job.id).n;
  }
  create(params, requestKey, { id = randomUUID(), sourceId = null, userId } = {}) {
    if (!userId) throw new AppError("请先登录", 401);
    return this.transaction(() => {
      const old = this.byKey(requestKey);
      if (old) {
        if (old.userId !== userId) throw new AppError("提交编号冲突，请刷新后重试", 409);
        return old;
      }
      if (params.reusedFrames?.length && sourceId) {
        const previous = this.decode(this.db.prepare("SELECT * FROM jobs WHERE source_id=? AND user_id=? AND json_type(params,'$.reusedFrames')='array' AND status IN ('queued','running','succeeded','partial') ORDER BY rowid DESC LIMIT 1").get(sourceId, userId));
        if (previous) return previous;
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
          .get().n >= this.queueLimit
      )
        throw new AppError("现在排队的人太多了，请过几分钟再提交", 429);
      if (
        this.db
          .prepare("SELECT count(*) AS n FROM jobs WHERE user_id=? AND status IN ('queued','running')")
          .get(userId).n >= this.userLimit
      )
        throw new AppError(`你已有 ${this.userLimit} 个任务在进行，请等它们完成后再提交`, 429);
      // Style-library covers are workspace maintenance, not a merchant generation.
      const cost = params.operation === "cover" ? 0 : SKILLS[params.skillId].cost * (count - (params.reusedFrames?.length || 0));
      this.users.expire(userId);
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
      if (params.reusedFrames?.length && params.suiteId) {
        for (const slot of ["shots", "detail"]) {
          const field = "$.jobs." + slot;
          this.db.prepare("UPDATE suites SET data=json_set(data,?,?), updated_at=? WHERE id=? AND user_id=? AND json_extract(data,?)=?").run(field,id,now,params.suiteId,userId,field,sourceId);
        }
      }
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
  partial(job, manifest, reason) {
    return this.transaction(() => {
      const current = this.get(job.id);
      if (!current || !["running","failed","cancelled"].includes(current.status)) return;
      // Historical failures already received their full refund.
      const refund = current.status === "running" ? Math.min(job.cost, manifest.missing.length * SKILLS[job.params.skillId].cost) : 0;
      const message = `已保留 ${job.params.count - manifest.missing.length}/${job.params.count} 张。待补：第 ${manifest.missing.map(i => i+1).join("、")} 张。` + (refund ? `已退 ${refund} 积分。` : "") + (reason || "");
      const now = new Date().toISOString();
      this.db.prepare("UPDATE jobs SET status='partial', phase='部分完成', error=?, manifest=?, updated_at=? WHERE id=?").run(message, JSON.stringify(manifest),now,job.id);
      if (refund) {
        this.db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(refund, job.userId);
        this.db.prepare("INSERT INTO ledger(job_id,kind,amount,created_at,user_id) VALUES(?,?,?,?,?)").run(job.id,"refund",refund,now,job.userId);
      }
    });
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
