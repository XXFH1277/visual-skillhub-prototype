import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createWorkspace } from "../backend/app.js";
import { preparePrompts } from "../backend/prompts.js";
import { fallbackAnalysis, fallbackStoryboard } from "../backend/planner.js";

const ACCESS = "test-only-access-code-123456";
const image = await sharp({ create: { width: 640, height: 640, channels: 3, background: "#6677aa" } }).png().toBuffer();
const ai = {
  describe: () => ({ ready: true, via: "kimi", label: "test" }),
  analyze: async (input, _i, candidates) => ({ result: fallbackAnalysis(input, candidates), via: "kimi" }),
  storyboard: async (input, _i, _r, chosen) => ({ frames: fallbackStoryboard(input, chosen), via: "kimi" }),
  readTexts: async () => [],
  extractStyle: async () => ({ name: "私有风格", types: ["main"], palette: ["#112233"] }),
};

const runs = [];
async function setup(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-acct-"));
  const w = await createWorkspace({
    dataDir: path.join(rootDir, ".data"),
    accessCode: ACCESS,
    runner: async (job, dir) => {
      runs.push({ params: job.params, dir, files: await fs.readdir(dir) });
      await preparePrompts(job.params, dir);
      for (let i = 1; i <= job.params.count; i++)
        await fs.writeFile(path.join(dir, `result-${i}.png`), await sharp({ create: { width: 640, height: 640, channels: 3, background: { r: (runs.length * 40) % 255, g: i * 30, b: 90 } } }).png().toBuffer());
    },
    provider: { ready: true },
    textAI: ai,
  });
  const server = w.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await w.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  // A tiny browser: one cookie jar per person.
  const browser = () => {
    let cookie = "";
    const request = async (route, init = {}) => {
      const r = await fetch(url + route, { ...init, headers: { "X-Requested-With": "SkillHub", Cookie: cookie, ...init.headers } });
      const set = r.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return r;
    };
    const post = (route, body, headers = {}) =>
      request(route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { request, post, json: async (route) => (await request(route)).json() };
  };
  return { browser, w };
}


async function waitJob(user, id) {
  let job;
  for (let i = 0; i < 300; i++) {
    job = await user.json("/api/jobs/" + id);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  return job;
}

test("fine-tune a finished picture: it becomes the base, only the asked change goes to the model", async (t) => {
  const { browser } = await setup(t);
  const admin = browser();
  await admin.post("/api/login", { code: ACCESS });
  const code = (await (await admin.post("/api/admin/invites", { credits: 200, maxUses: 2 })).json()).code;
  const a = browser();
  const b = browser();
  await a.post("/api/register", { phone: "13700000001", password: "secret1", invite: code });
  await b.post("/api/register", { phone: "13700000002", password: "secret2", invite: code });

  const form = new FormData();
  for (const [k, v] of Object.entries({ skillId: "product", copy: "保温杯 · 316 不锈钢", count: "2", size: "1:1" })) form.append(k, v);
  form.append("main", new Blob([image], { type: "image/png" }), "main.png");
  const draft = await (await a.request("/api/drafts", { method: "POST", body: form })).json();
  let d;
  for (let i = 0; i < 200 && (!d || d.status === "analyzing"); i++) d = await a.json("/api/drafts/" + draft.id);
  await a.post(`/api/drafts/${draft.id}/choose`, { index: 0 });
  for (let i = 0; i < 200 && d.status !== "ready"; i++) d = await a.json("/api/drafts/" + draft.id);
  const frames = d.frames.map((f, i) => (i === 1 ? { ...f, textMode: "ai", texts: [{ role: "headline", text: "保温一整天" }] } : f));
  const created = await (await a.post("/api/jobs", { draftId: d.id, frames }, { "Idempotency-Key": randomUUID() })).json();
  const source = await waitJob(a, created.id);
  assert.equal(source.status, "succeeded", source.error);
  assert.equal((await a.json("/api/workspace")).account.balance, 180);
  const sourceDir = runs.at(-1).dir;

  // Validation and privacy.
  assert.equal((await a.post(`/api/jobs/${source.id}/tweak`, { frame: 1 }, { "Idempotency-Key": randomUUID() })).status, 400);
  assert.equal((await a.post(`/api/jobs/${source.id}/tweak`, { frame: 9, instruction: "亮一点" }, { "Idempotency-Key": randomUUID() })).status, 400);
  assert.equal((await b.post(`/api/jobs/${source.id}/tweak`, { frame: 1, instruction: "亮一点" }, { "Idempotency-Key": randomUUID() })).status, 404);

  // Tweak picture 2, changing its headline too.
  const r = await a.post(`/api/jobs/${source.id}/tweak`, { frame: 1, instruction: "背景再亮一点", texts: [{ role: "headline", text: "保温 24 小时" }] }, { "Idempotency-Key": randomUUID() });
  assert.equal(r.status, 202, await r.clone().text());
  const tweak = await waitJob(a, (await r.json()).id);
  assert.equal(tweak.status, "succeeded", tweak.error);
  assert.equal(tweak.cost, 10);
  assert.equal(tweak.sourceId, source.id);
  assert.equal((await a.json("/api/workspace")).account.balance, 170);
  const run = runs.at(-1);
  assert.deepEqual(run.files.sort(), ["tweak-base.png"]);
  assert.deepEqual(await fs.readFile(path.join(run.dir, "tweak-base.png")), await fs.readFile(path.join(sourceDir, "result-2.png")));
  const prompt = await fs.readFile(path.join(run.dir, "prompt-1.txt"), "utf8");
  assert.match(prompt, /【只改这一处】背景再亮一点/);
  assert.match(prompt, /保持不变/);
  assert.match(prompt, /"保温 24 小时"/);
  assert.doesNotMatch(prompt, /风格样图|商家实拍/);
  assert.deepEqual(tweak.params.tweakOf, { jobId: source.id, frame: 1 });
  assert.equal(tweak.params.frames[0].texts[0].text, "保温 24 小时");
  assert.match(tweak.params.productName, /第2张微调/);

  // Text-only change needs no instruction; chained tweaks still point at the original picture.
  const r2 = await a.post(`/api/jobs/${tweak.id}/tweak`, { frame: 0, instruction: "", texts: [{ role: "headline", text: "保温一整天" }] }, { "Idempotency-Key": randomUUID() });
  assert.equal(r2.status, 202, await r2.clone().text());
  const second = await waitJob(a, (await r2.json()).id);
  assert.deepEqual(second.params.tweakOf, { jobId: source.id, frame: 1 });
  assert.deepEqual(second.params.tweakFrom, { jobId: tweak.id, frame: 0 });
  assert.match(await fs.readFile(path.join(runs.at(-1).dir, "prompt-1.txt"), "utf8"), /只把画面中的文字改成/);

  // Versions are listed on the original, newest first; only the owner sees them.
  const listed = await a.json("/api/jobs/" + source.id);
  assert.deepEqual(listed.tweaks.map((x) => x.id), [second.id, tweak.id]);
  assert.equal(listed.tweaks[0].frame, 1);
  assert.equal(listed.tweaks[0].asset, "image-1.png");
  // Redo of a tweak repeats the tweak from the same base.
  const redo = await a.post(`/api/jobs/${tweak.id}/retry`, { frame: 0 }, { "Idempotency-Key": randomUUID() });
  assert.equal(redo.status, 202, await redo.clone().text());
  await waitJob(a, (await redo.json()).id);
  assert.deepEqual(runs.at(-1).files.sort(), ["tweak-base.png"]);
  assert.match(await fs.readFile(path.join(runs.at(-1).dir, "prompt-1.txt"), "utf8"), /背景再亮一点/);
});
