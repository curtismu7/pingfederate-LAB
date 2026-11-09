// FloatingDialog tests (vitest + Testing Library + jsdom). Ported from AI-DEMO2's DraggableModal.test.jsx,
// DraggableModal.focus.test.jsx and useDraggablePanel.test.js, plus the keyboard, narrow-screen and blocked-popup paths.
import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import FloatingDialog from "./FloatingDialog";

// jsdom has no PointerEvent; a MouseEvent named pointer* carries clientX/Y and bubbles to React's listeners.
const ptr = (el, type, x, y) => act(() => { el.dispatchEvent(new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true })); });
const px = (v) => Number.parseFloat(v);
// geometry is set as custom properties (--fd-x/-y/-w/-h) that floating-dialog.css turns into left/top/width/height
const geo = (d) => ({ get left() { return d.style.getPropertyValue("--fd-x"); }, get top() { return d.style.getPropertyValue("--fd-y"); },
  get width() { return d.style.getPropertyValue("--fd-w"); }, get height() { return d.style.getPropertyValue("--fd-h"); } });

function fakeWindow(doc = document.implementation.createHTMLDocument("")) {
  Object.defineProperty(doc, "defaultView", { value: window });
  const listeners = {};
  return {
    closed: false,
    document: doc,
    listeners,
    addEventListener: vi.fn((t, f) => { (listeners[t] ||= []).push(f); }),
    removeEventListener: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(function close() { this.closed = true; (listeners.pagehide || []).forEach((f) => f()); }),
  };
}

function Harness({ props = {}, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>opener</button>
      <button type="button">page button</button>
      <FloatingDialog isOpen={open} onClose={() => setOpen(false)} title="Probe" defaultX={100} defaultY={100} defaultWidth={400} defaultHeight={300} {...props}>
        {children ?? <><button type="button">first</button><button type="button">second</button></>}
      </FloatingDialog>
    </div>
  );
}

// Content whose state lives in the parent page, to prove the popped-out copy stays live.
function Counter() {
  const [n, setN] = useState(0);
  return (
    <FloatingDialog isOpen onClose={() => {}} title="Counter" footer={null}>
      <button type="button" onClick={() => setN((v) => v + 1)}>add</button>
      <output data-testid="count">{n}</output>
    </FloatingDialog>
  );
}

beforeEach(() => { window.innerWidth = 1280; window.innerHeight = 900; localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.documentElement.removeAttribute("data-theme"); delete window.matchMedia; });

describe("layout", () => {
  test("a named dialog with a focusable title bar, eight resize handles, pop-out and close", () => {
    render(<FloatingDialog isOpen onClose={() => {}} title="Probe" className="probe"><p>body</p></FloatingDialog>);
    const d = screen.getByRole("dialog", { name: "Probe" });
    expect(d).toHaveClass("fd-panel", "probe");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.querySelectorAll(".fd-handle")).toHaveLength(8);
    expect(screen.getByTestId("fd-titlebar").tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "Pop out to a new window" })).toBeTruthy();
    expect(within(d).getAllByRole("button", { name: "Close" })).toHaveLength(2); // title bar + default footer
  });

  test("footer={null} drops the footer, a node replaces it; noBackdrop is not aria-modal and has no backdrop", () => {
    const { rerender } = render(<FloatingDialog isOpen noBackdrop onClose={() => {}} title="P" footer={null}><p>b</p></FloatingDialog>);
    expect(document.querySelector(".fd-footer")).toBeNull();
    expect(document.querySelector(".fd-backdrop")).toBeNull();
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBeNull();
    rerender(<FloatingDialog isOpen noBackdrop onClose={() => {}} title="P" footer={<span>custom</span>}><p>b</p></FloatingDialog>);
    expect(document.querySelector(".fd-footer").textContent).toBe("custom");
  });

  test("placement right only chooses where it opens; drag and keys still move it", () => {
    render(<FloatingDialog isOpen onClose={() => {}} title="P" placement="right" defaultWidth={400} defaultHeight={300}><p>b</p></FloatingDialog>);
    const d = screen.getByRole("dialog");
    expect([px(geo(d).left), px(geo(d).top)]).toEqual([1280 - 400 - 8, 8]);
    fireEvent.keyDown(screen.getByTestId("fd-titlebar"), { key: "ArrowLeft", shiftKey: true });
    expect(px(geo(d).left)).toBe(1280 - 400 - 8 - 50);
  });

  test("geometry is set as --fd-* custom properties, never as inline left/top/width/height (so the sheet can override it)", () => {
    render(<FloatingDialog isOpen onClose={() => {}} title="P" defaultX={30} defaultY={40} defaultWidth={400} defaultHeight={300} zIndex={1200}
      style={{ left: 5, top: 6, right: 7, bottom: 8, width: 9, height: 10, "--lane": "var(--accent)", maxWidth: "90vw" }}><p>b</p></FloatingDialog>);
    const d = screen.getByRole("dialog");
    expect([geo(d).left, geo(d).top, geo(d).width, geo(d).height]).toEqual(["30px", "40px", "400px", "300px"]);
    for (const k of ["left", "top", "right", "bottom", "width", "height"]) expect(d.style[k], k).toBe("");
    expect(d.style.getPropertyValue("--lane")).toBe("var(--accent)"); // a caller's other styles still apply
    expect(d.style.maxWidth).toBe("90vw");
    expect(d.style.zIndex).toBe("1200");
    expect(d.getAttribute("data-autoheight")).toBeNull();
  });

  test("defaultHeight={null} fits the content: --fd-h is auto and data-autoheight is set", () => {
    render(<FloatingDialog isOpen onClose={() => {}} title="P" defaultHeight={null}><p>b</p></FloatingDialog>);
    const d = screen.getByRole("dialog");
    expect(geo(d).height).toBe("auto");
    expect(d.getAttribute("data-autoheight")).toBe("true");
  });

  test("nothing renders when closed", () => {
    render(<FloatingDialog isOpen={false} onClose={() => {}} title="P"><p>b</p></FloatingDialog>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("drag and resize", () => {
  test("drags by the title bar; not from its buttons or the body", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));
    const d = screen.getByRole("dialog");
    const bar = screen.getByTestId("fd-titlebar");
    ptr(screen.getByText("first"), "pointerdown", 110, 110);
    ptr(screen.getByText("first"), "pointermove", 200, 200);
    expect(geo(d).left).toBe("100px");
    ptr(screen.getByRole("button", { name: "Pop out to a new window" }), "pointerdown", 110, 110);
    ptr(bar, "pointermove", 200, 200);
    expect(geo(d).left).toBe("100px");
    ptr(bar, "pointerdown", 110, 110);
    ptr(bar, "pointermove", 160, 150);
    ptr(bar, "pointerup", 160, 150);
    expect(geo(d).left).toBe("150px");
    expect(geo(d).top).toBe("140px");
  });

  test("resize grows from the east edge and stops at the minimum width and height", () => {
    render(<Harness props={{ minWidth: 300, minHeight: 200 }} />);
    fireEvent.click(screen.getByText("opener"));
    const d = screen.getByRole("dialog");
    const se = d.querySelector(".fd-handle-se");
    ptr(se, "pointerdown", 500, 400);
    ptr(document, "pointermove", 560, 450);
    expect([px(geo(d).width), px(geo(d).height)]).toEqual([460, 350]);
    ptr(document, "pointermove", -900, -900);
    expect([px(geo(d).width), px(geo(d).height)]).toEqual([300, 200]);
    ptr(document, "pointerup", 0, 0);
  });

  test("growing from the north-west edge cannot push the title bar off the top or left", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));
    const d = screen.getByRole("dialog");
    ptr(d.querySelector(".fd-handle-nw"), "pointerdown", 100, 100);
    ptr(document, "pointermove", -500, -500);
    ptr(document, "pointerup", -500, -500);
    expect([px(geo(d).left), px(geo(d).top)]).toEqual([0, 0]);
    expect([px(geo(d).width), px(geo(d).height)]).toEqual([500, 400]);
  });
});

describe("keyboard", () => {
  test("arrow keys on the title bar move 10px, Shift 50px, and stay inside the window", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));
    const d = screen.getByRole("dialog");
    const bar = screen.getByTestId("fd-titlebar");
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    fireEvent.keyDown(bar, { key: "ArrowDown", shiftKey: true });
    expect([px(geo(d).left), px(geo(d).top)]).toEqual([110, 150]);
    for (let i = 0; i < 40; i += 1) fireEvent.keyDown(bar, { key: "ArrowLeft", shiftKey: true });
    expect(px(geo(d).left)).toBe(8);
  });

  test("Alt + arrow keys resize, down to the minimum", () => {
    render(<Harness props={{ minWidth: 380 }} />);
    fireEvent.click(screen.getByText("opener"));
    const d = screen.getByRole("dialog");
    const bar = screen.getByTestId("fd-titlebar");
    fireEvent.keyDown(bar, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(bar, { key: "ArrowDown", altKey: true, shiftKey: true });
    expect([px(geo(d).width), px(geo(d).height)]).toEqual([410, 350]);
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(bar, { key: "ArrowLeft", altKey: true });
    expect(px(geo(d).width)).toBe(380);
  });

  test("Alt + arrow keys cannot grow it past the right or bottom edge of the window", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));
    const d = screen.getByRole("dialog");
    const bar = screen.getByTestId("fd-titlebar");
    for (let i = 0; i < 40; i += 1) {
      fireEvent.keyDown(bar, { key: "ArrowRight", altKey: true, shiftKey: true });
      fireEvent.keyDown(bar, { key: "ArrowDown", altKey: true, shiftKey: true });
    }
    expect([px(geo(d).width), px(geo(d).height)]).toEqual([1280 - 100 - 8, 900 - 100 - 8]);
  });

  test("arrow keys on a button inside the title bar do not move the dialog", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));
    fireEvent.keyDown(screen.getByRole("button", { name: "Pop out to a new window" }), { key: "ArrowRight" });
    expect(geo(screen.getByRole("dialog")).left).toBe("100px");
  });
});

describe("focus and closing", () => {
  test("focus moves in on open; Escape closes and focus returns to the opener", () => {
    render(<Harness />);
    const opener = screen.getByText("opener");
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("the footer Close also returns focus to the opener", () => {
    render(<Harness />);
    const opener = screen.getByText("opener");
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(document.querySelector(".fd-close-btn"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("a modal keeps Tab inside (wraps at both ends)", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));
    const d = screen.getByRole("dialog");
    const items = [...d.querySelectorAll("button, [tabindex='0']")];
    items[items.length - 1].focus();
    fireEvent.keyDown(document.activeElement, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.activeElement, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  test("Tab and Shift+Tab from the panel itself (or from outside) are pulled in, never out", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));
    const d = screen.getByRole("dialog");
    const items = [...d.querySelectorAll("button, [tabindex='0']")];
    d.focus();
    fireEvent.keyDown(d, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(items[items.length - 1]);
    d.focus();
    fireEvent.keyDown(d, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
  });

  test("a non-modal panel closes on Escape only while focus is inside it", () => {
    const onClose = vi.fn();
    render(<><button type="button">outside</button><FloatingDialog isOpen noBackdrop onClose={onClose} title="P"><p>b</p></FloatingDialog></>);
    fireEvent.keyDown(screen.getByText("outside"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("singletonKey: a second dialog with the same key closes itself", () => {
    const second = vi.fn();
    render(<>
      <FloatingDialog isOpen onClose={() => {}} title="One" singletonKey="k"><p>1</p></FloatingDialog>
      <FloatingDialog isOpen onClose={second} title="Two" singletonKey="k"><p>2</p></FloatingDialog>
    </>);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("persistence", () => {
  test("position and size are saved on release and restored, clamped into the window", () => {
    const { unmount } = render(<Harness props={{ storageKey: "fd.test" }} />);
    fireEvent.click(screen.getByText("opener"));
    const bar = screen.getByTestId("fd-titlebar");
    ptr(bar, "pointerdown", 110, 110);
    ptr(bar, "pointermove", 3110, 110);
    ptr(bar, "pointerup", 3110, 110);
    expect(JSON.parse(localStorage.getItem("fd.test")).pos.x).toBe(3100); // live drag is unclamped (second monitor)
    unmount();
    render(<Harness props={{ storageKey: "fd.test" }} />);
    fireEvent.click(screen.getByText("opener"));
    expect(px(geo(screen.getByRole("dialog")).left)).toBe(1280 - 400 - 8);
  });

  test("a restored position is clamped on every side, and a restored size to min..window", () => {
    const open = (saved) => {
      localStorage.setItem("fd.c", JSON.stringify(saved));
      const r = render(<Harness props={{ storageKey: "fd.c", minWidth: 300, minHeight: 200 }} />);
      fireEvent.click(screen.getByText("opener"));
      const d = screen.getByRole("dialog");
      const out = [px(geo(d).left), px(geo(d).top), px(geo(d).width), px(geo(d).height)];
      r.unmount();
      return out;
    };
    expect(open({ pos: { x: 5000, y: 5000 }, size: { w: 400, h: 300 } })).toEqual([1280 - 400 - 8, 900 - 300 - 8, 400, 300]); // right + bottom
    expect(open({ pos: { x: 100, y: -400 }, size: { w: 400, h: 300 } })).toEqual([100, 8, 400, 300]); // top
    expect(open({ pos: { x: 100, y: 100 }, size: { w: 10, h: 5 } })).toEqual([100, 100, 300, 200]); // below min
    expect(open({ pos: { x: 0, y: 0 }, size: { w: 9000, h: 9000 } })).toEqual([8, 8, 1280 - 16, 900 - 16]); // above window
    expect(open({ pos: { x: 0, y: 0 }, size: { w: 400, h: "tall" } })).toEqual([8, 8, 400, 300]); // invalid size: defaults
  });

  test("storage that throws (private window) does not break the dialog", () => {
    const own = Object.getOwnPropertyDescriptor(window, "localStorage");
    const boom = () => { throw new Error("blocked"); };
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: boom, setItem: boom, removeItem: boom, clear: () => {} } });
    try {
      render(<Harness props={{ storageKey: "fd.test" }} />);
      fireEvent.click(screen.getByText("opener"));
      fireEvent.keyDown(screen.getByTestId("fd-titlebar"), { key: "ArrowRight" });
      expect(geo(screen.getByRole("dialog")).left).toBe("110px");
    } finally {
      if (own) Object.defineProperty(window, "localStorage", own); else delete window.localStorage;
    }
  });
});

describe("narrow screens", () => {
  test("at 600px and below it is a sheet: no handles, title bar not a move target, drag does nothing", () => {
    window.matchMedia = vi.fn((q) => ({ matches: q === "(max-width: 600px)", addEventListener: () => {}, removeEventListener: () => {} }));
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));
    const d = screen.getByRole("dialog");
    expect(d.getAttribute("data-narrow")).toBe("true");
    expect(d.querySelectorAll(".fd-handle")).toHaveLength(0);
    const bar = screen.getByTestId("fd-titlebar");
    expect(bar.hasAttribute("tabindex")).toBe(false);
    ptr(bar, "pointerdown", 110, 110);
    ptr(bar, "pointermove", 200, 200);
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(geo(d).left).toBe("100px");
  });
});

describe("pop-out", () => {
  test("opens a same-origin blank popup with this page's stylesheets and theme, and renders the content there", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/assets/app.css"; document.head.appendChild(link);
    const st = document.createElement("style"); st.textContent = ".probe-rule{}"; document.head.appendChild(st);
    const win = fakeWindow();
    const open = vi.spyOn(window, "open").mockReturnValue(win);
    render(<Counter />);
    fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
    expect(open).toHaveBeenCalledTimes(1);
    const [url, name, features] = open.mock.calls[0];
    expect(url).toBe("");
    expect(name).toMatch(/^fd_/);
    expect(features).toMatch(/^popup,width=\d+,height=\d+/);
    const doc = win.document;
    expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(doc.head.querySelector('link[rel="stylesheet"]').getAttribute("href")).toBe(link.href);
    expect([...doc.head.querySelectorAll("style")].some((s) => s.textContent.includes(".probe-rule"))).toBe(true);
    expect(within(doc.body).getByRole("dialog", { name: "Counter" })).toBeTruthy();
    // the in-page dialog is replaced by the placeholder
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("fd-placeholder").textContent).toContain("Counter is open in a separate window");
    link.remove(); st.remove();
  });

  test("the popped-out content stays live: a click there updates state held in this page", () => {
    const win = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win);
    render(<Counter />);
    fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
    act(() => { within(win.document.body).getByText("add").click(); });
    act(() => { within(win.document.body).getByText("add").click(); });
    expect(within(win.document.body).getByTestId("count").textContent).toBe("2");
  });

  test("closing the window brings the dialog back in the page, with its state", () => {
    const win = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win);
    render(<Counter />);
    fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
    act(() => { within(win.document.body).getByText("add").click(); });
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(win.focus).toHaveBeenCalled();
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Close window" })); });
    expect(win.close).toHaveBeenCalled();
    expect(screen.queryByTestId("fd-placeholder")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Counter" })).toBeTruthy();
    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  test("the close button in the popup closes the window and the dialog", () => {
    const win = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win);
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));
    fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
    act(() => { within(win.document.body).getAllByRole("button", { name: "Close" })[0].click(); });
    expect(win.close).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("fd-placeholder")).toBeNull();
  });

  test("a blocked popup keeps the dialog in the page and says so (no alert)", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Counter />);
    fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
    expect(screen.getByRole("dialog", { name: "Counter" })).toBeTruthy();
    expect(screen.getByTestId("fd-blocked").textContent).toContain("blocked the pop-out window");
    expect(alert).not.toHaveBeenCalled();
  });

  test("Escape in the popup closes it straight away, before anything there is clicked; the popped-out dialog has focus", () => {
    const win = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win);
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));
    // jsdom cannot move focus in a document with no window of its own, so check focus() was called on the dialog
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
    expect(focus.mock.contexts).toContain(win.document.querySelector(".fd-popout-layout"));
    act(() => { win.document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(win.close).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("fd-placeholder")).toBeNull();
  });

  test("the popup closes when this page unloads or navigates (no orphan)", () => {
    for (const type of ["pagehide", "beforeunload"]) {
      const win = fakeWindow();
      vi.spyOn(window, "open").mockReturnValue(win);
      const r = render(<Counter />);
      fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
      act(() => { window.dispatchEvent(new Event(type)); });
      expect(win.close).toHaveBeenCalled();
      r.unmount();
      vi.restoreAllMocks();
    }
  });

  test("the popup closes when the dialog unmounts, and when isOpen turns false", () => {
    const a = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(a);
    const r = render(<Counter />);
    fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
    r.unmount();
    expect(a.close).toHaveBeenCalled();
    const b = fakeWindow();
    window.open.mockReturnValue(b);
    const { rerender } = render(<FloatingDialog isOpen onClose={() => {}} title="P"><p>b</p></FloatingDialog>);
    fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
    rerender(<FloatingDialog isOpen={false} onClose={() => {}} title="P"><p>b</p></FloatingDialog>);
    expect(b.close).toHaveBeenCalled();
  });

  test("the window name is unique per page load, and a reused window is cleared before it is built", () => {
    const win = fakeWindow();
    const doc = win.document;
    // what an orphan from an earlier page load would hold
    const oldStyle = doc.createElement("style"); oldStyle.setAttribute("data-fd-copy", ""); oldStyle.textContent = ".old{}"; doc.head.appendChild(oldStyle);
    const oldRoot = doc.createElement("div"); oldRoot.id = "fd-root"; doc.body.appendChild(oldRoot);
    const st = document.createElement("style"); st.textContent = ".probe2{}"; document.head.appendChild(st);
    const open = vi.spyOn(window, "open").mockReturnValue(win);
    render(<Counter />);
    fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
    expect(open.mock.calls[0][1]).toMatch(/^fd_[0-9a-z]{6,}_fd\d+$/);
    expect(doc.querySelectorAll("#fd-root")).toHaveLength(1);
    expect([...doc.head.querySelectorAll("style")].filter((x) => x.textContent.includes(".old"))).toHaveLength(0);
    expect([...doc.head.querySelectorAll("style")].filter((x) => x.textContent.includes(".probe2"))).toHaveLength(1);
    st.remove();
  });

  test("a theme change in this page reaches the open popup", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const win = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win);
    render(<Counter />);
    fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
    expect(win.document.documentElement.getAttribute("data-theme")).toBe("light");
    await act(async () => { document.documentElement.setAttribute("data-theme", "dark"); await Promise.resolve(); });
    expect(win.document.documentElement.getAttribute("data-theme")).toBe("dark");
    await act(async () => { document.documentElement.removeAttribute("data-theme"); await Promise.resolve(); });
    expect(win.document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  test("if the browser replaces the blank document after it was built, it is built again and the content re-rendered", async () => {
    const win = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win);
    render(<Counter />);
    fireEvent.click(screen.getByRole("button", { name: "Pop out to a new window" }));
    // the async about:blank swap: a fresh document with no root, then load
    const fresh = document.implementation.createHTMLDocument("");
    Object.defineProperty(fresh, "defaultView", { value: window });
    win.document = fresh;
    await act(async () => { (win.listeners.load || []).forEach((f) => f()); await new Promise((r) => { setTimeout(r, 0); }); });
    expect(fresh.querySelectorAll("#fd-root")).toHaveLength(1);
    expect(within(fresh.body).getByRole("dialog", { name: "Counter" })).toBeTruthy();
    act(() => { within(fresh.body).getByText("add").click(); });
    expect(within(fresh.body).getByTestId("count").textContent).toBe("1");
  });

  test("disablePopOut hides the button", () => {
    render(<FloatingDialog isOpen onClose={() => {}} title="P" disablePopOut><p>b</p></FloatingDialog>);
    expect(screen.queryByRole("button", { name: "Pop out to a new window" })).toBeNull();
  });
});
