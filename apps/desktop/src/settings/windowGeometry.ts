import { clamp, type WindowGeometry } from "./types";

interface Position { x: number; y: number }
interface Size { width: number; height: number }

export function isReachableWindowPosition(
  position: Position,
  monitors: { workArea: { position: Position; size: Size } }[],
): boolean {
  return monitors.some(({ workArea: { position: origin, size } }) =>
    position.x >= origin.x && position.x + 64 <= origin.x + size.width &&
    position.y >= origin.y && position.y + 32 <= origin.y + size.height,
  );
}

interface GeometryWindow {
  isMinimized(): Promise<boolean>;
  innerSize(): Promise<Size>;
  outerPosition(): Promise<Position>;
  scaleFactor(): Promise<number>;
}

export async function captureWindowGeometry(win: GeometryWindow): Promise<WindowGeometry | null> {
  if (await win.isMinimized()) return null;
  const size = await win.innerSize();
  const position = await win.outerPosition();
  const scale = await win.scaleFactor();
  // Windows can return the iconic placement while minimization is in progress.
  if (await win.isMinimized() || size.width <= 0 || size.height <= 0 ||
      !Number.isFinite(scale) || scale <= 0 || (position.x === -32000 && position.y === -32000)) {
    return null;
  }
  return {
    width: clamp(Math.round(size.width / scale), 400, 10000),
    height: clamp(Math.round(size.height / scale), 300, 10000),
    x: Math.round(position.x / scale),
    y: Math.round(position.y / scale),
  };
}
