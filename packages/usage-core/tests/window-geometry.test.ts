import { expect, it, vi } from "vitest";
import {
  captureWindowGeometry,
  isReachableWindowPosition,
} from "../../../apps/desktop/src/settings/windowGeometry";

it("rejects the minimized placement and removed displays without rejecting a monitor on the left", () => {
  const main = { workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } } };
  const left = { workArea: { position: { x: -1280, y: 0 }, size: { width: 1280, height: 760 } } };
  expect(isReachableWindowPosition({ x: -32000, y: -32000 }, [main, left])).toBe(false);
  expect(isReachableWindowPosition({ x: -1000, y: 80 }, [main])).toBe(false);
  expect(isReachableWindowPosition({ x: -1000, y: 80 }, [main, left])).toBe(true);
});

it("keeps normal geometry through minimization, including when it starts during capture", async () => {
  const win = {
    isMinimized: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    innerSize: vi.fn(async () => ({ width: 1125, height: 875 })),
    outerPosition: vi.fn(async () => ({ x: 125, y: 75 })),
    scaleFactor: async () => 1.25,
  };
  expect(await captureWindowGeometry(win)).toEqual({ width: 900, height: 700, x: 100, y: 60 });
  win.isMinimized.mockResolvedValueOnce(true);
  expect(await captureWindowGeometry(win)).toBeNull();
  expect(win.innerSize).toHaveBeenCalledTimes(1);
  win.isMinimized.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await captureWindowGeometry(win)).toBeNull();
  win.outerPosition.mockResolvedValueOnce({ x: -32000, y: -32000 });
  expect(await captureWindowGeometry(win)).toBeNull();
});
