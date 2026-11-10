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
  const model2k = config?.model2k || env.IMAGE_API_MODEL_2K || "gpt-image-2.6-sunburst";
  const model4k = config?.model4k || env.IMAGE_API_MODEL_4K || "gpt-image-2-4K";
  const imageModels = [model2k, model4k];
  const apiRun = createImageRunner(config, fetchImpl);
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
          ? await checkImageApi(config, fetchImpl)
          : apiOnly ? { ready: false, message: "工作台已启用纯 API 模式" } : await codexCheck();
      if (
        mode === "api" &&
        states.api.ready &&
        !imageModels.some((m) => states.api.models?.includes(m))
      )
        states.api = {
          ...states.api,
          ready: false,
          message: "此密钥没有可选的 2.5 / 2.0 4K 图片模型",
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
        throw new AppError("2.0 4K 生图服务未就绪，请先检查连接", 409);
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
      await (mode === "api" ? apiRun : codexRun)(job, dir, signal);
    },
  };
}
