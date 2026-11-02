import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { preparePrompts, frameInputs } from "./prompts.js";

export function resolveCodex() {
  const override = process.env.CODEX_BIN;
  if (override)
    return override.endsWith(".js")
      ? { command: process.execPath, prefix: [override] }
      : { command: override, prefix: [] };
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const file = path.join(
      dir,
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    if (fs.existsSync(file)) return { command: file, prefix: [] };
    const script = path.join(
      dir,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (fs.existsSync(script))
      return { command: process.execPath, prefix: [script] };
  }
  throw new Error(
    "找不到 Codex CLI，请安装后登录，或设置 CODEX_BIN 为可执行文件或 codex.js 的完整路径",
  );
}

export function runProcess(
  command,
  args,
  { cwd, input, signal, timeoutMs = 15 * 60 * 1000, logFile } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("任务已取消"));
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
    });
    let output = "",
      failure,
      settled = false,
      killTimer;
    if (logFile) fs.writeFileSync(logFile, "");
    const capture = (data) => {
      if (output.length >= 200_000) return;
      const chunk = data.toString().slice(0, 200_000 - output.length);
      output += chunk;
      try {
        if (logFile) fs.appendFileSync(logFile, chunk);
      } catch {}
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const stop = (message) => {
      failure = new Error(message);
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => child.kill());
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill();
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 2000);
      }
    };
    const abort = () => stop("任务已取消");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("生成超时，请稍后重试"), timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      try {
        if (logFile) fs.writeFileSync(logFile, output);
      } catch {}
      if (error) reject(error);
      else resolve(output);
    };
    child.on("error", () =>
      finish(new Error("无法启动 Codex，请检查 CODEX_BIN 和本机登录状态")),
    );
    child.on("close", (code) =>
      finish(
        failure ||
          (code === 0
            ? null
            : new Error(
                `Codex 执行失败（退出码 ${code}），请查看本机任务日志`,
              )),
      ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

export async function checkCodex() {
  try {
    const cli = resolveCodex();
    const version = await runProcess(
      cli.command,
      [...cli.prefix, "--version"],
      { timeoutMs: 10000 },
    );
    await runProcess(cli.command, [...cli.prefix, "login", "status"], {
      timeoutMs: 10000,
    });
    return {
      ready: true,
      version: version.trim(),
      message: "CLI 已安装并登录；实际生图能力以生成结果为准",
    };
  } catch (error) {
    return { ready: false, message: error.message };
  }
}

export function createCodexRunner({
  resolve = resolveCodex,
  execute = runProcess,
} = {}) {
  return async (job, dir, signal) => {
    const cli = resolve();
    const prompts = await preparePrompts(job.params, dir);
    const prompt = `你正在执行私人视觉工作台的专用 Skill。
只使用任务附件和内置图像生成工具；不要调用其他 API、读取凭据或联网。只在当前任务目录写文件。
每个 prompt-N.txt 是一张独立图片的完整生成要求（含它用到的附件编号），按序逐张生成。
逐张生成恰好 ${job.params.count} 张图片，不自动追加重试或扩展图包。
仅保存本次工具实际生成的图片为 result-1.png 至 result-${job.params.count}.png；失败时明确失败，不使用原图、占位图或其他任务结果替代。
以下为逐张完整提示词（也已保存到对应文件）：
${prompts.map((p, i) => `=== prompt-${i + 1}.txt（附件：${frameInputs(job.params, i).join("、") || "无"}）===\n${p}`).join("\n\n")}
完成后简要说明生成情况。`;
    const args = [
      ...cli.prefix,
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "-s",
      "workspace-write",
      "-C",
      dir,
      "--color",
      "never",
      "-o",
      path.join(dir, "last-message.txt"),
    ];
    const attached = new Set(job.params.frames.flatMap((_, i) => frameInputs(job.params, i)));
    for (const name of attached) args.push("-i", path.join(dir, name));
    args.push("-");
    await execute(cli.command, args, {
      cwd: dir,
      input: prompt,
      signal,
      logFile: path.join(dir, "codex.log"),
      timeoutMs: Number(process.env.GENERATION_TIMEOUT_MS) || 15 * 60 * 1000,
    });
  };
}
export const codexRunner = createCodexRunner();
