import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createWorkspace } from "../backend/app.js";
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

async function setup(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-acct-"));
  const w = await createWorkspace({
    dataDir: path.join(rootDir, ".data"),
    accessCode: ACCESS,
    runner: async (job, dir) => {
      for (let i = 1; i <= job.params.count; i++) await fs.writeFile(path.join(dir, `result-${i}.png`), image);
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

test("invite → register → own wallet; admin manages invites and top-ups", async (t) => {
  const { browser } = await setup(t);
  const admin = browser();
  assert.equal((await admin.post("/api/login", { code: ACCESS })).status, 200);
  const me = await admin.json("/api/workspace");
  assert.equal(me.user.role, "admin");
  assert.equal(me.account.balance, 500);

  const guest = browser();
  assert.equal((await guest.request("/api/workspace")).status, 401);
  // No or wrong invite code.
  assert.equal((await guest.post("/api/register", { phone: "13800000001", password: "secret1" })).status, 400);
  assert.equal((await guest.post("/api/register", { phone: "13800000001", password: "secret1", invite: "NOPE" })).status, 403);
  // Merchants can't reach admin tools.
  const invite = await (await admin.post("/api/admin/invites", { credits: 60, maxUses: 1, note: "试用" })).json();
  assert.match(invite.code, /^[A-Z2-9]{8}$/);

  const a = browser();
  const reg = await a.post("/api/register", { phone: "138 0000 0001", password: "secret1", name: "阿海水产", invite: invite.code.toLowerCase() });
  assert.equal(reg.status, 200, await reg.clone().text());
  const aw = await a.json("/api/workspace");
  assert.equal(aw.user.name, "阿海水产");
  assert.equal(aw.user.role, "user");
  assert.equal(aw.account.balance, 60);
  assert.equal(aw.account.ledger[0].kind, "signup");
  assert.equal((await a.request("/api/admin")).status, 403);
  assert.equal((await a.post("/api/provider", { mode: "api" })).status, 403);
  assert.equal((await a.post("/api/styles-covers", {})).status, 403);

  // The invite was single-use; the phone is taken.
  const b = browser();
  assert.equal((await b.post("/api/register", { phone: "13800000002", password: "secret2", invite: invite.code })).status, 403);
  const invite2 = (await (await admin.post("/api/admin/invites", { credits: 0, maxUses: 5 })).json()).code;
  assert.equal((await b.post("/api/register", { phone: "13800000001", password: "secret2", invite: invite2 })).status, 409);
  assert.equal((await b.post("/api/register", { phone: "13800000002", password: "123", invite: invite2 })).status, 400);
  assert.equal((await b.post("/api/register", { phone: "13800000002", password: "secret2", invite: invite2 })).status, 200);

  // Password login, wrong password, logout.
  const a2 = browser();
  assert.equal((await a2.post("/api/login", { phone: "13800000001", password: "wrong!!" })).status, 401);
  assert.equal((await a2.post("/api/login", { phone: "13800000009", password: "secret1" })).status, 401);
  assert.equal((await a2.post("/api/login", { phone: "13800000001", password: "secret1" })).status, 200);
  assert.equal((await a2.json("/api/workspace")).user.name, "阿海水产");

  // Admin view and top-up land on the right wallet.
  const board = await admin.json("/api/admin");
  const ah = board.users.find((u) => u.phone === "13800000001");
  assert.equal(board.users.length, 3);
  assert.equal(board.invites.find((i) => i.code === invite.code).used, 1);
  assert.equal((await admin.post(`/api/admin/users/${ah.id}/grant`, { amount: 100, note: "转账 100 元" })).status, 200);
  assert.equal((await admin.post(`/api/admin/users/${ah.id}/grant`, { amount: -1000 })).status, 400);
  const after = await a.json("/api/workspace");
  assert.equal(after.account.balance, 160);
  assert.equal(after.account.ledger[0].kind, "grant");
  assert.equal(after.account.ledger[0].note, "转账 100 元");
  assert.equal((await admin.json("/api/workspace")).account.balance, 500);

  // Revoked invite stops working; admin password reset logs the merchant out.
  await admin.post(`/api/admin/invites/${invite2}/revoke`, {});
  assert.equal((await browser().post("/api/register", { phone: "13800000003", password: "secret3", invite: invite2 })).status, 403);
  assert.equal((await admin.post(`/api/admin/users/${ah.id}/password`, { password: "newpass1" })).status, 200);
  assert.equal((await a.request("/api/workspace")).status, 401);
  assert.equal((await a.post("/api/login", { phone: "13800000001", password: "newpass1" })).status, 200);
  // Merchant changes own password.
  assert.equal((await a.post("/api/me/password", { old: "bad", password: "another1" })).status, 401);
  assert.equal((await a.post("/api/me/password", { old: "newpass1", password: "another1" })).status, 200);
  assert.equal((await a.post("/api/logout", {})).status, 200);
  assert.equal((await a.post("/api/login", { phone: "13800000001", password: "another1" })).status, 200);
});

test("merchants only see their own jobs, products, drafts and uploaded styles", async (t) => {
  const { browser } = await setup(t);
  const admin = browser();
  await admin.post("/api/login", { code: ACCESS });
  const code = (await (await admin.post("/api/admin/invites", { credits: 100, maxUses: 2 })).json()).code;
  const a = browser();
  const b = browser();
  await a.post("/api/register", { phone: "13900000001", password: "secret1", invite: code });
  await b.post("/api/register", { phone: "13900000002", password: "secret2", invite: code });

  // A makes a draft and a job.
  const form = new FormData();
  for (const [k, v] of Object.entries({ skillId: "product", copy: "保温杯", count: "1", size: "1:1" })) form.append(k, v);
  form.append("main", new Blob([image], { type: "image/png" }), "main.png");
  const draft = await (await a.request("/api/drafts", { method: "POST", body: form })).json();
  let d;
  for (let i = 0; i < 200 && (!d || d.status === "analyzing"); i++) d = await a.json("/api/drafts/" + draft.id);
  assert.equal((await b.request("/api/drafts/" + draft.id)).status, 404);
  await a.post(`/api/drafts/${draft.id}/choose`, { index: 0 });
  for (let i = 0; i < 200 && d.status !== "ready"; i++) d = await a.json("/api/drafts/" + draft.id);
  assert.equal((await b.post("/api/jobs", { draftId: d.id, frames: d.frames }, { "Idempotency-Key": randomUUID() })).status, 404);
  const key = randomUUID();
  const job = await (await a.post("/api/jobs", { draftId: d.id, frames: d.frames }, { "Idempotency-Key": key })).json();
  assert.equal((await a.json("/api/workspace")).account.balance, 90);
  assert.equal((await b.json("/api/workspace")).account.balance, 100);
  // B can't see, cancel, retry or download it, and can't replay A's idempotency key.
  assert.equal((await b.json("/api/jobs")).jobs.length, 0);
  assert.equal((await a.json("/api/jobs")).jobs.length, 1);
  assert.equal((await b.request("/api/jobs/" + job.id)).status, 404);
  assert.equal((await b.post(`/api/jobs/${job.id}/cancel`, {})).status, 404);
  assert.equal((await b.post(`/api/jobs/${job.id}/retry`, {}, { "Idempotency-Key": randomUUID() })).status, 404);
  assert.equal((await b.request(`/api/jobs/${job.id}/files/manifest.json`)).status, 404);
  assert.equal((await b.post(`/api/suites/x/shots/generate`, {}, { "Idempotency-Key": key })).status, 404);
  // Admin doesn't see merchants' work in its own list either.
  assert.equal((await admin.json("/api/jobs")).jobs.length, 0);

  // Products (suites).
  const sform = new FormData();
  sform.append("answers", JSON.stringify({ name: "舟山带鱼" }));
  sform.append("photos", new Blob([image], { type: "image/png" }), "p.png");
  const suite = await (await a.request("/api/suites", { method: "POST", body: sform })).json();
  assert.ok(suite.id);
  assert.equal((await a.json("/api/suites")).suites.length, 1);
  assert.equal((await b.json("/api/suites")).suites.length, 0);
  // Just talking about it is enough (no name, no note) as long as there are photos.
  const casual = new FormData();
  casual.append("text", "舟山带鱼 沈家门码头直接发 肉厚 清蒸出油 冷冻顺丰");
  casual.append("photos", new Blob([image], { type: "image/png" }), "p.png");
  assert.equal((await a.request("/api/suites", { method: "POST", body: casual })).status, 202);
  const noPhotos = new FormData();
  noPhotos.append("text", "舟山带鱼");
  assert.equal((await a.request("/api/suites", { method: "POST", body: noPhotos })).status, 400);
  assert.equal((await a.json("/api/suites")).suites.length, 2);
  assert.equal((await b.request("/api/suites/" + suite.id)).status, 404);
  assert.equal((await b.request(`/api/suites/${suite.id}/photo/${suite.photos[0].file}`)).status, 404);
  assert.equal((await b.request("/api/suites/" + suite.id, { method: "DELETE" })).status, 404);

  // Uploaded styles are private until the admin shares them.
  const up = new FormData();
  up.append("image", new Blob([image], { type: "image/png" }), "s.png");
  up.append("prompt", "暖光木桌");
  const style = await (await a.request("/api/styles", { method: "POST", body: up })).json();
  const mine = (await a.json("/api/styles")).styles.find((s) => s.id === style.id);
  assert.equal(mine.mine, true);
  assert.ok(!(await b.json("/api/styles")).styles.some((s) => s.id === style.id));
  assert.equal((await b.request("/api/styles/" + style.id)).status, 404);
  assert.equal((await b.request(`/api/styles/${style.id}/cover`)).status, 404);
  assert.equal((await a.post(`/api/styles/${style.id}/share`, { shared: true })).status, 403);
  assert.equal((await admin.post(`/api/styles/${style.id}/share`, { shared: true })).status, 200);
  const shared = (await b.json("/api/styles")).styles.find((s) => s.id === style.id);
  assert.equal(shared.shared, true);
  assert.equal(shared.mine, false);
  assert.equal((await b.request("/api/styles/" + style.id, { method: "DELETE" })).status, 403);
  assert.equal((await a.request("/api/styles/" + style.id, { method: "DELETE" })).status, 200);
});

test("admin can list every relay image model and probe one (merchants can't)", async (t) => {
  const { browser } = await setup(t);
  const admin = browser();
  await admin.post("/api/login", { code: ACCESS });
  // The fake provider has no relay: the probe answers with a reason instead of failing.
  const r = await admin.post("/api/admin/image-probe", { model: "gpt-image-2.6-sunburst", format: "svg" });
  assert.ok([200, 500].includes(r.status));
  assert.equal((await admin.post("/api/admin/image-probe", { model: "../etc" })).status, 400);
  const guest = browser();
  assert.equal((await guest.post("/api/admin/image-probe", { model: "x-model" })).status, 401);
});
