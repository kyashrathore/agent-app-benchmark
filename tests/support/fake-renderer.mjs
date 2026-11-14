/** A renderer stand-in for the in-page clock and recorders: frames advance only when a test steps them. */
export function element({ top = 0, height = 20, text = "", key = "", editable = false } = {}) {
  return {
    style: {},
    key,
    top,
    height,
    innerText: text,
    isContentEditable: editable,
    scrollTop: 0,
    scrollHeight: 400,
    clientHeight: 400,
    children: [],
    append(child) {
      this.children.push(child);
    },
    remove() {},
    contains(other) {
      return other === this || this.children.includes(other);
    },
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { top: this.top, bottom: this.top + this.height, width: 100, height: this.height };
    },
  };
}

export function fakeRenderer() {
  const saved = new Map();
  const replace = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let now = 1_000;
  Object.defineProperty(performance, "now", { configurable: true, value: () => now });
  let animationFrames = [];
  let resizeObservers = [];
  let pendingMutations = [];
  const listeners = new Map();
  const transcript = element({ height: 400 });
  const rows = [element({ top: 10, text: "question", key: "user" }), element({ top: 40, text: "answer", key: "assistant" })];
  for (const row of rows) transcript.append(row);
  const fixture = { displayed: false, transcript, rows, composer: element({ editable: true }), placeholder: false };
  replace("__fixture", fixture);
  replace("document", {
    visibilityState: "visible",
    hasFocus: () => true,
    createElement: () => element(),
    documentElement: element(),
  });
  replace("window", {
    addEventListener: (type, listener) => listeners.set(type, new Set([...(listeners.get(type) ?? []), listener])),
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
  });
  replace("getComputedStyle", () => ({ display: "block", visibility: "visible", opacity: "1" }));
  replace("requestAnimationFrame", (callback) => animationFrames.push(callback));
  replace("ResizeObserver", class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      resizeObservers.push(this);
    }
    disconnect() {}
  });
  replace("MutationObserver", class {
    observe() {}
    takeRecords() {
      return pendingMutations.splice(0);
    }
    disconnect() {}
  });
  replace("HTMLTextAreaElement", class {});
  replace("HTMLInputElement", class {});
  replace("Element", Object);
  return {
    fixture,
    frame() {
      now += 8;
      const callbacks = animationFrames;
      animationFrames = [];
      for (const callback of callbacks) callback(now);
      const observers = resizeObservers;
      resizeObservers = [];
      now += 0.5;
      for (const observer of observers) observer.callback();
    },
    pointerdown() {
      this.dispatch("pointerdown", { isTrusted: true });
    },
    dispatch(type, event) {
      now += 1;
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    now: () => now,
    mutate() {
      pendingMutations.push({ target: fixture.rows[1] });
    },
    restore() {
      delete performance.now;
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

