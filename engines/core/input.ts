/**
 * Abstract input: games consume named actions and axes; sources (keyboard,
 * touch, gamepad, Excel OnKey bridge, Playwright scripts) produce them.
 */
export type InputEvent =
  | { type: "action"; action: string; down: boolean }
  | { type: "axis"; axis: string; value: number }
  | { type: "pointer"; dx: number; dy: number };

export class InputState {
  private down = new Set<string>();
  private pressedEdge = new Set<string>();
  private axes = new Map<string, number>();
  lookDX = 0;
  lookDY = 0;

  apply(e: InputEvent): void {
    if (e.type === "action") {
      if (e.down) {
        if (!this.down.has(e.action)) this.pressedEdge.add(e.action);
        this.down.add(e.action);
      } else this.down.delete(e.action);
    } else if (e.type === "axis") {
      this.axes.set(e.axis, Math.max(-1, Math.min(1, e.value)));
    } else {
      this.lookDX += e.dx;
      this.lookDY += e.dy;
    }
  }
  held(a: string): boolean {
    return this.down.has(a);
  }
  /** True once per press; cleared by endFrame(). */
  pressed(a: string): boolean {
    return this.pressedEdge.has(a);
  }
  axis(name: string): number {
    return this.axes.get(name) ?? 0;
  }
  /** Combine a digital pair and an analogue axis into [-1, 1]. */
  combined(neg: string, pos: string, axisName?: string): number {
    let v = (this.held(pos) ? 1 : 0) - (this.held(neg) ? 1 : 0);
    if (axisName) v += this.axis(axisName);
    return Math.max(-1, Math.min(1, v));
  }
  endFrame(): void {
    this.pressedEdge.clear();
    this.lookDX = 0;
    this.lookDY = 0;
  }
  releaseAll(): void {
    this.down.clear();
    this.axes.clear();
  }
}

export interface KeyBinding {
  [code: string]: string;
}

/** Attach DOM keyboard listeners translating KeyboardEvent.code -> action. */
export function bindKeyboard(target: Window, bindings: KeyBinding, emit: (e: InputEvent) => void, shouldCapture: () => boolean): () => void {
  const onDown = (ev: KeyboardEvent) => {
    if (!shouldCapture()) return;
    const a = bindings[ev.code];
    if (!a) return;
    ev.preventDefault();
    emit({ type: "action", action: a, down: true });
  };
  const onUp = (ev: KeyboardEvent) => {
    const a = bindings[ev.code];
    if (!a) return;
    emit({ type: "action", action: a, down: false });
  };
  target.addEventListener("keydown", onDown);
  target.addEventListener("keyup", onUp);
  return () => {
    target.removeEventListener("keydown", onDown);
    target.removeEventListener("keyup", onUp);
  };
}
