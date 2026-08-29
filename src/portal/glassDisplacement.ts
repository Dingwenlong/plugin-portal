export function createDisplacementPixels(inputWidth: number, inputHeight: number) {
  if (!Number.isFinite(inputWidth) || !Number.isFinite(inputHeight)
    || inputWidth <= 0 || inputHeight <= 0 || inputWidth > 4096 || inputHeight > 256) {
    throw new Error("Invalid glass dimensions");
  }
  const width = Math.ceil(inputWidth);
  const height = Math.ceil(inputHeight);
  const radius = Math.min(width, height) / 2;
  const edge = Math.min(18, radius * .56);
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + .5;
    const py = y + .5;
    const centerX = Math.max(radius, Math.min(width - radius, px));
    const dx = px - centerX;
    const dy = py - height / 2;
    const distance = Math.hypot(dx, dy);
    const depth = radius - distance;
    // Only the rounded rim bends the backdrop; the reading area is neutral.
    const bend = depth >= 0 && depth < edge ? Math.pow(1 - depth / edge, 1.6) : 0;
    const offset = (y * width + x) * 4;
    pixels[offset] = 128 + (distance ? dx / distance * bend * 127 : 0);
    pixels[offset + 1] = 128 + (distance ? dy / distance * bend * 127 : 0);
    pixels[offset + 2] = 128;
    pixels[offset + 3] = 255;
  }
  return { width, height, pixels };
}

export function createGlassMapCache(encode: (width: number, height: number) => string, capacity = 6) {
  const entries = new Map<string, string>();
  return {
    get(width: number, height: number) {
      const key = `${width}x${height}`;
      let value = entries.get(key);
      if (value === undefined) value = encode(width, height);
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > capacity) entries.delete(entries.keys().next().value!);
      return value;
    },
  };
}

export const glassMaps = createGlassMapCache((width, height) => {
  const map = createDisplacementPixels(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = map.width;
  canvas.height = map.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Glass map rendering unavailable");
  const image = context.createImageData(map.width, map.height);
  image.data.set(map.pixels);
  context.putImageData(image, 0, 0);
  const url = canvas.toDataURL("image/png");
  canvas.width = canvas.height = 1;
  if (!url.startsWith("data:image/png")) throw new Error("Glass map encoding failed");
  return url;
});
