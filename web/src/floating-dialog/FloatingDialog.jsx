// FloatingDialog: the one modal / floating panel for standalone apps (owner 2026-11-09). Port of AI-DEMO2's
// DraggableModal (demo_api_ui/src/components/DraggableModal.jsx): drag by the title bar, 8-direction resize, pop-out to a
// real browser window with its own React root (so state stays live in this page), close button + Escape, optional
// footer Close, saved position/size, singleton key, min sizes, placement and focus handling. Added here: keyboard move
// and resize from the focused title bar, a full-width sheet on narrow screens, and a message when the popup is blocked.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { initialPosition } from "./geometry.js";
import { useFloatingPanel } from "./useFloatingPanel.js";
import "./floating-dialog.css";

export const NARROW_QUERY = "(max-width: 600px)";

const HANDLES = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let seq = 0;
const singletons = new Map();
// Unique per page load: a reload restarts `seq`, and window.open('', name) with an old name would reuse an orphaned popup.
const PAGE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
// Focus the popped-out dialog once, when it first mounts (a stable function, so re-renders do not steal focus).
const focusOnce = (el) => { if (el && !el.__fdFocused) { el.__fdFocused = true; el.focus(); } };

function useNarrow() {
  const [mq] = useState(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null));
  const [narrow, setNarrow] = useState(() => Boolean(mq?.matches));
  useEffect(() => {
    if (!mq) return undefined;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [mq]);
  return narrow;
}

// Renders children into a container in another window through a separate React root: events inside a foreign window
// never reach this page's root, so a plain createPortal would draw but not click. The parent keeps the state; every
// re-render here re-renders the popup. Unmount is deferred so React never unmounts a root during a commit.
export function PopOutPortal({ win, children, rootId = "fd-root" }) {
  const rootRef = useRef(null);
  useEffect(() => {
    const container = win.document.getElementById(rootId);
    if (!container) return undefined;
    if (container.__fdUnmountTimer) { clearTimeout(container.__fdUnmountTimer); container.__fdUnmountTimer = null; }
    let root = container.__fdRoot;
    if (!root) { root = createRoot(container); container.__fdRoot = root; }
    rootRef.current = root;
    root.render(children);
    return () => {
      rootRef.current = null;
      container.__fdUnmountTimer = setTimeout(() => {
        container.__fdUnmountTimer = null;
        try { root.unmount(); } catch { /* window already gone */ }
        if (container.__fdRoot === root) delete container.__fdRoot;
      }, 0);
    };
  }, [win, rootId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { rootRef.current?.render(children); }, [children]);
  return null;
}

function copyTheme(doc) {
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme) doc.documentElement.setAttribute("data-theme", theme);
  else doc.documentElement.removeAttribute("data-theme");
}

// Fill a popup's document: this page's stylesheets and theme, and one empty root for PopOutPortal. Anything a
// previous build left (a reused window) is removed first, so there is never a second root or duplicate styles.
function buildPopoutDocument(win, title) {
  const doc = win.document;
  for (const old of doc.head.querySelectorAll("[data-fd-copy]")) old.remove();
  doc.body.replaceChildren();
  doc.title = title;
  copyTheme(doc);
  for (const el of document.querySelectorAll('link[rel="stylesheet"], style')) {
    const copy = doc.importNode(el, true);
    if (el.tagName === "LINK") copy.setAttribute("href", el.href);
    copy.setAttribute("data-fd-copy", "");
    doc.head.appendChild(copy);
  }
  doc.body.className = "fd-popout-document";
  const root = doc.createElement("div");
  root.id = "fd-root";
  doc.body.appendChild(root);
}

// A same-origin blank window (never a URL), built for PopOutPortal. Null when the browser blocks it.
function openPopoutWindow({ name, title, w, h, left, top }) {
  let win = null;
  try { win = window.open("", name, `popup,width=${w},height=${h},left=${left},top=${top}`); } catch { win = null; }
  if (!win) return null;
  buildPopoutDocument(win, title);
  return win;
}

/**
 * Props (same names as DraggableModal where they mean the same):
 *   isOpen          boolean
 *   onClose         () => void (no close controls when omitted)
 *   title           node shown in the title bar
 *   ariaLabel       string, the dialog's accessible name (default: title when it is a string)
 *   className, style  added to the panel (and the popped-out layout)
 *   children        body content
 *   footer          undefined = a Close button; null = no footer; node = that node in the footer bar
 *   defaultWidth    number (520); defaultHeight number | null (600; null = fit the content until resized)
 *   defaultX, defaultY  number | null (null = from placement)
 *   placement       'center' | 'right': where it first opens (it can then be moved like any other)
 *   storageKey      string | null: remember position and size in localStorage
 *   minWidth, minHeight  (320, 240)
 *   zIndex          number (1000)
 *   noBackdrop      boolean: a non-modal floating panel (no backdrop, no aria-modal, Tab not held in)
 *   backdropClose   boolean: clicking the backdrop closes
 *   closeLabel      footer button text ('Close'); closeAriaLabel: the title bar close button's name ('Close')
 *   disablePopOut   boolean
 *   singletonKey    string | null: only one open dialog per key (a second one closes itself)
 *   focusKey        any: when it changes while open, focus handling restarts (new opener, focus back in)
 *   testId          data-testid on the panel
 */
export default function FloatingDialog({
  isOpen,
  onClose,
  title = "Panel",
  ariaLabel,
  className = "",
  style,
  children,
  footer,
  defaultWidth = 520,
  defaultHeight = 600,
  defaultX = null,
  defaultY = null,
  placement = "center",
  storageKey = null,
  minWidth = 320,
  minHeight = 240,
  zIndex = 1000,
  noBackdrop = false,
  backdropClose = false,
  closeLabel = "Close",
  closeAriaLabel = "Close",
  disablePopOut = false,
  singletonKey = null,
  focusKey,
  testId,
}) {
  const [id] = useState(() => `fd${(seq += 1)}`);
  const [popWin, setPopWin] = useState(null);
  const [popGen, setPopGen] = useState(0); // bumps when the popup document had to be rebuilt
  const [blocked, setBlocked] = useState(false);
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const narrow = useNarrow();
  const label = ariaLabel || (typeof title === "string" ? title : "Dialog");
  const modal = !noBackdrop;

  const initialPos = useCallback(() => initialPosition({
    vp: { w: window.innerWidth, h: window.innerHeight }, w: defaultWidth, h: defaultHeight, x: defaultX, y: defaultY, placement,
  }), [defaultWidth, defaultHeight, defaultX, defaultY, placement]);
  const { pos, size, handleDragStart, createResizeHandler, handleKey } = useFloatingPanel(
    initialPos, { w: defaultWidth, h: defaultHeight }, { storageKey, minW: minWidth, minH: minHeight, disabled: narrow, panelRef },
  );

  const poppedOut = Boolean(popWin && !popWin.closed);

  // ---- focus: remember the opener while rendering (an autoFocus child would take focus before an effect could read
  // it), move focus in on open, give it back on close.
  const openerRef = useRef(null);
  const keyRef = useRef(focusKey);
  if (!isOpen) openerRef.current = null;
  else if (typeof document !== "undefined" && (openerRef.current === null || keyRef.current !== focusKey)) {
    const a = document.activeElement;
    if (!(a && panelRef.current?.contains(a))) openerRef.current = a || false;
    keyRef.current = focusKey;
  }
  useEffect(() => {
    if (!isOpen || poppedOut) return undefined;
    const opener = openerRef.current;
    (closeRef.current || panelRef.current)?.focus();
    return () => { if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus(); };
  }, [isOpen, focusKey, poppedOut]);

  // ---- Escape: a modal listens on the document; a floating panel only while focus is inside it (onKeyDown below)
  useEffect(() => {
    if (!isOpen || !modal || !onClose) return undefined;
    const h = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [isOpen, modal, onClose]);

  // ---- one open dialog per singletonKey
  useEffect(() => {
    if (!singletonKey || !isOpen || !onClose) return undefined;
    const owner = singletons.get(singletonKey);
    if (owner && owner !== id) { onClose(); return undefined; }
    singletons.set(singletonKey, id);
    return () => { if (singletons.get(singletonKey) === id) singletons.delete(singletonKey); };
  }, [singletonKey, isOpen, onClose, id]);

  // ---- pop-out window lifecycle. Notice when it closes (the dialog comes back in-page); close it when this page
  // unloads or navigates (no orphan); Escape anywhere in it closes; mirror theme changes; and if the browser replaced
  // the blank document after we built it (async about:blank), build it again.
  const closeFromPopoutRef = useRef(null);
  useEffect(() => {
    if (!popWin) return undefined;
    const gone = () => setPopWin(null);
    const rebuildIfNeeded = () => {
      if (popWin.closed) { gone(); return; }
      if (!popWin.document.getElementById("fd-root")) { buildPopoutDocument(popWin, label); setPopGen((g) => g + 1); }
    };
    const onPopHide = () => { if (popWin.closed) gone(); else setTimeout(rebuildIfNeeded, 50); };
    const onKey = (e) => { if (e.key === "Escape") closeFromPopoutRef.current?.(); };
    const doc = popWin.document;
    const closePopup = () => { if (!popWin.closed) popWin.close(); };
    popWin.addEventListener?.("pagehide", onPopHide);
    popWin.addEventListener?.("load", rebuildIfNeeded);
    doc.addEventListener("keydown", onKey);
    window.addEventListener("pagehide", closePopup);
    window.addEventListener("beforeunload", closePopup);
    const themeWatch = typeof MutationObserver === "function" ? new MutationObserver(() => { if (!popWin.closed) copyTheme(popWin.document); }) : null;
    themeWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const poll = setInterval(() => { if (popWin.closed) gone(); }, 500);
    return () => {
      clearInterval(poll);
      themeWatch?.disconnect();
      popWin.removeEventListener?.("pagehide", onPopHide);
      popWin.removeEventListener?.("load", rebuildIfNeeded);
      doc.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", closePopup);
      window.removeEventListener("beforeunload", closePopup);
    };
  }, [popWin, popGen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (popWin && !popWin.closed) popWin.close(); }, [popWin]);
  useEffect(() => { if (!isOpen && popWin && !popWin.closed) popWin.close(); }, [isOpen, popWin]);

  const popOut = () => {
    if (poppedOut) { popWin.focus(); return; }
    const h = size.h ?? panelRef.current?.getBoundingClientRect().height ?? 400;
    const win = openPopoutWindow({
      name: `fd_${PAGE_ID}_${id}`, title: label, w: Math.round(size.w + 40), h: Math.round(h + 60),
      left: Math.round((window.screenX || 0) + pos.x), top: Math.round((window.screenY || 0) + pos.y),
    });
    if (!win) { setBlocked(true); return; }
    setBlocked(false);
    setPopWin(win);
  };
  const closeFromPopout = () => { if (popWin && !popWin.closed) popWin.close(); onClose?.(); };
  closeFromPopoutRef.current = onClose ? closeFromPopout : null;

  if (!isOpen || typeof document === "undefined") return null;

  const footerBar = footer === undefined
    ? (onClose ? <div className="fd-footer"><button type="button" className="fd-close-btn" onClick={onClose}>{closeLabel}</button></div> : null)
    : footer !== null ? <div className="fd-footer">{footer}</div> : null;

  if (poppedOut) {
    const popContent = (
      <div className={`fd-popout-layout${className ? ` ${className}` : ""}`} style={style} role="dialog" aria-label={label}
        tabIndex={-1} ref={focusOnce}>
        <div className="fd-titlebar fd-titlebar--static">
          <span className="fd-title">{title}</span>
          {onClose && <button type="button" className="fd-btn" aria-label={closeAriaLabel} title="Close" onClick={closeFromPopout}>×</button>}
        </div>
        <div className="fd-body">{children}</div>
        {footer === undefined
          ? (onClose ? <div className="fd-footer"><button type="button" className="fd-close-btn" onClick={closeFromPopout}>{closeLabel}</button></div> : null)
          : footerBar}
      </div>
    );
    return createPortal(
      <>
        <PopOutPortal key={popGen} win={popWin}>{popContent}</PopOutPortal>
        <div className="fd-placeholder" role="status" data-testid="fd-placeholder" style={{ zIndex }}>
          <span className="fd-placeholder__text">{label} is open in a separate window</span>
          <button type="button" className="fd-mini" onClick={() => popWin.focus()}>Focus</button>
          <button type="button" className="fd-mini" onClick={() => popWin.close()}>Close window</button>
        </div>
      </>,
      document.body,
    );
  }

  const onPanelKeyDown = (e) => {
    if (e.key === "Escape" && !modal && onClose) { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab" || !modal) return;
    const items = [...panelRef.current.querySelectorAll(TABBABLE)];
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    // focus on the panel itself (tabIndex -1) or somewhere outside it: pull it in at the right end
    if (!items.includes(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  };

  // placement only chooses where it opens (initialPosition); after that position and size rule, so drag and keys work.
  // Geometry goes out as custom properties that floating-dialog.css reads, so the narrow-screen sheet can override it
  // without !important. A caller's own left/top/right/bottom/width/height are dropped: the dialog owns its geometry.
  const { left: _l, top: _t, right: _r, bottom: _b, width: _w, height: _h, ...callerStyle } = style || {};
  const panelStyle = {
    ...callerStyle,
    "--fd-x": `${pos.x}px`, "--fd-y": `${pos.y}px`, "--fd-w": `${size.w}px`, "--fd-h": size.h == null ? "auto" : `${size.h}px`,
    zIndex,
  };
  const hintId = `${id}-hint`;

  return createPortal(
    <>
      {modal && <div className="fd-backdrop" aria-hidden="true" style={{ zIndex: zIndex - 1 }} onClick={backdropClose && onClose ? onClose : undefined} />}
      <div ref={panelRef} tabIndex={-1} className={`fd-panel${className ? ` ${className}` : ""}`} role="dialog" aria-label={label}
        aria-modal={modal ? "true" : undefined} data-placement={placement} data-narrow={narrow ? "true" : undefined}
        data-autoheight={size.h == null ? "true" : undefined} data-testid={testId} style={panelStyle} onKeyDown={onPanelKeyDown}>
        {!narrow && HANDLES.map((dir) => (
          <div key={dir} className={`fd-handle fd-handle-${dir}`} onPointerDown={createResizeHandler(dir)} aria-hidden="true" />
        ))}
        <div className="fd-titlebar" tabIndex={narrow ? undefined : 0} data-testid="fd-titlebar"
          aria-label={narrow ? undefined : `Move ${label}`} aria-describedby={narrow ? undefined : hintId}
          onPointerDown={handleDragStart} onKeyDown={(e) => { if (e.target === e.currentTarget) handleKey(e); }}>
          <span className="fd-title">{title}</span>
          {!narrow && <span id={hintId} className="fd-sr">Arrow keys move, Shift moves farther, Alt with arrow keys resizes.</span>}
          {!disablePopOut && (
            <button type="button" className="fd-btn" aria-label="Pop out to a new window" title="Pop out to a new window" onClick={popOut}>↗</button>
          )}
          {onClose && <button type="button" ref={closeRef} className="fd-btn" aria-label={closeAriaLabel} title="Close" onClick={onClose}>×</button>}
        </div>
        {blocked && <p className="fd-blocked" role="status" data-testid="fd-blocked">The browser blocked the pop-out window. Allow pop-ups for this page, or keep using it here.</p>}
        <div className="fd-body">{children}</div>
        {footerBar}
      </div>
    </>,
    document.body,
  );
}
