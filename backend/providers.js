import { codexRunner, checkCodex } from "./runner.js";
import { imageConfig, createImageRunner, checkImageApi, probeImageModel } from "./image-api.js";
import { imageSize, upscaleSize } from "../shared/generation.js";
import { AppError } from "./store.js";

export function createProviders({
  env = process.env,
  codexRun = codexRunner,
  codexCheck = checkCodex,
  fetchImpl = fetch,
} = {}) {
  const apiOnly = env.API_ONLY === "1";
  const config = imageConfig(env);
  const secondary = imageConfig({
    ...env,
    IMAGE_API_BASE_URL: env.IMAGE_API_SECONDARY_BASE_URL,
    IMAGE_API_KEY: env.IMAGE_API_SECONDARY_KEY,
    IMAGE_API_CONCURRENCY: env.IMAGE_API_SECONDARY_CONCURRENCY || "3",
  });
  const channels = [config, secondary].filter(Boolean)
    .filter((c, i, all) => all.findIndex(x => x.base === c.base && x.key === c.key) === i);
  let channelStates = [];
  const model2k = config?.model2k || env.IMAGE_API_MODEL_2K || "gpt-image-2.6-sunburst";
  const model4k = config?.model4k || env.IMAGE_API_MODEL_4K || "gpt-image-2.6-sunburst";
  const imageModels = [...new Set([model2k, model4k])];
  const states = {};
  const names = { codex: "本机 Codex", api: "中转生图 API" };
  const validate = (mode) => {
    if (!Object.hasOwn(names, mode)) throw new AppError("生成模式无效");
  };
  const describe = (mode) => ({
    mode,
    label: names[mode],
    ...states[mode],
    models:
      mode === "api"
        ? imageModels.filter((m) => states.api?.models?.includes(m))
        : [],
    ...(mode === "api"
      ? { modelsByResolution: { "1K": model2k, "2K": model2k, "4K": model4k } }
      : {}),
  });
  return {
    apiOnly,
    defaultMode: apiOnly || env.GENERATION_PROVIDER === "api" ? "api" : "codex",
    validate,
    describe,
    list: () => (apiOnly ? ["api"] : Object.keys(names)).map(describe),
    // Everything the relay key can see, not just the two configured models.
    allModels: () => states.api?.models || [],
    probe: (opts) => probeImageModel(config, opts, fetchImpl),
    async check(mode) {
      validate(mode);
      states[mode] =
        mode === "api"
          ? await (async () => {
              channelStates = await Promise.all(channels.map(c => checkImageApi(c, fetchImpl)));
              const ready = channelStates.filter(s => s.ready);
              return {
                ready: ready.length > 0,
                models: [...new Set(ready.flatMap(s => s.models))],
                channelCount: ready.length,
                concurrency: channels.reduce((n, c, i) => n + (channelStates[i].ready ? c.concurrency : 0), 0),
                message: ready.length ? `已连接 ${ready.length} 个生图通道` : "生图 API 鉴权失败或未配置，请检查通道设置",
              };
            })()
          : apiOnly ? { ready: false, message: "工作台已启用纯 API 模式" } : await codexCheck();
      if (
        mode === "api" &&
        states.api.ready &&
        !imageModels.some((m) => states.api.models?.includes(m))
      )
        states.api = {
          ...states.api,
          ready: false,
          message: "已连接的通道没有配置的生图模型",
        };
      return describe(mode);
    },
    selection(body, fallback = "codex") {
      const mode = apiOnly ? "api" : body.providerMode || fallback;
      validate(mode);
      if (!states[mode]?.ready)
        throw new AppError(states[mode]?.message || "生成服务未就绪", 503);
      if (mode === "codex") return { providerMode: "codex" };
      const resolution = body.resolution || "2K";
      const imageModel = resolution === "4K" ? model4k : model2k;
      const requestedSize = imageSize(body.size || "1:1", resolution);
      if (
        !imageModels.includes(imageModel) ||
        !states.api.models.includes(imageModel)
      )
        throw new AppError("该 API 模型不可用");
      if (!requestedSize)
        throw new AppError("此画幅不支持所选分辨率；4K 请使用 16:9");
      return { providerMode: mode, imageModel, resolution, requestedSize };
    },
    upscaleSelection(width, height) {
      if (!states.api?.ready || !states.api.models.includes(model4k))
        throw new AppError("4K 生图服务未就绪，请先检查连接", 409);
      return {
        providerMode: "api",
        imageModel: model4k,
        resolution: "4K",
        requestedSize: upscaleSize(width, height),
        operation: "upscale",
        sourceWidth: width,
        sourceHeight: height,
      };
    },
    async run(job, dir, signal) {
      const mode = job.params.providerMode || "codex";
      validate(mode);
      if (apiOnly && mode !== "api") throw new AppError("工作台已启用纯 API 模式");
      if (mode === "api") {
        const available = channels.flatMap((c, i) =>
          channelStates[i]?.ready && channelStates[i].models.includes(job.params.imageModel)
            ? [{ ...c, id: `channel-${i + 1}` }] : []);
        if (!available.length) throw new AppError("没有支持此模型的可用生图通道", 503);
        await createImageRunner(config || available[0], fetchImpl, available)(job, dir, signal);
      } else await codexRun(job, dir, signal);
    },
  };
}
