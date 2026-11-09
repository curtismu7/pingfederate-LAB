import React from "react";
import { returnLinkFor } from "./returnTargets.js";

/**
 * ReturnLink: the way back to the app that handed a use case to this one (for example Customer Agent LAB).
 * Reusable service: copy this folder into each app's web/src/return-link/ unchanged (see README.md).
 * Renders nothing unless the page was opened with ?from=<known app>&uc=<id> (see returnTargets.js).
 *
 * Props:
 *   app      (required) this app's own id, sent back as ?returned=<app>
 *   variant  "strip" (default): a full-width note right below the simulation banner, "Opened from <app> · <uc>" + Back button
 *            "header": a compact Back button for the shell bar
 *   location (optional) a { pathname, search } object instead of window.location (tests)
 *   navigate (optional) function(href) instead of window.location.assign (tests)
 *   className (optional) extra classes
 *
 * Same tab on purpose: the lab proxy keeps one lab cookie per browser, so a second tab would route the other app's
 * API calls here. Styles are theme tokens only (inline, so the shared stylesheet does not change).
 */
export default function ReturnLink({ app, variant = "strip", location, navigate, className = "" }) {
  const link = React.useMemo(() => {
    try { return returnLinkFor(app, location); } catch { return null; }
  }, [app, location]);
  if (!link) return null;
  const go = () => (navigate ? navigate(link.href) : window.location.assign(link.href));
  const label = `Back to ${link.label}`;
  if (variant === "header") {
    return (
      <button type="button" className={`return-link return-link--header ${className}`.trim()} onClick={go}
        title={`${label} (use case ${link.uc})`} style={headerStyle}>
        <span aria-hidden="true">← </span>{label}
      </button>
    );
  }
  return (
    <div role="note" aria-label={`Opened from ${link.label}`} className={`return-link return-link--strip ${className}`.trim()} style={stripStyle}>
      <span style={textStyle}>
        Opened from <strong>{link.label}</strong>
        {" · "}<code>{link.uc}</code>
        {link.vertical ? <> {" · "}<span>{link.vertical}</span></> : null}
      </span>
      <button type="button" onClick={go} style={buttonStyle}>
        <span aria-hidden="true">← </span>{label}
      </button>
    </div>
  );
}

const stripStyle = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  margin: "12px 0 0",
  padding: "8px 12px",
  border: "1px solid var(--border)",
  borderLeft: "4px solid var(--focus)",
  borderRadius: "8px",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "13px",
  maxWidth: "100%",
  boxSizing: "border-box",
};
const textStyle = { minWidth: 0, overflowWrap: "anywhere" };
const buttonStyle = { minHeight: "40px" };
const headerStyle = { minHeight: "40px" };
