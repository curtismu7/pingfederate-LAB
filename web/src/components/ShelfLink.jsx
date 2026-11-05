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
 *   className (optional) extra classes; the base class "shelf-link" is styled by the shared stylesheet
 */
export default function ShelfLink({ url, traceparent, className = "" }) {
  const [href, setHref] = React.useState(url ?? null);
  React.useEffect(() => {
    if (url) { setHref(url); return undefined; }
    let alive = true;
    const headers = traceparent ? { traceparent: traceparent() } : undefined;
    fetch("/api/shelf", { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.shelfUrl) setHref(d.shelfUrl); })      .catch(() => { /* stay hidden: no shelf, no button */ });
    return () => { alive = false; };
  }, [url]);
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
