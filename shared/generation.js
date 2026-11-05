export const IMAGE_SIZES = {
  "1:1": { "1K": "1024x1024", "2K": "2048x2048" },
  "3:4": { "1K": "768x1024", "2K": "1536x2048" },
  "4:3": { "1K": "1024x768", "2K": "2048x1536" },
  "16:9": { "1K": "1280x720", "2K": "2048x1152", "4K": "3840x2160" },
};

export function imageSize(aspect, resolution) {
  return IMAGE_SIZES[aspect]?.[resolution] || null;
}

export function upscaleSize(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 256 ||
    height < 256 ||
    width * height > 40000000
  )
    throw new Error("原图尺寸无效");
  if (Math.abs(width / height - 16 / 9) < 0.02) return "3840x2160";
  if (Math.abs(height / width - 16 / 9) < 0.02) return "2160x3840";
  const scale = 4096 / Math.max(width, height);
  return `${Math.round((width * scale) / 16) * 16}x${Math.round((height * scale) / 16) * 16}`;
}
