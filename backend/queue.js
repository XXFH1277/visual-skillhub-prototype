import path from "node:path";
import { deliver } from "./media.js";

export class JobQueue {
  constructor(store, jobsDir, runner, afterRun = null) {
    this.store = store;
    this.afterRun = afterRun;
    this.jobsDir = jobsDir;
    this.runner = runner;
    this.stopped = false;
    this.store.recover();
  }
  kick() {
    if (this.stopped || this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (!this.stopped && this.store.next()) this.kick();
    });
  }
  async drain() {
    for (let job; !this.stopped && (job = this.store.next());) {
      if (!this.store.start(job.id)) continue;
      const controller = new AbortController();
      this.active = { id: job.id, controller };
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
      } catch (error) {
        this.store.fail(
          job.id,
          controller.signal.aborted
            ? "任务已取消，积分已退回"
            : "生成未完成，积分已退回。" + error.message,
          controller.signal.aborted ? "cancelled" : "failed",
        );
      } finally {
        this.active = null;
      }
    }
  }
  cancel(id) {
    if (this.active?.id === id) {
      this.active.controller.abort();
      return;
    }
    this.store.fail(id, "任务已取消，积分已退回", "cancelled");
  }
  async close() {
    this.stopped = true;
    this.active?.controller.abort();
    await this.draining;
  }
}
