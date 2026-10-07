// Pointer coordinates are CSS pixels, independent of canvas backing resolution.
export function minimapPoint(bounds, rect, clientX, clientY) {
  if (!bounds || !(rect.width > 0) || !(rect.height > 0)) return null;
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  return { x: bounds.minX + x * (bounds.maxX - bounds.minX),
    y: bounds.maxY - y * (bounds.maxY - bounds.minY) };
}
