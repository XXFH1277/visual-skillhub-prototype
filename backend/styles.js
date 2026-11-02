import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { STYLES, CATEGORIES, IMAGE_TYPES, TONES } from "../shared/styles.js";
import { AppError } from "./store.js";

const clip = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const list = (v, allowed, max) =>
  Array.isArray(v) ? [...new Set(v.filter((x) => allowed.includes(x)))].slice(0, max) : [];

// Clean a recipe coming from Kimi or a merchant edit.
export function cleanRecipe(r = {}) {
  return {
    name: clip(r.name, 16) || "未命名风格",
    tagline: clip(r.tagline, 40),
    categories: list(r.categories, CATEGORIES, 5),
    types: list(r.types, Object.keys(IMAGE_TYPES), 5),
    tone: TONES.includes(r.tone) ? r.tone : "",
    palette: Array.isArray(r.palette) ? r.palette.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 5) : [],
    props: clip(r.props, 160),
    light: clip(r.light, 160),
    camera: clip(r.camera, 160),
    type: clip(r.type, 160),
    avoid: clip(r.avoid, 120),
    core: clip(r.core, 400),
    prompt: clip(r.prompt, 2000),
  };
}

// Built-in recipes live in code; merchant uploads live in SQLite with their image on disk.
export class StyleLibrary {
  constructor(store, dataDir) {
    this.db = store.db;
    this.dir = path.join(dataDir, "styles");
    fs.mkdirSync(this.dir, { recursive: true });
    this.db.exec(`CREATE TABLE IF NOT EXISTS styles (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL, error TEXT,
      created_at TEXT NOT NULL)`);
    this.db.exec("UPDATE styles SET status='failed', error='服务重启中断了分析，请删除后重新上传' WHERE status='analyzing'");
  }
  coverFile(id) {
    const file = path.join(this.dir, `${id}.png`);
    return fs.existsSync(file) ? file : null;
  }
  view(style, source, extra = {}) {
    return { ...style, source, cover: this.coverFile(style.id) ? `/api/styles/${style.id}/cover` : null, ...extra };
  }
  list() {
    const uploads = this.db
      .prepare("SELECT * FROM styles ORDER BY created_at DESC")
      .all()
      .map((r) => this.view({ ...JSON.parse(r.data), id: r.id }, "upload", { status: r.status, error: r.error }));
    return [...uploads, ...STYLES.map((s) => this.view(s, "builtin", { status: "ready" }))];
  }
  get(id) {
    const builtin = STYLES.find((s) => s.id === id);
    if (builtin) return this.view(builtin, "builtin", { status: "ready" });
    const r = this.db.prepare("SELECT * FROM styles WHERE id=?").get(id);
    return r ? this.view({ ...JSON.parse(r.data), id: r.id }, "upload", { status: r.status, error: r.error }) : null;
  }
  ready(id) {
    const s = id && this.get(id);
    if (!s || s.status !== "ready") throw new AppError("风格不存在或还在分析中");
    return s;
  }
  create(data) {
    const id = "u-" + randomUUID().slice(0, 12);
    this.db
      .prepare("INSERT INTO styles VALUES(?,?,?,?,?)")
      .run(id, "analyzing", JSON.stringify(data), null, new Date().toISOString());
    return id;
  }
  finish(id, recipe, error = null) {
    const old = this.get(id);
    if (!old) return;
    const data = error ? { name: old.name, prompt: old.prompt } : { ...cleanRecipe({ ...recipe, prompt: old.prompt }) };
    this.db
      .prepare("UPDATE styles SET status=?, data=?, error=? WHERE id=?")
      .run(error ? "failed" : "ready", JSON.stringify(data), error, id);
  }
  update(id, recipe) {
    const old = this.get(id);
    if (!old || old.source !== "upload") throw new AppError("只能修改自己上传的风格");
    this.db.prepare("UPDATE styles SET data=? WHERE id=?").run(JSON.stringify(cleanRecipe({ ...old, ...recipe })), id);
    return this.get(id);
  }
  async remove(id) {
    const old = this.get(id);
    if (!old || old.source !== "upload") throw new AppError("只能删除自己上传的风格");
    this.db.prepare("DELETE FROM styles WHERE id=?").run(id);
    await fsp.rm(path.join(this.dir, `${id}.png`), { force: true });
  }
  // Built-in covers are generated through the normal image pipeline, then saved here.
  async setCover(id, source) {
    if (!this.get(id)) return;
    await fsp.copyFile(source, path.join(this.dir, `${id}.png`));
  }
}
