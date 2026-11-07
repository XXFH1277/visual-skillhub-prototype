import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { normalizeAnalysis, normalizeStoryboard, sanitizeFrames, analyzeMessages, storyboardMessages, sceneGuide, candidatesFor } from "../backend/planner.js";
import { STYLES } from "../shared/styles.js";
import { compareTexts, createTextAI } from "../backend/text-ai.js";
import { framePrompt } from "../backend/prompts.js";
import { renderLayoutSketch, overlayTexts, wrap } from "../backend/render.js";
const lib = STYLES.map((x) => ({ ...x, status: "ready" }));

test("skills and the style library feed the planner, not the image model", () => {
  for (const id of ["product", "detail", "poster", "interior"]) assert.ok(sceneGuide(id).length > 400, id);
  const candidates = candidatesFor(lib, "product");
  assert.ok(candidates.length > 20 && candidates.every((c) => !c.types.includes("interior")));
  const m = analyzeMessages({ skillId: "product", count: 2, size: "1:1", copy: "保温杯", hasMain: true, hasReference: true }, candidates);
  assert.match(m.system, /wabi｜侘寂自然/);
  assert.match(m.system, /styleId="ref"/);
  const result = normalizeAnalysis({ directions: [{ styleId: "wabi", conceptName: "一日三刻" }] }, { skillId: "product" }, candidates);
  const sb = storyboardMessages({ skillId: "detail", count: 6, copy: "" }, result, result.directions[0]);
  assert.match(sb.system, /一日三刻/);
  assert.match(sb.system, /恰好 6 个 frames/);
  const prompt = framePrompt(
    { skillId: "product", size: "1:1", hasMainImage: true, refCount: 0, inputs: ["input-0.png"], styleRef: null, direction: result.directions[0], frames: [{ title: "主图", layout: "none", textMode: "none", texts: [], scene: "浅木桌面" }] },
    0,
  );
  assert.ok(prompt.length < 1400, prompt.length);
  assert.match(prompt, /陶/);
  assert.doesNotMatch(prompt, /五要素|光照三要素|Skill/);
});

test("AI output is repaired: unknown styles dropped, directions topped up, frames sanitized", () => {
  const candidates = candidatesFor(lib, "product");
  const r = normalizeAnalysis(
    `好的 {"analysis":{"product":"杯子","category":"乱写"},"directions":[{"styleId":"nope"},{"styleId":"dark","palette":["#000000","bad"]},{"styleId":"dark"}]}`,
    { skillId: "product", styleId: "" },
    candidates,
  );
  assert.equal(r.directions.length, 3);
  assert.equal(r.directions[0].styleId, "dark");
  assert.deepEqual(r.directions[0].palette, ["#000000"]);
  assert.equal(new Set(r.directions.map((d) => d.styleId)).size, 3);
  assert.equal(r.analysis.category, "");
  const frames = normalizeStoryboard({ frames: [{ title: "a", scene: "s", textMode: "ai", texts: [{ role: "x", text: "长".repeat(100) }] }] }, { skillId: "product", count: 2 });
  assert.equal(frames, null, "missing scene for frame 2 is rejected");
  const ok = normalizeStoryboard({ frames: [{ scene: "s", texts: [{ role: "headline", text: "超".repeat(30) }] }, { scene: "t" }] }, { skillId: "product", count: 2 });
  assert.equal(Array.from(ok[0].texts[0].text).length, 16);
  assert.equal(ok[0].layout, "free");
  assert.equal(ok[1].textMode, "none");
  const interior = normalizeStoryboard({ frames: [{ scene: "s", texts: [{ role: "headline", text: "x" }], textMode: "ai" }] }, { skillId: "interior", count: 1 });
  assert.deepEqual(interior[0].texts, []);
  assert.throws(() => sanitizeFrames([{ scene: "s", texts: [{ role: "headline", text: "长".repeat(17) }] }], "product", 1, { strict: true }), /不能超过/);
});

test("proofreading compares exact text, tolerant of spacing and punctuation", () => {
  const ok = compareTexts([{ role: "headline", text: "保温 12 小时！" }], ["保温12小时", "THERMOS"]);
  assert.equal(ok.ok, true);
  const bad = compareTexts([{ role: "headline", text: "一键开盖" }, { role: "price", text: "¥99" }], ["一键开羔", "99"]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems.map((p) => p.text), ["一键开盖"]);
  // Big number and small label on separate lines, read out of order.
  const split = compareTexts([{ role: "point", text: "60米深海生长" }, { role: "point", text: "-196℃液氮锁鲜" }, { role: "point", text: "深冷链全程冷链" }], ["深海生长", "液氮锁鲜", "全程冷链", "60米", "-196℃", "深冷链"]);
  assert.equal(split.ok, true);
  assert.equal(compareTexts([{ role: "point", text: "60米深海生长" }], ["深海生长", "80米"]).ok, false);
  assert.equal(compareTexts([{ role: "point", text: "深冷链全程冷链" }], ["深冷链", "全程冷琏"]).ok, false);
});

test("Kimi client sends images, falls back to common styles on failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-"));
  const file = path.join(dir, "a.png");
  await sharp({ create: { width: 300, height: 300, channels: 3, background: "#fff" } }).png().toFile(file);
  const candidates = candidatesFor(lib, "product");
  let body;
  const ai = createTextAI({
    env: { KIMI_API_KEY: "k", KIMI_MODEL: "kimi-test" },
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      assert.equal(url.href, "https://api.moonshot.cn/v1/chat/completions");
      return Response.json({ choices: [{ message: { content: JSON.stringify({ analysis: { product: "杯子" }, directions: [{ styleId: "wabi", conceptName: "一日三刻" }] }) } }] });
    },
  });
  const r = await ai.analyze({ skillId: "product", count: 1, size: "1:1", copy: "杯子", hasMain: true }, [file], candidates);
  assert.equal(r.via, "kimi");
  assert.equal(r.result.directions[0].conceptName, "一日三刻");
  assert.equal(body.model, "kimi-test");
  assert.match(body.messages[1].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  const broken = createTextAI({ env: { KIMI_API_KEY: "k" }, fetchImpl: async () => new Response("{}", { status: 500 }) });
  const f = await broken.analyze({ skillId: "product", count: 1, size: "1:1", copy: "杯子" }, [], candidates);
  assert.equal(f.via, "rules");
  assert.match(f.warning, /500/);
  assert.equal(f.result.directions.length, 3);
  assert.equal(createTextAI({ env: {} }).describe().ready, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("program typesetting renders sketches and overlays", async () => {
  assert.deepEqual(wrap("一二三四五", 10, 30), ["一二三", "四五"]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "render-"));
  const photo = await sharp({ create: { width: 500, height: 400, channels: 3, background: "#88aacc" } }).png().toBuffer();
  const out = path.join(dir, "s.png");
  await renderLayoutSketch({ width: 768, height: 1024, layout: "top", texts: [{ role: "headline", text: "秋日新品" }, { role: "cta", text: "立即购买" }], mainImage: photo, accent: "#e8541e" }, out);
  assert.equal((await sharp(out).metadata()).height, 1024);
  const over = path.join(dir, "o.png");
  await overlayTexts(photo, { layout: "left", texts: [{ role: "headline", text: "这是一个很长很长的标题需要换行显示" }], accent: "#e8541e" }, over);
  assert.equal((await sharp(over).metadata()).width, 500);
  await fs.rm(dir, { recursive: true, force: true });
});

test("relay model check switches to an available Kimi model", async () => {
  const ai = createTextAI({
    env: { KIMI_API_KEY: "k", KIMI_API_BASE_URL: "https://relay.example", KIMI_MODEL: "kimi-k3" },
    fetchImpl: async (url) => {
      assert.equal(url.href, "https://relay.example/v1/models");
      return Response.json({ data: [{ id: "gpt-image-2.5" }, { id: "kimi-k2.6" }, { id: "kimi-k2.5" }] });
    },
  });
  const state = await ai.check();
  assert.equal(state.model, "kimi-k2.6");
  assert.deepEqual(state.models, ["kimi-k2.6", "kimi-k2.5"]);
});

test("proofreading accepts the shapes models actually answer in", async () => {
  const { readLines } = await import("../backend/text-ai.js");
  assert.deepEqual(readLines('{"lines":["舟山樱花虾","250g/包"]}'), ["舟山樱花虾", "250g/包"]);
  assert.deepEqual(readLines('["舟山樱花虾"]'), ["舟山樱花虾"]);
  assert.deepEqual(readLines('```json\n{"texts":[{"text":"白灼"}]}\n```'), ["白灼"]);
  assert.deepEqual(readLines('{"lines":"清蒸\\n白灼"}'), ["清蒸", "白灼"]);
  assert.deepEqual(readLines("清蒸\n白灼"), ["清蒸", "白灼"]);
});

test("image probe reports what a relay model returns (SVG, error) without leaking the key", async () => {
  const { probeImageModel } = await import("../backend/image-api.js");
  const config = { base: "https://relay.example/v1/", key: "sk-secret" };
  let sent;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';
  const ok = await probeImageModel(config, { model: "gpt-image-2.6-sunburst", prompt: "logo", format: "svg", background: "transparent" }, async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(svg).toString("base64") }] }), { status: 200 });
  });
  assert.equal(sent.output_format, "svg");
  assert.equal(sent.background, "transparent");
  assert.equal(ok.kind, "svg");
  const bad = await probeImageModel(config, { model: "nope", prompt: "x" }, async () => new Response("model nope not found for sk-secret", { status: 404 }));
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 404);
  assert.doesNotMatch(bad.message, /sk-secret/);
});

test("usage records carry the product and step they were made for", async () => {
  const { setUsageSink, recordUsage, withUsage } = await import("../backend/usage.js");
  const seen = [];
  setUsageSink((u) => seen.push(u));
  await withUsage({ suiteId: "s1", purpose: "profile" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    recordUsage({ kind: "text", promptTokens: 1200, completionTokens: 300 });
    await withUsage({ purpose: "proofread", jobId: "j1" }, async () => recordUsage({ kind: "text", promptTokens: 2000 }));
  });
  recordUsage({ kind: "image" });
  setUsageSink(null);
  assert.deepEqual(seen.map((u) => [u.suiteId, u.purpose, u.jobId]), [["s1", "profile", undefined], ["s1", "proofread", "j1"], [undefined, undefined, undefined]]);
});
