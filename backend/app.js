import express from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { Store, SKILLS, AppError } from "./store.js";
import { normalizeUpload, regularFile, deliver } from "./media.js";
import { JobQueue } from "./queue.js";
import { createProviders } from "./providers.js";
import { parsePoster } from "./poster.js";
import { parseCreative, moduleDirection } from "./creation.js";
import { snapshotWorkflow } from "./skill-workflow.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest();
const text = (value, max, label, required = false) => {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new AppError(`${label}不能为空或超过 ${max} 字`);
  return value.trim();
};
function modules(value) {
  let list;
  try {
    list = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new AppError("模块文案格式错误");
  }
  if (!Array.isArray(list) || list.length < 2 || list.length > 6)
    throw new AppError("详情页需要 2–6 个模块");
  return list.map((m, i) => ({
    title: text(m?.title, 28, "模块标题", true),
    body: text(m?.body ?? "", 100, "模块正文"),
    ...moduleDirection(m, i),
  }));
}
function parameters(body) {
  const skillId = body.skillId;
  if (skillId === "upscale")
    throw new AppError("请从已完成图片的「提升至 4K」按钮创建任务");
  if (!Object.hasOwn(SKILLS, skillId)) throw new AppError("请选择有效的技能");
  const p = {
    skillId,
    productName: text(body.productName, 60, "项目名称", true),
    platform: text(body.platform, 40, "使用场景", true),
    styleNote: text(body.styleNote ?? "", 1000, "风格说明"),
    facts: text(body.facts ?? "", 1200, "已确认卖点"),
    brandColor: body.brandColor || "#5755d9",
    size: body.size || "1:1",
  };
  if (!/^#[0-9a-f]{6}$/i.test(p.brandColor))
    throw new AppError("品牌颜色格式错误");
  if (!["1:1", "3:4", "16:9"].includes(p.size))
    throw new AppError("画幅比例无效");
  if (skillId === "poster") p.poster = parsePoster(body.poster);
  else p.creative = parseCreative(skillId, body.creative);
  if (skillId === "interior" && p.creative.style === "custom" && !p.styleNote)
    throw new AppError("自定义装修风格请填写风格说明");
  if (skillId === "detail") {
    p.modules = modules(body.modules);
    p.count = p.modules.length;
    p.size = "1:1";
  } else {
    p.count = Number(body.count);
    if (!Number.isInteger(p.count) || p.count < 1 || p.count > 3)
      throw new AppError("每次生成 1–3 张");
  }
  return p;
}

export async function createWorkspace({
  dataDir = path.join(ROOT, ".data"),
  accessCode,
  runner,
  provider,
  providers,
  publicOrigin = process.env.PUBLIC_ORIGIN || "",
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
  registry.validate(providerMode);
  const queue = new JobQueue(store, jobsDir, registry.run);
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
        "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
  app.use(express.json({ limit: "24kb" }));
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
    if (
      !store.db
        .prepare("SELECT hash FROM sessions WHERE hash=? AND expires>?")
        .get(hash, Date.now())
    )
      return res.status(401).json({ error: "请先输入访问码登录" });
    next();
  };
  let loginWindow = { started: 0, attempts: 0 };
  app.post("/api/login", (req, res) => {
    if (Date.now() - loginWindow.started > 60_000)
      loginWindow = { started: Date.now(), attempts: 0 };
    if (++loginWindow.attempts > 10)
      throw new AppError("登录尝试过多，请一分钟后重试", 429);
    const supplied = typeof req.body?.code === "string" ? req.body.code : "";
    if (!timingSafeEqual(digest(supplied), digest(secret)))
      throw new AppError("访问码不正确", 401);
    const token = randomBytes(32).toString("base64url");
    store.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?)")
      .run(digest(token).toString("hex"), Date.now() + cookieOptions.maxAge);
    res.cookie("vsh_session", token, cookieOptions).json({ ok: true });
  });
  const instanceId = process.env.SKILLHUB_INSTANCE_ID || randomUUID();
  app.get("/api/health", (_req, res) => res.json({ ok: true, instanceId }));
  app.use("/api", auth);
  app.post("/api/logout", (req, res) => {
    store.db
      .prepare("DELETE FROM sessions WHERE hash=?")
      .run(digest(cookie(req)).toString("hex"));
    res
      .clearCookie("vsh_session", { ...cookieOptions, maxAge: undefined })
      .json({ ok: true });
  });
  app.get("/api/workspace", (_req, res) =>
    res.json({
      account: store.account(),
      skills: SKILLS,
      provider: registry.describe(providerMode),
      providers: registry.list(),
      mode: "private-workspace",
    }),
  );
  app.post("/api/provider/check", async (req, res) => {
    res.json(await registry.check(req.body?.mode || providerMode));
  });
  app.post("/api/provider", (req, res) => {
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
  app.get("/api/jobs", (_req, res) => res.json({ jobs: store.list() }));
  app.get("/api/jobs/:id", (req, res) => {
    const job = store.get(req.params.id);
    if (!job) throw new AppError("任务不存在", 404);
    res.json(job);
  });
  let uploading = 0;
  const admission = (req, res, next) => {
    const key = req.get("Idempotency-Key");
    if (!key || !/^[a-zA-Z0-9-]{16,100}$/.test(key))
      return res.status(400).json({ error: "缺少有效的提交编号" });
    const old = store.byKey(key);
    if (old) return res.status(200).json(old);
    if (uploading >= 2)
      return res.status(429).json({ error: "正在处理上传，请稍后重试" });
    uploading++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        uploading--;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 4,
      fields: 16,
      parts: 20,
      fieldSize: 8192,
    },
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
  app.post("/api/jobs", admission, upload, async (req, res) => {
    const params = parameters(req.body || {});
    Object.assign(
      params,
      registry.selection({ ...req.body, size: params.size }, providerMode),
    );
    if (!req.files?.main?.length && params.skillId !== "poster")
      throw new AppError(
        params.skillId === "interior" ? "请上传现状空间照片" : "请上传商品主图",
      );
    params.hasMainImage = !!req.files?.main?.length;
    const id = randomUUID(),
      dir = path.join(jobsDir, id);
    await fsp.mkdir(dir);
    try {
      params.inputs = [];
      for (const [index, file] of [
        ...(req.files?.main || []),
        ...(req.files?.reference || []),
      ].entries()) {
        const name = `input-${index}.png`;
        await normalizeUpload(file.buffer, path.join(dir, name));
        params.inputs.push(name);
      }
      await snapshotWorkflow(params, dir);
      const job = store.create(params, req.get("Idempotency-Key"), { id });
      if (job.id !== id) await fsp.rm(dir, { recursive: true, force: true });
      res.status(202).json(job);
      queue.kick();
    } catch (error) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw error;
    }
  });
  app.post("/api/jobs/:id/retry", admission, async (req, res) => {
    const source = store.get(req.params.id);
    if (!source) throw new AppError("任务不存在", 404);
    if (["queued", "running"].includes(source.status))
      throw new AppError("请等待当前任务结束");
    const params = { ...source.params };
    const choice =
      source.params.operation === "upscale"
        ? registry.upscaleSelection(
            source.params.sourceWidth,
            source.params.sourceHeight,
          )
        : registry.selection(
            { ...source.params, ...req.body },
            source.params.providerMode || "codex",
          );
    delete params.imageModel;
    delete params.resolution;
    delete params.requestedSize;
    Object.assign(params, choice);
    const id = randomUUID(),
      dir = path.join(jobsDir, id);
    await fsp.mkdir(dir);
    try {
      for (const name of source.params.inputs)
        await fsp.copyFile(
          await regularFile(path.join(jobsDir, source.id), name),
          path.join(dir, name),
        );
      await snapshotWorkflow(params, dir);
      const job = store.create(params, req.get("Idempotency-Key"), {
        id,
        sourceId: source.id,
      });
      if (job.id !== id) await fsp.rm(dir, { recursive: true, force: true });
      res.status(202).json(job);
      queue.kick();
    } catch (error) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw error;
    }
  });
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
  const exportLocks = new Set();
  app.post("/api/jobs/:id/copy", async (req, res) => {
    const job = store.get(req.params.id);
    if (!job || job.status !== "succeeded" || job.params.skillId !== "detail")
      throw new AppError("该任务不能修改详情页文案");
    if (exportLocks.has(job.id))
      throw new AppError("正在重新排版，请稍候", 409);
    const copy = modules(req.body?.modules).map((m, i) => ({
      ...m,
      ...moduleDirection(job.params.modules[i], i),
    }));
    if (copy.length !== job.params.count)
      throw new AppError("模块数量不可改变");
    exportLocks.add(job.id);
    try {
      const changed = { ...job, params: { ...job.params, modules: copy } };
      const manifest = await deliver(changed, path.join(jobsDir, job.id));
      store.db
        .prepare("UPDATE jobs SET params=?,manifest=?,updated_at=? WHERE id=?")
        .run(
          JSON.stringify(changed.params),
          JSON.stringify(manifest),
          new Date().toISOString(),
          job.id,
        );
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
      job.status !== "succeeded" ||
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
    else res.sendFile(file, { dotfiles: "allow" });
  });
  app.get("/api/jobs/:id/input", async (req, res) => {
    const job = store.get(req.params.id);
    if (!job) throw new AppError("任务不存在", 404);
    if (!job.params.inputs.length)
      throw new AppError("此任务没有上传素材", 404);
    res.sendFile(
      await regularFile(path.join(jobsDir, job.id), job.params.inputs[0]),
      { dotfiles: "allow" },
    );
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use(express.static(path.join(ROOT, "dist"), { index: "index.html" }));
  app.use((_req, res) =>
    res.status(404).send("页面不存在。首次运行请先执行 npm run build。"),
  );
  app.use((error, _req, res, _next) => {
    const status =
      error instanceof multer.MulterError ? 400 : error.status || 500;
    res.status(status).json({
      error:
        error instanceof multer.MulterError
          ? "上传超过限制：最多 4 张图片、10MB 文件限制"
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
      await queue.close();
      store.close();
    },
  };
}
