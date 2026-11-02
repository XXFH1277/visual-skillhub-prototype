import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../backend/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("a failed generation refunds reserved credits exactly once", () => {
  const store = new Store(":memory:");
  try {
    const job = store.create({ skillId: "product", count: 1 }, "request-1");
    assert.equal(store.account().balance, 490);
    store.start(job.id);
    store.fail(job.id, "Provider unavailable");
    store.fail(job.id, "Duplicate callback");
    assert.equal(store.get(job.id).status, "failed");
    assert.equal(store.account().balance, 500);
    assert.equal(
      store.account().ledger.filter((x) => x.kind === "refund").length,
      1,
    );
  } finally {
    store.close();
  }
});

test("restart preserves queued jobs and refunds interrupted running jobs without double refund", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillhub-store-"));
  const file = path.join(dir, "db.sqlite");
  let s = new Store(file);
  try {
    const first = s.create({ skillId: "product", count: 1 }, "key-first");
    s.start(first.id);
    const queued = s.create({ skillId: "product", count: 2 }, "key-queued");
    s.close();
    s = new Store(file);
    s.recover();
    s.recover();
    assert.equal(s.get(first.id).status, "failed");
    assert.equal(s.get(queued.id).status, "queued");
    assert.equal(s.account().balance, 480);
    assert.equal(s.next().id, queued.id);
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
