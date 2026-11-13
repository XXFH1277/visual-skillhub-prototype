import path from "node:path";
import { deliver, partialDelivery } from "./media.js";

// Runs queued jobs, several at a time. Pictures in flight are capped by the image channels'
// own gates (see image-api.js), so extra running jobs simply take turns picture by picture.
export class JobQueue {
  constructor(store, jobsDir, runner, afterRun = null, onSuccess = null, { maxActive = 1 } = {}) {
    this.store = store;
    this.afterRun = afterRun;
    this.onSuccess = onSuccess;
    this.jobsDir = jobsDir;
    this.runner = runner;
    this.maxActive = Math.max(1, maxActive);
    this.running = new Map(); // job id → { job, controller, done }
    this.stopped = false;
    this.store.recover();
  }
  kick() {
    while (!this.stopped && this.running.size < this.maxActive) {
      // Whoever has the fewest jobs running goes first, so one busy account can't starve the rest.
      const job = this.store.nextFair([...this.running.values()].map((r) => r.job));
      if (!job) return;
      if (!this.store.start(job.id)) continue;
      const entry = { job, controller: new AbortController() };
      this.running.set(job.id, entry);
      entry.done = this.run(job, entry.controller).finally(() => {
        this.running.delete(job.id);
        this.kick();
      });
    }
  }
  async run(job, controller) {
    const dir = path.join(this.jobsDir, job.id);
    try {
      await this.runner(job, dir, controller.signal);
      controller.signal.throwIfAborted();
      if (this.afterRun) await this.afterRun(job, dir, controller.signal, (phase) => this.store.phase(job.id, phase));
      controller.signal.throwIfAborted();
      this.store.phase(job.id, "检查图片与导出");
      const manifest = await deliver(job, dir);
      controller.signal.throwIfAborted();
      this.store.succeed(job.id, manifest);
      await this.onSuccess?.(job, manifest, dir).catch?.(() => {});
    } catch (error) {
      const partial = await partialDelivery(job, dir).catch(() => null);
      if (partial) {
        this.store.partial(job, partial, error.message);
        return;
      }
      this.store.fail(
        job.id,
        controller.signal.aborted ? "任务已取消，积分已退回" : "生成未完成，积分已退回。" + error.message,
        controller.signal.aborted ? "cancelled" : "failed",
      );
    }
  }
  cancel(id) {
    const entry = this.running.get(id);
    if (entry) return entry.controller.abort();
    this.store.fail(id, "任务已取消，积分已退回", "cancelled");
  }
  async close() {
    this.stopped = true;
    for (const entry of this.running.values()) entry.controller.abort();
    await Promise.allSettled([...this.running.values()].map((entry) => entry.done));
  }
}
