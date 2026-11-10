// Only the displayed image uses this URL. Links and downloads keep the original.
export function preview(url, width = 720) {
  return url + (url.includes("?") ? "&" : "?") + "thumb=" + width;
}
