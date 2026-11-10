import { sendImage } from "./preview.js";
import express from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { Store, SKILLS, AppError } from "./store.js";
import { normalizeUpload, regularFile, deliver, partialDelivery } from "./media.js";
import { setUsageSink, withUsage } from "./usage.js";
import { JobQueue } from "./queue.js";
import { createProviders } from "./providers.js";
import { createTextAI, compareTexts } from "./text-ai.js";
import { sanitizeFrames, candidatesFor } from "./planner.js";
import { StyleLibrary } from "./styles.js";
import { ADMIN_ID } from "./users.js";
import { registerSuites, SUITE_FILE_MB } from "./suites.js";
import { SCENES, textsForImage } from "../shared/scenes.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest();
const text = (value, max, label, required = false) => {
  if (value == null) value = "";
  if (typeof value !== "string" || value.length > max || (required && !value.trim()))
    throw new AppError(`${label}不能为空或超过 ${max} 字`);
  return value.trim();
};
const DRAFT_TTL = 24 * 60 * 60 * 1000;

function draftInput(body, existing = {}) {
  const skillId = body.skillId ?? existing.skillId;
  if (typeof skillId !== "string" || !Object.hasOwn(SCENES, skillId)) throw new AppError("请选择有效的场景");
  const scene = SCENES[skillId];
  const count = Number(body.count ?? existing.count ?? scene.defaultCount);
  const size = body.size ?? existing.size ?? scene.defaultSize;
  if (!scene.counts.includes(count)) throw new AppError(`${scene.name}可选 ${scene.counts.join(" / ")} ${scene.unit}`);
  if (!scene.sizes.includes(size)) throw new AppError("画幅无效");
  const styleId = body.styleId ?? existing.styleId ?? "";
  if (typeof styleId !== "string" || styleId.length > 40) throw new AppError("风格无效");
  return { skillId, copy: text(body.copy ?? existing.copy, 1500, "说明"), count, size, styleId };
}

export async function createWorkspace({
  dataDir = path.join(ROOT, ".data"),
  accessCode,
  runner,
  provider,
  providers,
  publicOrigin = process.env.PUBLIC_ORIGIN || "",
  ...options
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const jobsDir = path.join(dataDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const secretFile = path.join(dataDir, "access-code.txt");
  const secret =
    accessCode ||
    process.env.ACCESS_CODE ||
    (fs.existsSync(secretFile)
      ? fs.readFileSync(secretFile, "utf8").trim()
      : randomBytes(24).toString("base64url"));
  if (secret.length < 16) throw new Error("ACCESS_CODE 至少需要 16 个字符");
  if (!accessCode && !process.env.ACCESS_CODE && !fs.existsSync(secretFile))
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  const store = new Store(path.join(dataDir, "workspace.sqlite"));
  const users = store.users;
  if (!store.db.prepare("PRAGMA table_info(sessions)").all().some((c) => c.name === "user_id")) {
    store.db.exec("DROP TABLE sessions");
    store.db.exec("CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, user_id TEXT NOT NULL)");
  }
  const fingerprint = digest(secret).toString("hex");
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  if (
    store.db.prepare("SELECT value FROM settings WHERE key='access-code'").get()
      ?.value !== fingerprint
  ) {
    store.db.exec("DELETE FROM sessions");
    store.db
      .prepare("INSERT OR REPLACE INTO settings VALUES('access-code',?)")
      .run(fingerprint);
  }
  // Every model call: who it was for, which step, how long, how many tokens (when the API says).
  store.db.exec(`CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, model TEXT,
    purpose TEXT, suite_id TEXT, job_id TEXT, user_id TEXT, seconds INTEGER, images INTEGER,
    prompt_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER, detail TEXT)`);
  const usageInsert = store.db.prepare(
    "INSERT INTO ai_usage(at,kind,model,purpose,suite_id,job_id,user_id,seconds,images,prompt_tokens,completion_tokens,reasoning_tokens,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  setUsageSink((u) =>
    usageInsert.run(
      new Date().toISOString(), u.kind, u.model ?? null, u.purpose ?? null, u.suiteId ?? null, u.jobId ?? null, u.userId ?? null,
      u.seconds ?? null, u.images ?? null, u.promptTokens ?? null, u.completionTokens ?? null, u.reasoningTokens ?? null, u.detail ?? null,
    ),
  );
  const registry =
    providers ||
    createProviders({
      ...(runner ? { codexRun: runner } : {}),
      ...(provider ? { codexCheck: async () => provider } : {}),
    });
  await Promise.all([registry.check("codex"), registry.check("api")]);
  let providerMode =
    store.db
      .prepare("SELECT value FROM settings WHERE key='generation-provider'")
      .get()?.value || registry.defaultMode;
  if (registry.apiOnly) providerMode = "api";
  registry.validate(providerMode);
  const textAI =
    options.textAI ||
    createTextAI({ codexReady: () => registry.describe("codex").ready });
  await textAI.check?.();
  // After generation: let the vision model read back text the image model drew.
  const proofread = (job, dir, signal, phase) =>
    withUsage({ jobId: job.id, suiteId: job.params.suiteId || null, userId: job.userId || null, purpose: "proofread" }, () => proofreadNow(job, dir, signal, phase));
  const proofreadNow = async (job, dir, signal, phase) => {
    const p = job.params;
    if (!p.frames || !textAI.describe().ready) return;
    const targets = p.frames.map((f, i) => [i, textsForImage(p.skillId, f)]).filter(([, t]) => t.length);
    if (!targets.length) return;
    phase("核对图中文字");
    // A few reads at a time, one retry each: a flaky call shouldn't leave a picture unchecked.
    const check = async ([i, expected]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const seen = await textAI.readTexts(path.join(dir, `result-${i + 1}.png`), { signal });
          return { frame: i, ...compareTexts(expected, seen) };
        } catch (error) {
          if (signal.aborted) throw error;
          if (attempt >= 1) {
            console.warn(`文字校对失败（第 ${i + 1} 张）：${error.message}`);
            return { frame: i, ok: null, error: "文字校对暂不可用" };
          }
        }
      }
    };
    const results = [];
    for (let k = 0; k < targets.length; k += 3) results.push(...(await Promise.all(targets.slice(k, k + 3).map(check))));
    await fsp.writeFile(path.join(dir, "text-check.json"), JSON.stringify(results));
  };
  let styles;
  const afterSuccess = async (job, manifest, dir) => {
    if (job.params.operation !== "cover") return;
    const asset = manifest.assets.find((a) => a.role === "image");
    if (asset) await styles.setCover(job.params.styleId, path.join(dir, manifest.exportId, asset.name));
  };
  const queue = new JobQueue(store, jobsDir, registry.run, proofread, afterSuccess);
  for (const row of store.db.prepare("SELECT id FROM jobs WHERE status IN ('failed','cancelled') AND manifest IS NULL AND json_extract(params,'$.count')>1 AND json_extract(params,'$.providerMode')='api'").all()) {
    const job = store.get(row.id);
    const partial = await partialDelivery(job, path.join(jobsDir, row.id));
    if (partial) store.partial(job, partial, job.error);
  }
  const draftsDir = path.join(dataDir, "drafts");
  fs.mkdirSync(draftsDir, { recursive: true });
  const app = express();
  app.disable("x-powered-by");
  const publicURL = publicOrigin ? new URL(publicOrigin) : null;
  if (publicURL && publicURL.protocol !== "https:")
    throw new Error("PUBLIC_ORIGIN 必须是 HTTPS 地址");
  const allowedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...(publicURL ? [publicURL.hostname] : []),
  ]);
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (!allowedHosts.has(req.hostname))
      return res
        .status(403)
        .json({ error: "当前域名未配置，请在服务器设置 PUBLIC_ORIGIN" });
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("X-Requested-With") !== "SkillHub"
    )
      return res.status(403).json({ error: "无效的请求来源" });
    const origin = req.get("Origin");
    if (origin) {
      try {
        const o = new URL(origin);
        const local =
          ["localhost", "127.0.0.1", "[::1]"].includes(o.hostname) &&
          o.host === req.get("Host") &&
          o.protocol === "http:";
        if (!local && o.origin !== publicURL?.origin)
          return res.status(403).json({ error: "请求来源不匹配" });
      } catch {
        return res.status(403).json({ error: "无效的请求来源" });
      }
    }
    next();
  });
  app.use(express.json({ limit: "96kb" }));
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict",
    secure: !!publicURL,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
  const cookie = (req) =>
    req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("vsh_session="))
      ?.slice(12) || "";
  const auth = (req, res, next) => {
    const hash = digest(cookie(req)).toString("hex");
    const row = store.db
      .prepare("SELECT user_id FROM sessions WHERE hash=? AND expires>?")
      .get(hash, Date.now());
    const user = row && users.get(row.user_id);
    if (!user) return res.status(401).json({ error: "请先登录" });
    req.user = user;
    next();
  };
  const adminOnly = (req, _res, next) => {
    if (req.user?.role !== "admin") throw new AppError("只有管理员可以操作", 403);
    next();
  };
  // Per-IP and per-account sliding windows for password guessing and sign-up spam.
  const windows = new Map();
  const limit = (key, max, ms = 60_000) => {
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.started > ms) return void windows.set(key, { started: now, n: 1 });
    if (++w.n > max) throw new AppError("尝试次数过多，请稍后再试", 429);
  };
  const limitTimer = setInterval(() => {
    for (const [k, w] of windows) if (Date.now() - w.started > 10 * 60_000) windows.delete(k);
  }, 60_000);
  limitTimer.unref();
  const startSession = (res, userId) => {
    const token = randomBytes(32).toString("base64url");
    store.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(digest(token).toString("hex"), Date.now() + cookieOptions.maxAge, userId);
    users.touch(userId);
    res.cookie("vsh_session", token, cookieOptions).json({ ok: true });
  };
  app.post("/api/login", (req, res) => {
    limit("login:" + req.ip, 10);
    limit("login", 60);
    // The workspace access code still opens the admin account (setup, recovery).
    if (req.body?.code != null) {
      const supplied = typeof req.body.code === "string" ? req.body.code : "";
      if (!timingSafeEqual(digest(supplied), digest(secret)))
        throw new AppError("访问码不正确", 401);
      return startSession(res, ADMIN_ID);
    }
    limit("login-phone:" + String(req.body?.phone || ""), 8, 10 * 60_000);
    startSession(res, users.verify(req.body?.phone, req.body?.password).id);
  });
  app.post("/api/register", (req, res) => {
    limit("register:" + req.ip, 20, 10 * 60_000);
    limit("register", 60, 10 * 60_000);
    const user = users.register(req.body || {});
    startSession(res, user.id);
  });
  const instanceId = process.env.SKILLHUB_INSTANCE_ID || randomUUID();
  app.get("/api/health", (_req, res) => res.json({ ok: true, instanceId }));
  app.use("/api", auth);
  app.post("/api/logout", (req, res) => {
    store.db
      .prepare("DELETE FROM sessions WHERE hash=?")
      .run(digest(cookie(req)).toString("hex"));
    res
      .set("Clear-Site-Data", '"cache"')
      .clearCookie("vsh_session", { ...cookieOptions, maxAge: undefined })
      .json({ ok: true });
  });
  app.get("/api/workspace", (req, res) =>
    res.json({
      user: users.view(req.user),
      account: store.account(req.user.id),
      skills: SKILLS,
      provider: registry.describe(providerMode),
      providers: registry.list(),
      textAI: textAI.describe(),
      mode: "accounts",
    }),
  );
  app.post("/api/me/password", (req, res) => {
    limit("password:" + req.user.id, 5, 10 * 60_000);
    if (req.user.pass) users.verify(req.user.phone, req.body?.old);
    users.setPassword(req.user.id, req.body?.password);
    res.json({ ok: true });
  });
  app.post("/api/me/phone", adminOnly, (req, res) => {
    users.setPhone(req.user.id, req.body?.phone);
    res.json(users.view(users.get(req.user.id)));
  });
  // ---- Admin: accounts, invite codes, top-ups ----
  app.use("/api/admin", adminOnly);
  app.get("/api/admin", (_req, res) => res.json({ users: users.list(), invites: users.invites() }));
  // Which image models the relay offers, and a one-off test of any of them (SVG, transparent, ...).
  app.get("/api/admin/image-models", async (_req, res) => {
    await registry.check("api");
    res.json({ models: registry.allModels(), configured: registry.describe("api").modelsByResolution });
  });
  app.post("/api/admin/image-probe", async (req, res) => {
    const b = req.body || {};
    const model = String(b.model || "");
    if (!/^[\w.\-]{3,60}$/.test(model)) throw new AppError("模型名无效");
    const format = ["png", "jpeg", "webp", "svg"].includes(b.format) ? b.format : "png";
    const size = /^\d{3,4}x\d{3,4}$/.test(b.size || "") ? b.size : "1024x1024";
    const prompt = String(b.prompt || "").slice(0, 2000) || "一个简洁的海鲜品牌 logo：一只橙红色的虾和一道蓝色浪花，扁平矢量风格，下方写“鲜海记”三个字，白色背景";
    const r = await registry.probe({ model, prompt, size, format, background: b.background === "transparent" ? "transparent" : undefined });
    if (r.bytes) {
      const dir = path.join(dataDir, "probe");
      await fsp.mkdir(dir, { recursive: true });
      r.file = `${model}-${Date.now()}.${r.kind === "unknown" ? "bin" : r.kind}`;
      await fsp.writeFile(path.join(dir, r.file), r.bytes);
      r.size = r.bytes.length;
      if (r.kind === "svg") r.svgHead = r.bytes.subarray(0, 400).toString("utf8");
      delete r.bytes;
    }
    res.json(r);
  });
  // Try another text/vision model on the Kimi key: plain answer, then reading a picture with text.
  app.post("/api/admin/text-probe", async (req, res) => {
    const model = String(req.body?.model || "");
    if (!/^[\w.\-]{3,60}$/.test(model)) throw new AppError("模型名无效");
    if (!textAI.probe) throw new AppError("当前文字模型不支持试跑");
    const out = { model };
    try {
      out.text = await withUsage({ purpose: "probe" }, () => textAI.probe(model));
    } catch (error) {
      out.textError = error.message;
      return res.json(out);
    }
    // A bundled style sample with a Chinese headline: does it see images and read the text right?
    const sample = styles.coverFile(String(req.body?.image || "promo-bold")) || styles.coverFile("appetite");
    if (sample)
      try {
        out.vision = await withUsage({ purpose: "probe" }, () => textAI.probe(model, { image: sample }));
      } catch (error) {
        out.visionError = error.message;
      }
    res.json(out);
  });
  // Token / call report: per product (suite) and step, or the latest calls.
  app.get("/api/admin/usage", (req, res) => {
    const suiteId = String(req.query.suite || "");
    const where = suiteId ? "WHERE suite_id = ?" : "WHERE at >= datetime('now','-7 days')";
    const args = suiteId ? [suiteId] : [];
    const byStep = store.db
      .prepare(`SELECT kind, purpose, model, count(*) AS calls, sum(images) AS images, sum(seconds) AS seconds,
        sum(prompt_tokens) AS promptTokens, sum(completion_tokens) AS completionTokens, sum(reasoning_tokens) AS reasoningTokens
        FROM ai_usage ${where} GROUP BY kind, purpose, model ORDER BY kind, purpose`)
      .all(...args);
    const latest = store.db.prepare(`SELECT * FROM ai_usage ${where} ORDER BY id DESC LIMIT 40`).all(...args);
    res.json({ byStep, latest });
  });
  app.get("/api/admin/probe/:file", async (req, res) => {
    res.sendFile(await regularFile(path.join(dataDir, "probe"), req.params.file), { dotfiles: "allow" });
  });
  app.post("/api/admin/invites", (req, res) => res.json({ code: users.createInvite(req.body || {}), invites: users.invites() }));
  app.post("/api/admin/invites/:code/revoke", (req, res) => {
    users.revokeInvite(req.params.code);
    res.json({ invites: users.invites() });
  });
  app.post("/api/admin/users/:id/grant", (req, res) => res.json(users.grant(req.params.id, Number(req.body?.amount), req.body?.note)));
  app.post("/api/admin/users/:id/password", (req, res) => {
    if (!users.get(req.params.id)) throw new AppError("账号不存在", 404);
    users.setPassword(req.params.id, req.body?.password);
    store.db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/provider/check", adminOnly, async (req, res) => {
    res.json(await registry.check(req.body?.mode || providerMode));
  });
  app.post("/api/provider", adminOnly, (req, res) => {
    const mode = req.body?.mode;
    registry.validate(mode);
    if (!registry.describe(mode).ready)
      throw new AppError("此生成模式尚未就绪，请先重新检查", 409);
    store.db
      .prepare(
        "INSERT OR REPLACE INTO settings VALUES('generation-provider',?)",
      )
      .run(mode);
    providerMode = mode;
    res.json(registry.describe(mode));
  });
  // Every /api/jobs/:id/... route only ever sees the caller's own jobs.
  app.use("/api/jobs/:id", (req, _res, next) => {
    const job = store.get(req.params.id);
    if (!job || job.userId !== req.user.id) throw new AppError("任务不存在", 404);
    next();
  });
  app.get("/api/jobs", (req, res) => res.json({ jobs: store.list(req.user.id) }));
  app.get("/api/jobs/:id", (req, res) => res.json({ ...store.get(req.params.id), tweaks: store.tweaksOf(req.params.id) }));
  let uploading = 0;
  const admission = (req, res, next) => {
    const key = req.get("Idempotency-Key");
    if (!key || !/^[a-zA-Z0-9-]{16,100}$/.test(key))
      return res.status(400).json({ error: "缺少有效的提交编号" });
    const old = store.byKey(key);
    if (old) {
      if (old.userId !== req.user.id) return res.status(409).json({ error: "提交编号冲突，请刷新后重试" });
      return res.status(200).json(old);
    }
    next();
  };
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 4, fields: 16, parts: 20, fieldSize: 8192 },
    fileFilter: (_req, file, done) =>
      done(
        ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)
          ? null
          : new AppError("只支持 PNG、JPEG 和 WebP"),
        true,
      ),
  }).fields([
    { name: "main", maxCount: 1 },
    { name: "reference", maxCount: 3 },
  ]);

  // ---- Style library ----
  styles = new StyleLibrary(store, dataDir);
  let extracting = 0;
  app.use("/api/styles/:id", (req, _res, next) => {
    if (!styles.get(req.params.id, req.user)) throw new AppError("风格不存在", 404);
    next();
  });
  app.get("/api/styles", (req, res) => res.json({ styles: styles.list(req.user) }));
  app.get("/api/styles/:id", (req, res) => res.json(styles.get(req.params.id, req.user)));
  app.get("/api/styles/:id/cover", async (req, res) => {
    if (!styles.get(req.params.id, req.user)) throw new AppError("风格不存在", 404);
    const file = styles.coverFile(req.params.id);
    if (!file) throw new AppError("没有样图", 404);
    await sendImage(req, res, file, dataDir, { mutable: true });
  });
  const styleUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, fieldSize: 8192 },
    fileFilter: (_req, file, done) =>
      done(["image/png", "image/jpeg", "image/webp"].includes(file.mimetype) ? null : new AppError("只支持 PNG、JPEG 和 WebP"), true),
  }).single("image");
  app.post("/api/styles", styleUpload, async (req, res) => {
    if (!req.file) throw new AppError("请上传一张样图");
    if (extracting >= 2) throw new AppError("正在分析其他样图，请稍后", 429);
    const prompt = text(req.body?.prompt, 2000, "提示词");
    const name = text(req.body?.name, 16, "风格名");
    const id = styles.create({ name: name || "分析中…", prompt }, req.user.id);
    const file = path.join(styles.dir, `${id}.png`);
    try {
      await normalizeUpload(req.file.buffer, file);
    } catch (error) {
      await styles.remove(id, req.user).catch(() => {});
      throw error;
    }
    extracting++;
    (async () => {
      try {
        if (!textAI.describe().ready) throw new Error("未配置 Kimi，无法自动拆解；可手动填写配方");
        const recipe = await textAI.extractStyle(file, prompt);
        styles.finish(id, { ...recipe, ...(name ? { name } : {}) });
      } catch (error) {
        styles.finish(id, null, "风格拆解失败：" + error.message);
      } finally {
        extracting--;
      }
    })();
    res.status(202).json(styles.get(id, req.user));
  });
  app.post("/api/styles/:id", (req, res) => res.json(styles.update(req.params.id, req.body || {}, req.user)));
  app.post("/api/styles/:id/share", adminOnly, (req, res) => {
    styles.editable(req.params.id, req.user);
    styles.share(req.params.id, !!req.body?.shared);
    res.json(styles.get(req.params.id, req.user));
  });
  app.delete("/api/styles/:id", async (req, res) => {
    await styles.remove(req.params.id, req.user);
    res.json({ ok: true });
  });
  // Cover samples for built-in styles go through the normal pipeline (free of credits).
  function coverParams(s) {
    if (s.source !== "builtin") throw new AppError("上传的风格已经有样图");
    if (s.types.includes("interior")) throw new AppError("装修风格需要现场照片，暂不生成样图");
    const scene = s.types.includes("main") ? "product" : "poster";
    const texts = s.sample?.headline ? [{ role: "headline", text: s.sample.headline }] : [];
    return {
      version: 3,
      operation: "cover",
      styleId: s.id,
      skillId: scene,
      productName: `风格样图 · ${s.name}`,
      size: "3:4",
      count: 1,
      inputs: [],
      hasMainImage: false,
      refCount: 0,
      styleRef: null,
      brandColor: "#e8541e",
      direction: { conceptName: s.name, styleName: s.name, story: s.tagline, palette: s.palette, props: s.props, light: s.light, camera: s.camera, type: s.type, layout: s.layout, avoid: s.avoid, core: s.core },
      frames: [
        {
          title: "风格样图",
          layout: texts.length ? "free" : "none",
          textMode: texts.length ? "ai" : "none",
          texts,
          scene: `主体是一件无品牌的${s.sample?.product || "商品"}（不要出现任何真实品牌或 Logo），按视觉系统完整呈现这个风格最有代表性的画面，构图完整、质感高级。`,
        },
      ],
    };
  }
  app.post("/api/styles/:id/cover", adminOnly, admission, async (req, res) => {
    await createJob(req, res, coverParams(styles.ready(req.params.id)), null);
  });
  // Batch: queue every missing cover, feeding the job queue a few at a time.
  let coverBacklog = [];
  let coverMode = "codex";
  const coverActive = () =>
    store.db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')").get().n;
  const feedCovers = async () => {
    while (coverBacklog.length && coverActive() < 2) {
      const id = coverBacklog.shift();
      const s = styles.get(id);
      if (!s || s.cover) continue;
      const fake = { body: { providerMode: coverMode }, user: users.get(ADMIN_ID), get: () => "cover-" + id + "-" + randomUUID() };
      const sink = { status: () => sink, json: () => {} };
      await createJob(fake, sink, coverParams(s), null).catch((error) => console.error("样图任务创建失败：", id, error.message));
    }
  };
  const coverTimer = setInterval(() => feedCovers().catch(() => {}), 5000);
  coverTimer.unref();
  app.post("/api/styles-covers", adminOnly, (req, res) => {
    coverMode = req.body?.providerMode === "api" ? "api" : "codex";
    const missing = styles.list().filter((s) => s.source === "builtin" && !s.cover && !s.types.includes("interior")).map((s) => s.id);
    coverBacklog = [...new Set([...coverBacklog, ...missing])];
    feedCovers().catch(() => {});
    res.json({ queued: coverBacklog.length, missing: missing.length });
  });
  app.get("/api/styles-covers", adminOnly, (_req, res) => res.json({ pending: coverBacklog.length }));

  // ---- Drafts: upload → AI directions → choose → storyboard → confirm ----
  const drafts = new Map();
  let thinking = 0;
  const draftView = (d) => ({
    id: d.id,
    status: d.status,
    input: d.input,
    hasMainImage: d.hasMainImage,
    analysis: d.result?.analysis || null,
    polishedCopy: d.result?.polishedCopy || "",
    directions: d.result?.directions || [],
    chosen: d.chosen ?? null,
    frames: d.frames || null,
    via: d.via,
    warning: d.warning,
    error: d.error,
  });
  const imagesOf = (d) => d.inputs.map((n) => path.join(d.dir, n));
  async function think(d, status, fn) {
    d.status = status;
    d.error = d.warning = null;
    thinking++;
    try {
      await fn();
    } catch (error) {
      Object.assign(d, { status: "failed", error: "AI 处理失败：" + error.message });
    } finally {
      thinking--;
    }
  }
  const analyze = (d) =>
    think(d, "analyzing", async () => {
      const candidates = candidatesFor(styles.list(users.get(d.userId)), d.input.skillId);
      const r = await textAI.analyze({ ...d.input, hasMain: d.hasMainImage, hasReference: d.refCount > 0 }, imagesOf(d), candidates);
      Object.assign(d, { status: "directions", result: r.result, via: r.via, warning: r.warning || null, chosen: null, frames: null });
    });
  const storyboard = (d) =>
    think(d, "storyboarding", async () => {
      const chosen = d.result.directions[d.chosen];
      const r = await textAI.storyboard({ ...d.input, hasMain: d.hasMainImage }, imagesOf(d), d.result, chosen);
      Object.assign(d, { status: "ready", frames: r.frames, via: r.via, warning: r.warning || null });
    });
  const getDraft = (id, user) => {
    const d = drafts.get(id);
    if (!d || Date.now() - d.createdAt > DRAFT_TTL || d.userId !== user?.id) throw new AppError("草稿已过期，请重新上传", 404);
    return d;
  };
  const busyDraft = (d) => ["analyzing", "storyboarding"].includes(d.status);
  const sweepDrafts = async () => {
    for (const [id, d] of drafts) if (Date.now() - d.createdAt > DRAFT_TTL) drafts.delete(id);
    for (const name of await fsp.readdir(draftsDir).catch(() => []))
      if (!drafts.has(name)) await fsp.rm(path.join(draftsDir, name), { recursive: true, force: true });
  };
  await sweepDrafts();
  const sweeper = setInterval(() => sweepDrafts().catch(() => {}), 60 * 60 * 1000);
  sweeper.unref();

  app.post("/api/drafts", (req, res, next) => {
    if (uploading >= 2 || thinking >= 3) return res.status(429).json({ error: "正在处理其他请求，请稍后重试" });
    uploading++;
    let done = false;
    const release = () => {
      if (!done) {
        done = true;
        uploading--;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  }, upload, async (req, res) => {
    const input = draftInput(req.body || {});
    if (input.styleId) styles.ready(input.styleId, req.user);
    const scene = SCENES[input.skillId];
    const hasMainImage = !!req.files?.main?.length;
    if (scene.mainRequired && !hasMainImage) throw new AppError(`请上传${scene.mainLabel}`);
    const id = randomUUID();
    const dir = path.join(draftsDir, id);
    await fsp.mkdir(dir);
    try {
      const inputs = [];
      for (const [index, file] of [...(req.files?.main || []), ...(req.files?.reference || [])].entries()) {
        const name = `input-${index}.png`;
        await normalizeUpload(file.buffer, path.join(dir, name));
        inputs.push(name);
      }
      const d = { id, userId: req.user.id, dir, input, hasMainImage, inputs, refCount: req.files?.reference?.length || 0, createdAt: Date.now() };
      drafts.set(id, d);
      analyze(d);
      res.status(202).json(draftView(d));
    } catch (error) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw error;
    }
  });
  app.get("/api/drafts/:id", (req, res) => res.json(draftView(getDraft(req.params.id, req.user))));
  // New directions ("换一批"), optionally with updated note/count/size.
  app.post("/api/drafts/:id/replan", (req, res) => {
    const d = getDraft(req.params.id, req.user);
    if (busyDraft(d)) return res.json(draftView(d));
    if (thinking >= 3) throw new AppError("正在处理其他请求，请稍后重试", 429);
    d.input = draftInput({ ...req.body, skillId: d.input.skillId }, d.input);
    analyze(d);
    res.json(draftView(d));
  });
  // Pick a direction (or re-run the storyboard for the same one).
  app.post("/api/drafts/:id/choose", (req, res) => {
    const d = getDraft(req.params.id, req.user);
    if (busyDraft(d)) throw new AppError("AI 还在处理，请稍候", 409);
    if (!d.result) throw new AppError("请先等 AI 给出方向");
    const index = req.body?.index;
    if (!Number.isInteger(index) || !d.result.directions[index]) throw new AppError("请选择一个方向");
    if (thinking >= 3) throw new AppError("正在处理其他请求，请稍后重试", 429);
    d.chosen = index;
    storyboard(d);
    res.json(draftView(d));
  });
  app.get("/api/drafts/:id/input/:n", async (req, res) => {
    const d = getDraft(req.params.id, req.user);
    const name = d.inputs[Number(req.params.n)];
    if (!name) throw new AppError("文件不存在", 404);
    await sendImage(req, res, await regularFile(d.dir, name), dataDir);
  });

  async function prepareJob(dir, params, sourceDir, extra = {}) {
    for (const name of params.inputs)
      await fsp.copyFile(Object.hasOwn(extra, name) ? extra[name] : await regularFile(sourceDir, name), path.join(dir, name));
    if (params.styleRef && sourceDir) await fsp.copyFile(await regularFile(sourceDir, params.styleRef), path.join(dir, params.styleRef));
    else if (!params.reusedFrames && params.styleId && params.operation !== "cover") {
      const cover = styles.coverFile(params.styleId);
      if (cover) {
        await fsp.copyFile(cover, path.join(dir, "style-ref.png"));
        params.styleRef = "style-ref.png";
      } else params.styleRef = null;
    }
  }
  async function createJob(req, res, params, sourceDir, sourceId = null, extra = {}) {
    Object.assign(
      params,
      params.operation === "cover"
        ? registry.selection(
            req.body?.providerMode === "api" || !registry.describe("codex").ready
              ? { providerMode: "api", resolution: "1K", size: params.size }
              : { providerMode: "codex", size: params.size },
            providerMode,
          )
        : registry.selection({ providerMode: req.body?.providerMode, resolution: req.body?.resolution, size: params.size }, providerMode),
    );
    const id = randomUUID(),
      dir = path.join(jobsDir, id);
    await fsp.mkdir(dir);
    try {
      await prepareJob(dir, params, sourceDir, extra);
      for (const i of params.reusedFrames || []) {
        const name = `result-${i+1}.png`;
        await fsp.copyFile(await regularFile(sourceDir,name),path.join(dir,name));
      }
      const job = store.create(params, req.get("Idempotency-Key"), { id, sourceId, userId: req.user.id });
      if (job.id !== id) await fsp.rm(dir, { recursive: true, force: true });
      res.status(202).json(job);
      queue.kick();
    } catch (error) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  const nameFrom = (frames, skillId, direction) =>
    (frames[0]?.texts.find((t) => t.role === "headline")?.text || direction?.conceptName || SCENES[skillId].name).slice(0, 40);

  app.post("/api/jobs", admission, async (req, res) => {
    const d = getDraft(String(req.body?.draftId || ""), req.user);
    if (d.status !== "ready" || !d.frames) throw new AppError("请先选定方向并等分镜完成");
    const frames = sanitizeFrames(req.body?.frames, d.input.skillId, d.input.count, { strict: true });
    const direction = d.result.directions[d.chosen];
    const params = {
      version: 3,
      skillId: d.input.skillId,
      productName: text(req.body?.productName, 40, "作品名称") || nameFrom(frames, d.input.skillId, direction),
      copy: d.input.copy,
      size: d.input.size,
      count: frames.length,
      frames,
      direction,
      styleId: direction.styleId === "ref" ? null : direction.styleId,
      analysis: d.result.analysis,
      brandColor: direction.palette?.[2] || "#e8541e",
      hasMainImage: d.hasMainImage,
      refCount: d.refCount,
      inputs: [...d.inputs],
      planVia: d.via,
    };
    await createJob(req, res, params, d.dir);
  });
  // Regenerate the whole job, or a single frame (optionally with exact program text).
  app.post("/api/jobs/:id/retry", admission, async (req, res) => {
    const source = store.get(req.params.id);
    if (!source) throw new AppError("任务不存在", 404);
    if (["queued", "running"].includes(source.status)) throw new AppError("请等待当前任务结束");
    if (["upscale", "cover"].includes(source.params.operation)) throw new AppError("这类任务请从原处重新发起");
    if (!source.params.frames) throw new AppError("这是旧版任务，请用新流程重新创建");
    let frames = source.params.frames;
    const index = req.body?.frame;
    if (index != null) {
      if (!Number.isInteger(index) || !frames[index]) throw new AppError("图片序号无效");
      const frame = { ...frames[index] };
      if (req.body?.textMode === "overlay" && frame.texts.length) {
        frame.textMode = "overlay";
        frame.layout = ["top", "bottom", "left", "right", "center"].includes(frame.layout) ? frame.layout : "top";
      }
      frames = [frame];
    }
    const params = { ...source.params, frames, count: frames.length };
    delete params.reusedFrames;
    if (source.status === "partial" && index == null) {
      params.reusedFrames = source.manifest.assets.filter(a => ["image","module"].includes(a.role)).map(a => a.frame);
      req.body = { providerMode: "api", resolution: source.params.resolution };
    }
    for (const k of ["imageModel", "resolution", "requestedSize"]) delete params[k];
    if (index != null) params.productName = `${source.params.productName.slice(0, 30)} · 第${index + 1}张重出`;
    req.body = { providerMode: source.params.providerMode, resolution: source.params.resolution, ...req.body };
    await createJob(req, res, params, path.join(jobsDir, source.id), source.id);
  });
  // Fine-tune one finished image: it becomes the base, the merchant says what to change.
  app.post("/api/jobs/:id/tweak", admission, async (req, res) => {
    const source = store.get(req.params.id);
    if (!["succeeded", "partial"].includes(source.status)) throw new AppError("请等这张图生成完成后再微调");
    if (["upscale", "cover"].includes(source.params.operation) || !source.params.frames) throw new AppError("这张图不支持微调");
    const index = req.body?.frame;
    if (!Number.isInteger(index) || !source.params.frames[index]) throw new AppError("图片序号无效");
    if (source.status === "partial" && !source.manifest?.assets.some(a => a.frame === index && ["image", "module"].includes(a.role)))
      throw new AppError("这张图尚未生成，请先补图");
    const instruction = text(req.body?.instruction, 300, "修改要求");
    let frame = { ...source.params.frames[index] };
    delete frame.photos;
    delete frame.photoNotes;
    let textsChanged = false;
    if (Array.isArray(req.body?.texts)) {
      const next = sanitizeFrames([{ ...frame, texts: req.body.texts }], source.params.skillId, 1, { strict: true })[0];
      textsChanged = JSON.stringify(next.texts) !== JSON.stringify(frame.texts);
      frame = { ...frame, ...next };
    }
    if (!instruction && !textsChanged) throw new AppError("说一下想怎么改，或者改一下图上的字");
    const base = await regularFile(path.join(jobsDir, source.id), `result-${index + 1}.png`);
    // Chained tweaks all point back at the original picture.
    const root = source.params.tweakOf || { jobId: source.id, frame: index };
    const rootName = source.params.tweakOf ? source.params.rootName : source.params.productName;
    const params = {
      ...source.params,
      reusedFrames: undefined,
      operation: "tweak",
      instruction: instruction || "只把画面中的文字改成下面【文字】里的内容，其他一切不变。",
      frames: [frame],
      count: 1,
      inputs: ["tweak-base.png"],
      hasMainImage: false,
      refCount: 0,
      styleRef: null,
      styleId: null,
      tweakOf: root,
      tweakFrom: { jobId: source.id, frame: index },
      rootName,
      productName: `${String(rootName).slice(0, 26)} · 第${root.frame + 1}张微调`,
    };
    for (const k of ["imageModel", "resolution", "requestedSize"]) delete params[k];
    req.body = { providerMode: source.params.providerMode, resolution: source.params.resolution, ...req.body };
    await createJob(req, res, params, null, source.id, { "tweak-base.png": base });
  });
  registerSuites({ app, store, users, styles, dataDir, textAI, normalizeUpload, regularFile, admission, createJob, jobsDir });
  app.post("/api/jobs/:id/upscale", admission, async (req, res) => {
    const source = store.get(req.params.id);
    if (!source || source.status !== "succeeded")
      throw new AppError("请先完成原图生成");
    const asset = source.manifest.assets.find(
      (a) =>
        a.name === req.body?.asset && ["image", "original"].includes(a.role),
    );
    if (!asset) throw new AppError("请选择可提升的单张原图");
    const choice = registry.upscaleSelection(asset.width, asset.height);
    const [targetWidth, targetHeight] = choice.requestedSize
      .split("x")
      .map(Number);
    if (asset.width >= targetWidth && asset.height >= targetHeight)
      throw new AppError("这张图片已达到目标尺寸，无需再次提升");
    const id = randomUUID(),
      dir = path.join(jobsDir, id);
    await fsp.mkdir(dir);
    try {
      const original = await regularFile(
        path.join(jobsDir, source.id, source.manifest.exportId),
        asset.name,
      );
      await fsp.copyFile(original, path.join(dir, "input-0.png"));
      const params = {
        ...choice,
        skillId: "upscale",
        productName: source.params.productName.slice(0, 50) + " · 4K 提升",
        platform: source.params.platform,
        size: source.params.size,
        count: 1,
        inputs: ["input-0.png"],
        sourceAsset: asset.name,
        sourceExportId: source.manifest.exportId,
      };
      const job = store.create(params, req.get("Idempotency-Key"), {
        id,
        sourceId: source.id,
        userId: req.user.id,
      });
      if (job.id !== id) await fsp.rm(dir, { recursive: true, force: true });
      res.status(202).json(job);
      queue.kick();
    } catch (error) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw error;
    }
  });
  app.post("/api/jobs/:id/cancel", (req, res) => {
    if (!store.get(req.params.id)) throw new AppError("任务不存在", 404);
    queue.cancel(req.params.id);
    res.json({ ok: true });
  });
  // Proofreading again for free (the vision model is sometimes unavailable right after generation).
  const rechecking = new Set();
  app.post("/api/jobs/:id/recheck", async (req, res) => {
    const job = store.get(req.params.id);
    if (!job || job.status !== "succeeded" || !job.params.frames) throw new AppError("该任务不能核对文字");
    if (rechecking.has(job.id)) throw new AppError("正在核对，请稍候", 409);
    rechecking.add(job.id);
    try {
      await proofread(job, path.join(jobsDir, job.id), AbortSignal.timeout(600000), () => {});
      const textCheck = JSON.parse(await fsp.readFile(path.join(jobsDir, job.id, "text-check.json"), "utf8").catch(() => "[]"));
      const fresh = store.get(job.id);
      store.db
        .prepare("UPDATE jobs SET manifest=?,updated_at=? WHERE id=?")
        .run(JSON.stringify({ ...fresh.manifest, textCheck }), new Date().toISOString(), job.id);
      res.json(store.get(job.id));
    } finally {
      rechecking.delete(job.id);
    }
  });
  // Free edits for text the program typesets (detail captions, overlay frames).
  const exportLocks = new Set();
  app.post("/api/jobs/:id/texts", async (req, res) => {
    const job = store.get(req.params.id);
    if (!job || job.status !== "succeeded" || !job.params.frames)
      throw new AppError("该任务不能修改文字");
    if (exportLocks.has(job.id)) throw new AppError("正在重新排版，请稍候", 409);
    const edits = req.body?.frames;
    if (!Array.isArray(edits) || edits.length !== job.params.frames.length)
      throw new AppError("文字格式错误");
    const merged = job.params.frames.map((f, i) => {
      const locked = textsForImage(job.params.skillId, f);
      if (!edits[i]) return f;
      const editable = f.texts.filter((t) => !locked.includes(t));
      if (!editable.length) return f;
      const next = sanitizeFrames([{ ...f, texts: [...locked, ...(edits[i].texts || [])] }], job.params.skillId, 1, { strict: true })[0];
      return { ...f, texts: next.texts };
    });
    exportLocks.add(job.id);
    try {
      const changed = { ...job, params: { ...job.params, frames: merged } };
      const manifest = await deliver(changed, path.join(jobsDir, job.id));
      store.db
        .prepare("UPDATE jobs SET params=?,manifest=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(changed.params), JSON.stringify(manifest), new Date().toISOString(), job.id);
      res.json(store.get(job.id));
    } finally {
      exportLocks.delete(job.id);
    }
  });
  app.get("/api/jobs/:id/files/:name", async (req, res) => {
    const job = store.get(req.params.id),
      name = req.params.name;
    if (
      !job ||
      !["succeeded","partial"].includes(job.status) ||
      !(
        name === "manifest.json" ||
        job.manifest.assets.some((a) => a.name === name)
      )
    )
      throw new AppError("文件不存在", 404);
    const file = await regularFile(
      path.join(jobsDir, job.id, job.manifest.exportId),
      name,
    );
    // Files are authorized above; .data is deliberately outside the public tree.
    if (req.query.download === "1")
      res.download(file, name, { dotfiles: "allow" });
    else if (name === "manifest.json") res.sendFile(file, { dotfiles: "allow" });
    else await sendImage(req, res, file, dataDir, { mutable: req.query.v !== job.updatedAt });
  });
  // Uploaded material and layout sketches of a job.
  app.get("/api/jobs/:id/source/:name", async (req, res) => {
    const job = store.get(req.params.id);
    const name = req.params.name;
    if (!job || !([...(job.params.inputs || []), ...(job.params.layoutFiles || [])].includes(name)))
      throw new AppError("文件不存在", 404);
    res.sendFile(await regularFile(path.join(jobsDir, job.id), name), { dotfiles: "allow" });
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use(express.static(path.join(ROOT, "dist"), { index: "index.html" }));
  app.use((_req, res) =>
    res.status(404).send("页面不存在。首次运行请先执行 npm run build。"),
  );
  app.use((error, req, res, _next) => {
    const status =
      error instanceof multer.MulterError ? 400 : error.status || 500;
    res.status(status).json({
      error:
        error instanceof multer.MulterError
          ? req.path.startsWith("/api/suites")
            ? `上传超过限制：单个文件最多 ${SUITE_FILE_MB}MB、最多 30 张图；Word 太大可以把图片另外单独上传`
            : "上传超过限制：最多 4 张图片、10MB 文件限制"
          : status >= 500
            ? "服务器处理失败，请查看本机日志"
            : error.message,
    });
    if (status >= 500) console.error("Request failed:", error.message);
  });
  queue.kick();
  return {
    app,
    store,
    queue,
    secretFile,
    close: async () => {
      clearInterval(sweeper);
      clearInterval(coverTimer);
      clearInterval(limitTimer);
      await queue.close();
      store.close();
    },
  };
}
