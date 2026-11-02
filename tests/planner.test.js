import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { normalizePlan, sanitizeFrames, fallbackPlan, planMessages, sceneGuide } from "../backend/planner.js";
import { compareTexts, createTextAI } from "../backend/text-ai.js";
import { framePrompt } from "../backend/prompts.js";
import { renderLayoutSketch, overlayTexts, wrap } from "../backend/render.js";

test("skills feed the planner, not the image model", () => {
  for (const id of ["product", "detail", "poster", "interior"]) {
    const guide = sceneGuide(id);
    assert.ok(guide.length > 400, id);
  }
  assert.match(sceneGuide("product"), /五要素/);
  assert.match(sceneGuide("detail"), /Food and Beverage/);
  const m = planMessages({ skillId: "product", count: 2, size: "1:1", copy: "保温杯", hasMain: true, refCount: 1, styleTags: ["极简"] });
  assert.match(m.system, /只输出一个 JSON/);
  assert.match(m.text, /恰好 2 个 frames/);
  const prompt = framePrompt(
    { skillId: "product", size: "1:1", hasMainImage: true, inputs: ["input-0.png"], styleTags: [], styleNote: "", layoutFiles: [null], frames: [{ title: "主图", layout: "none", textMode: "none", texts: [], scene: "浅木桌面" }] },
    0,
  );
  assert.ok(prompt.length < 900);
  assert.doesNotMatch(prompt, /五要素|光照三要素|Skill/);
});

test("AI plans are repaired: counts, roles, lengths, scene rules", () => {
  const raw = `好的：{"summary":"s","frames":[{"title":"主图","layout":"weird","textMode":"ai","texts":[{"role":"headline","text":"${"超".repeat(30)}"},{"role":"x","text":"y"}],"scene":"a"}]}`;
  const plan = normalizePlan(raw, { skillId: "product", count: 2 });
  assert.equal(plan.frames.length, 2);
  assert.equal(Array.from(plan.frames[0].texts[0].text).length, 16);
  assert.equal(plan.frames[0].texts[1].role, "body");
  assert.equal(plan.frames[0].layout, "top");
  const interior = normalizePlan({ frames: [{ texts: [{ role: "headline", text: "x" }], textMode: "ai" }] }, { skillId: "interior", count: 1 });
  assert.deepEqual(interior.frames[0].texts, []);
  assert.equal(interior.frames[0].textMode, "none");
  const detail = normalizePlan({ frames: [{ textMode: "ai", texts: [{ role: "point", text: "a" }, { role: "body", text: "b" }] }] }, { skillId: "detail", count: 1 });
  assert.equal(detail.frames[0].texts[0].role, "headline");
  assert.equal(detail.frames[0].layout, "top");
  assert.equal(normalizePlan("no json", { skillId: "product", count: 1 }), null);
  assert.throws(() => sanitizeFrames([{ texts: [{ role: "headline", text: "长".repeat(17) }] }], "product", 1, { strict: true }), /不能超过/);
  const rules = fallbackPlan({ skillId: "poster", count: 1, copy: "秋日咖啡节\n第二杯半价\n地址：xx路" });
  assert.equal(rules.frames[0].texts[0].text, "秋日咖啡节");
});

test("proofreading compares exact text, tolerant of spacing and punctuation", () => {
  const ok = compareTexts([{ role: "headline", text: "保温 12 小时！" }], ["保温12小时", "THERMOS"]);
  assert.equal(ok.ok, true);
  const bad = compareTexts([{ role: "headline", text: "一键开盖" }, { role: "price", text: "¥99" }], ["一键开羔", "99"]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems.map((p) => p.text), ["一键开盖"]);
});

test("Kimi client sends images, falls back to rules on failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-"));
  const file = path.join(dir, "a.png");
  await sharp({ create: { width: 300, height: 300, channels: 3, background: "#fff" } }).png().toFile(file);
  let body;
  const ai = createTextAI({
    env: { KIMI_API_KEY: "k", KIMI_MODEL: "kimi-test" },
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      assert.equal(url.href, "https://api.moonshot.cn/v1/chat/completions");
      return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "杯子", frames: [{ title: "主图", layout: "top", textMode: "ai", texts: [{ role: "headline", text: "好杯子" }], scene: "s" }] }) } }] });
    },
  });
  const r = await ai.plan({ skillId: "product", count: 1, size: "1:1", copy: "杯子", hasMain: true }, [file]);
  assert.equal(r.via, "kimi");
  assert.equal(r.plan.frames[0].texts[0].text, "好杯子");
  assert.equal(body.model, "kimi-test");
  assert.match(body.messages[1].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  const broken = createTextAI({ env: { KIMI_API_KEY: "k" }, fetchImpl: async () => new Response("{}", { status: 500 }) });
  const f = await broken.plan({ skillId: "product", count: 1, size: "1:1", copy: "杯子" }, []);
  assert.equal(f.via, "rules");
  assert.match(f.warning, /500/);
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
