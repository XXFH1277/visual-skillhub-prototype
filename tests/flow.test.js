import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createWorkspace } from "../backend/app.js";
import { createProviders } from "../backend/providers.js";
import { fallbackPlan } from "../backend/planner.js";

const ACCESS = "test-only-access-code-123456";
const image = await sharp({ create: { width: 640, height: 640, channels: 3, background: "#6677aa" } }).png().toBuffer();

// Fake Kimi: plans from rules but marks itself, reads back configurable text.
function fakeAI({ seen = null, ready = true } = {}) {
  const calls = { plan: 0, read: 0 };
  return {
    calls,
    describe: () => (ready ? { ready: true, via: "kimi", label: "test" } : { ready: false, via: "rules", label: "off" }),
    async plan(input, images) {
      calls.plan++;
      calls.images = images.length;
      const plan = fallbackPlan(input);
      plan.summary = "测试方案";
      return { plan, via: ready ? "kimi" : "rules" };
    },
    async readTexts() {
      calls.read++;
      return seen || [];
    },
  };
}
const writeResults = async (job, dir) => {
  for (let i = 1; i <= job.params.count; i++) await fs.writeFile(path.join(dir, `result-${i}.png`), image);
};

async function setup(t, runner = writeResults, options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-test-"));
  const ai = options.textAI || fakeAI();
  const w = await createWorkspace({
    dataDir: path.join(rootDir, ".data"),
    accessCode: ACCESS,
    runner,
    provider: { ready: true },
    textAI: ai,
    ...options,
  });
  const server = w.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const request = (route, init = {}) =>
    fetch(url + route, { ...init, headers: { "X-Requested-With": "SkillHub", Cookie: cookie, ...init.headers } });
  const login = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: ACCESS }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await w.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const post = (route, body, headers = {}) =>
    request(route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const draft = async ({ fields = {}, main = image, mime = "image/png", refs = 0 } = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ skillId: "product", copy: "保温杯\n保温12小时\n一键开盖", count: "1", size: "1:1", ...fields }))
      form.append(k, v);
    if (main) form.append("main", new Blob([main], { type: mime }), "main.png");
    for (let i = 0; i < refs; i++) form.append("reference", new Blob([image], { type: "image/png" }), "ref.png");
    return request("/api/drafts", { method: "POST", body: form });
  };
  const ready = async (id) => {
    for (let i = 0; i < 200; i++) {
      const d = await (await request("/api/drafts/" + id)).json();
      if (d.status !== "planning") return d;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("draft did not finish");
  };
  const submit = async ({ fields, edit, key = randomUUID(), extra = {}, main } = {}) => {
    const created = await draft({ fields, main });
    assert.equal(created.status, 202, await created.clone().text());
    const d = await ready((await created.json()).id);
    const frames = structuredClone(d.plan.frames);
    edit?.(frames);
    return post("/api/jobs", { draftId: d.id, frames, ...extra }, { "Idempotency-Key": key });
  };
  const terminal = async (id) => {
    for (let i = 0; i < 300; i++) {
      const job = await (await request(`/api/jobs/${id}`)).json();
      if (!["queued", "running"].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("job did not finish");
  };
  const balance = async () => (await (await request("/api/workspace")).json()).account.balance;
  return { request, post, draft, ready, submit, terminal, balance, url, w, ai };
}

test("draft → AI plan → confirm → generate → proofread; nothing is charged before confirmation", async (t) => {
  const ai = fakeAI({ seen: ["保温杯", "保温12小时"] });
  const s = await setup(t, writeResults, { textAI: ai });
  const created = await s.draft({ refs: 2, fields: { count: "2" } });
  assert.equal(created.status, 202);
  const d = await s.ready((await created.json()).id);
  assert.equal(d.status, "ready");
  assert.equal(d.refCount, 2);
  assert.equal(ai.calls.images, 3);
  assert.equal(d.plan.frames.length, 2);
  assert.equal(await s.balance(), 500);
  const frames = structuredClone(d.plan.frames);
  frames[0].textMode = "ai";
  frames[0].texts = [{ role: "headline", text: "保温杯" }, { role: "point", text: "一键开盖" }];
  frames[1].textMode = "overlay";
  frames[1].layout = "bottom";
  frames[1].texts = [{ role: "headline", text: "精确排字" }];
  const res = await s.post("/api/jobs", { draftId: d.id, frames }, { "Idempotency-Key": randomUUID() });
  assert.equal(res.status, 202);
  const job = await res.json();
  assert.equal(job.cost, 20);
  assert.deepEqual(job.params.layoutFiles, ["layout-1.png", null]);
  const done = await s.terminal(job.id);
  assert.equal(done.status, "succeeded", done.error);
  assert.equal(ai.calls.read, 1);
  assert.equal(done.manifest.textCheck.length, 1);
  assert.equal(done.manifest.textCheck[0].ok, false);
  assert.deepEqual(done.manifest.textCheck[0].problems.map((p) => p.text), ["一键开盖"]);
  assert.equal(await s.balance(), 480);
  // layout sketch is viewable, uploads too; nothing else
  assert.equal((await s.request(`/api/jobs/${job.id}/source/layout-1.png`)).status, 200);
  assert.equal((await s.request(`/api/jobs/${job.id}/source/input-0.png`)).status, 200);
  assert.equal((await s.request(`/api/jobs/${job.id}/source/text-check.json`)).status, 404);
  // overlay frame: free text edit re-exports without generation
  const before = done.manifest.assets[1].sha256;
  const edited = await s.post(`/api/jobs/${job.id}/texts`, { frames: [null, { texts: [{ role: "headline", text: "改过的字" }] }] });
  assert.equal(edited.status, 200, await edited.clone().text());
  const after = await edited.json();
  assert.equal(after.params.frames[1].texts[0].text, "改过的字");
  assert.notEqual(after.manifest.assets[1].sha256, before);
  assert.equal(after.params.frames[0].texts[0].text, "保温杯");
  assert.equal(await s.balance(), 480);
});

test("detail pages: caption under each screen, long image, free caption edits", async (t) => {
  const s = await setup(t);
  const res = await s.submit({
    fields: { skillId: "detail", count: "3", copy: "陶瓷杯｜手工上釉\n细节｜杯口圆润\n场景｜早餐时光" },
    edit: (frames) => {
      frames[0].textMode = "ai";
      frames[0].texts = [{ role: "headline", text: "手工陶瓷杯" }, { role: "body", text: "每一只都由匠人手工上釉" }];
    },
  });
  assert.equal(res.status, 202, await res.clone().text());
  const done = await s.terminal((await res.json()).id);
  assert.equal(done.status, "succeeded", done.error);
  const modules = done.manifest.assets.filter((a) => a.role === "module");
  const long = done.manifest.assets.find((a) => a.role === "long");
  assert.equal(modules.length, 3);
  assert.ok(modules.every((m) => m.width === 750 && m.height > 750));
  assert.equal(long.height, modules.reduce((h, m) => h + m.height, 0));
  assert.equal(done.params.frames[0].layout, "top");
  // AI headline is locked; only body edits apply
  const edited = await s.post(`/api/jobs/${done.id}/texts`, {
    frames: [{ texts: [{ role: "body", text: "新的说明" }] }, null, null],
  });
  assert.equal(edited.status, 200, await edited.clone().text());
  const after = await edited.json();
  assert.deepEqual(after.params.frames[0].texts, [{ role: "headline", text: "手工陶瓷杯" }, { role: "body", text: "新的说明" }]);
  assert.equal(await s.balance(), 500 - 90);
});

test("posters work without images; product requires one; invalid edits never charge", async (t) => {
  let received;
  const s = await setup(t, async (job, dir) => {
    received = job.params;
    await writeResults(job, dir);
  });
  const res = await s.submit({ main: null, fields: { skillId: "poster", size: "3:4", copy: "秋日咖啡节\n第二杯半价" } });
  assert.equal(res.status, 202);
  assert.equal((await s.terminal((await res.json()).id)).status, "succeeded");
  assert.deepEqual(received.inputs, []);
  assert.equal(received.hasMainImage, false);
  assert.equal((await s.draft({ main: null })).status, 400);
  assert.equal((await s.draft({ fields: { count: "9" } })).status, 400);
  assert.equal((await s.draft({ fields: { skillId: "constructor" } })).status, 400);
  assert.equal((await s.draft({ main: Buffer.from("<script>") })).status, 400);
  assert.equal((await s.draft({ mime: "image/svg+xml" })).status, 400);
  const balance = await s.balance();
  const long = await s.submit({ edit: (f) => (f[0].texts = [{ role: "headline", text: "长".repeat(40) }]) });
  assert.equal(long.status, 400);
  const extra = await s.submit({ edit: (f) => f.push(f[0]) });
  assert.equal(extra.status, 400);
  const role = await s.submit({ edit: (f) => (f[0].texts = [{ role: "constructor", text: "x" }]) });
  assert.equal(role.status, 400);
  assert.equal(await s.balance(), balance);
});

test("single-frame regenerate can switch to exact text; failures refund", async (t) => {
  let fail = false;
  const s = await setup(t, async (job, dir) => {
    if (fail) throw new Error("upstream broke");
    await writeResults(job, dir);
  });
  const res = await s.submit({
    fields: { count: "2" },
    edit: (f) => {
      f[1].textMode = "ai";
      f[1].layout = "top";
      f[1].texts = [{ role: "headline", text: "第二张" }];
    },
  });
  const done = await s.terminal((await res.json()).id);
  const redo = await s.post(`/api/jobs/${done.id}/retry`, { frame: 1, textMode: "overlay" }, { "Idempotency-Key": randomUUID() });
  assert.equal(redo.status, 202);
  const one = await s.terminal((await redo.json()).id);
  assert.equal(one.status, "succeeded");
  assert.equal(one.params.count, 1);
  assert.equal(one.params.frames[0].textMode, "overlay");
  assert.equal(one.sourceId, done.id);
  assert.deepEqual(one.params.layoutFiles, [null]);
  assert.equal(await s.balance(), 500 - 20 - 10);
  fail = true;
  const again = await s.post(`/api/jobs/${done.id}/retry`, {}, { "Idempotency-Key": randomUUID() });
  const failed = await s.terminal((await again.json()).id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /upstream broke/);
  assert.equal(await s.balance(), 470);
});

test("no Kimi configured: rules plan, no proofreading", async (t) => {
  const ai = fakeAI({ ready: false });
  const s = await setup(t, writeResults, { textAI: ai });
  const d = await s.ready((await (await s.draft()).json()).id);
  assert.equal(d.via, "rules");
  const res = await s.post("/api/jobs", { draftId: d.id, frames: d.plan.frames }, { "Idempotency-Key": randomUUID() });
  const done = await s.terminal((await res.json()).id);
  assert.equal(done.status, "succeeded");
  assert.equal(ai.calls.read, 0);
  assert.deepEqual(done.manifest.textCheck, []);
});

test("duplicate confirmations create one job and one charge", async (t) => {
  let calls = 0;
  const s = await setup(t, async (job, dir) => {
    calls++;
    await writeResults(job, dir);
  });
  const d = await s.ready((await (await s.draft()).json()).id);
  const key = randomUUID();
  const send = () => s.post("/api/jobs", { draftId: d.id, frames: d.plan.frames }, { "Idempotency-Key": key });
  const jobs = await Promise.all((await Promise.all([send(), send()])).map((r) => r.json()));
  assert.equal(jobs[0].id, jobs[1].id);
  assert.equal((await s.terminal(jobs[0].id)).status, "succeeded");
  assert.equal(calls, 1);
  assert.equal(await s.balance(), 490);
});

test("outputs require login; missing output fails and refunds", async (t) => {
  const s = await setup(t, async () => {});
  const done = await s.terminal((await (await s.submit()).json()).id);
  assert.equal(done.status, "failed");
  assert.equal(await s.balance(), 500);
  assert.equal((await fetch(s.url + `/api/jobs/${done.id}`)).status, 401);
  assert.equal((await fetch(s.url + `/api/drafts/x`)).status, 401);
  assert.equal((await s.request("/.data/access-code.txt")).status, 404);
});

test("queue runs one job at a time; cancelling refunds only that job", async (t) => {
  let running = 0, max = 0, first = true;
  const s = await setup(t, async (job, dir, signal) => {
    running++;
    max = Math.max(max, running);
    try {
      if (first) {
        first = false;
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      } else await writeResults(job, dir);
    } finally {
      running--;
    }
  });
  const a = await (await s.submit()).json();
  const b = await (await s.submit()).json();
  await s.request(`/api/jobs/${a.id}/cancel`, { method: "POST" });
  assert.equal((await s.terminal(a.id)).status, "cancelled");
  assert.equal((await s.terminal(b.id)).status, "succeeded");
  assert.equal(max, 1);
  assert.equal(await s.balance(), 490);
});

test("public-origin mode rejects other origins and sets a secure cookie", async (t) => {
  const s = await setup(t, writeResults, { publicOrigin: "https://workspace.example" });
  const response = await s.request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: ACCESS }) });
  assert.match(response.headers.get("set-cookie"), /Secure/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await s.request("/api/drafts", { method: "POST", headers: { Origin: "https://untrusted.example" } })).status, 403);
  const status = (headers) =>
    new Promise((resolve, reject) => {
      http.get(s.url + "/api/health", { headers }, (r) => (r.resume(), resolve(r.statusCode))).on("error", reject);
    });
  assert.equal(await status({ Host: "untrusted.example" }), 403);
  assert.equal(await status({ Host: "workspace.example", Origin: "https://workspace.example" }), 200);
});

test("API mode sends layout sketch for AI text and upscale keeps working", async (t) => {
  const sent = [];
  const providers = createProviders({
    env: { IMAGE_API_BASE_URL: "https://relay.example", IMAGE_API_KEY: "private-test-key", IMAGE_API_MODEL_2K: "m25", IMAGE_API_MODEL_4K: "m20" },
    codexCheck: async () => ({ ready: true }),
    fetchImpl: async (url, init) => {
      if (url.pathname.endsWith("models")) return Response.json({ data: [{ id: "m25" }, { id: "m20" }] });
      sent.push({ path: url.pathname, model: init.body.get("model"), prompt: init.body.get("prompt"), images: init.body.getAll("image[]").map((f) => f.name) });
      return Response.json({ data: [{ b64_json: image.toString("base64") }] });
    },
  });
  const s = await setup(t, null, { providers });
  const res = await s.submit({
    fields: { count: "2" },
    extra: { providerMode: "api", resolution: "2K" },
    edit: (f) => {
      f[0].textMode = "ai";
      f[0].layout = "top";
      f[0].texts = [{ role: "headline", text: "一键开盖" }];
      f[1].textMode = "overlay";
      f[1].layout = "bottom";
      f[1].texts = [{ role: "headline", text: "保温12小时" }];
    },
  });
  const done = await s.terminal((await res.json()).id);
  assert.equal(done.status, "succeeded", done.error);
  assert.deepEqual(sent[0].images, ["input-0.png", "layout-1.png"]);
  assert.match(sent[0].prompt, /"一键开盖"/);
  assert.match(sent[0].prompt, /版式稿/);
  assert.deepEqual(sent[1].images, ["input-0.png"]);
  assert.match(sent[1].prompt, /后期会在这里排字/);
  assert.doesNotMatch(sent[1].prompt, /保温12小时/);
  assert.equal(done.params.imageModel, "m25");
  const up = await s.post(`/api/jobs/${done.id}/upscale`, { asset: "image-1.png" }, { "Idempotency-Key": randomUUID() });
  assert.equal(up.status, 202, await up.clone().text());
  const upDone = await s.terminal((await up.json()).id);
  assert.equal(upDone.status, "succeeded", upDone.error);
  assert.equal(sent.at(-1).model, "m20");
  const state = await (await s.request("/api/workspace")).text();
  assert.doesNotMatch(state, /private-test-key/);
});
