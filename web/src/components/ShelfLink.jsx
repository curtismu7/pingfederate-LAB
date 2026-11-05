import React from "react";

/**
 * ShelfLink: the "Shelf" button that appears in the header of every -LAB app.
 * Reusable service (owner request 2026-11-05): copy this file into each app's
 * web/src/components/ShelfLink.jsx. It fetches GET /api/shelf once, and renders
 * nothing until it has a URL (never a broken link).
 *
 * Props:
 *   url   (optional) shelf URL passed by the app when it already has one (e.g. from /api/info)
 *   traceparent (optional) function returning a W3C traceparent header value; apps whose tests
 *         assert a traceparent on every request (rule 14) pass their pageTraceparent here.
 *   headers (optional) extra request headers merged into the fetch — a plain object, or a function
 *         returning one (a function is evaluated at fetch time, so a per-tab id is computed when
 *         the request actually fires, matching what the app's own api helper will send).
 *   path   (optional) the shelf endpoint, default "/api/shelf"; apps whose bundles must use relative
 *         API paths (proxy-mounted apps) pass "api/shelf".
 *   className (optional) extra classes; the base class "shelf-link" is styled by the shared stylesheet
 */
export default function ShelfLink({ url, traceparent, headers, path = "/api/shelf", className = "" }) {
  const [href, setHref] = React.useState(url ?? null);
  React.useEffect(() => {
    if (url) { setHref(url); return undefined; }
    let alive = true;
    const extra = typeof headers === "function" ? headers() : (headers ?? {});
    const init = { credentials: "omit", headers: { Accept: "application/json", ...extra, ...(traceparent ? { traceparent: traceparent() } : {}) } };
    fetch(path, init)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.shelfUrl) setHref(d.shelfUrl); })
      .catch(() => { /* stay hidden: no shelf, no button */ });
    return () => { alive = false; };
  }, [url, path]);
  if (!href) return null;
  return (
    <a
      className={`shelf-link ${className}`.trim()}
      href={href}
      target="_blank"
      rel="noreferrer"
      title="Open the demo shelf (launcher)"
    >
      Shelf
    </a>
  );
}
