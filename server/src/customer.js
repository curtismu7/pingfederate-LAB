import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// customer.config: branding and vocabulary a customer-facing run can change without touching code.
// Everything is validated; a bad field falls back to its default and the reason is reported, never thrown.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_CONFIG_PATH = path.join(ROOT, 'customer.config.json');
const MAX_FILE_BYTES = 8 * 1024;

export const VERTICALS = ['banking', 'healthcare', 'retail'];
// The text colours sitting on the accent fill: white in the light theme, near-black in the dark theme.
const LIGHT_ON_ACCENT = '#ffffff';
const DARK_ON_ACCENT = '#1a0509';
// The dark accent also colours links and the active diagram edge on the dark surface.
const DARK_SURFACE = '#1b1e23';
const darkOk = (hex) => contrast(hex, DARK_ON_ACCENT) >= 4.5 && contrast(hex, DARK_SURFACE) >= 4.5;

export const DEFAULTS = Object.freeze({
  name: 'PingFederate LAB',
  tagline: 'Every PingFederate AI-agent feature, on the built-in mock or your own PingFederate',
  accent: '#d20e0f', // Ping Red, the shared stylesheet's accent: only a different, checked accent is sent to the page
  accentDark: '#ff6b7f',
  vertical: 'banking',
  vocabulary: { agent: 'AI agent', user: 'customer', service: 'tool service' },
  cast: {},
});

const TOP_KEYS = new Set(['name', 'tagline', 'accent', 'accentDark', 'vertical', 'vocabulary', 'cast']);
const VOCAB_KEYS = new Set(Object.keys(DEFAULTS.vocabulary));
export const CAST_KEYS = ['company', 'user', 'agent', 'service', 'payee'];
const LIMITS = { name: 40, tagline: 120, vocab: 30, cast: 60 };

const hasMarkup = (text) => /[<>]/.test(text) || /\{\{|\}\}/.test(text);
// C0 controls and DEL, C1 controls, and Unicode format characters (category Cf: bidi overrides such as U+202E,
// zero-width U+200B-U+200F, isolates U+2066-U+2069), which can make shown text differ from what it says.
// eslint-disable-next-line no-control-regex
const hasControl = (text) => /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(text);

function plainText(value, max) {
  if (typeof value !== 'string') return { error: 'must be a string' };
  const text = value.trim();
  if (!text) return { error: 'must not be empty' };
  if (text.length > max) return { error: `is longer than ${max} characters` };
  if (hasMarkup(text) || hasControl(text)) return { error: 'must be plain text (no < > {{ }} or control characters)' };
  return { text };
}

const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export function luminance(hex) { const [r, g, b] = rgb(hex).map(channel); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
export function contrast(a, b) { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); }

export function hue(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
// Purple, violet and purple-magenta, 250 to 330 degrees (owner rule: no purple). Greys have no hue and pass.
export const PURPLE_RANGE = [250, 330];
export const isPurple = (hex) => { const h = hue(hex); return h >= PURPLE_RANGE[0] && h <= PURPLE_RANGE[1]; };

function hslToHex(h, s, l) {
  const f = (n) => { const k = (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}
function toHsl(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return { h: hue(hex), s, l };
}
// Lighten the light-theme accent until dark text on it is readable, keeping its hue.
export function deriveDark(hex) {
  const { h, s, l } = toHsl(hex);
  for (let step = Math.round(l * 100); step <= 95; step += 1) {
    const candidate = hslToHex(h, s, step / 100);
    if (darkOk(candidate) && !isPurple(candidate)) return candidate;
  }
  return null;
}

export function validateConfig(input) {
  const warnings = [];
  const out = { ...DEFAULTS, vocabulary: { ...DEFAULTS.vocabulary }, cast: {} };
  const warn = (field, why) => warnings.push(`${field}: ${why}; the default is used`);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { config: out, warnings: ['config: must be a JSON object; the defaults are used'] };
  }
  for (const key of Object.keys(input)) if (!TOP_KEYS.has(key)) warnings.push(`${String(key).slice(0, 40).replace(/[^\w.-]/g, '?')}: unknown key ignored`);

  for (const [field, max] of [['name', LIMITS.name], ['tagline', LIMITS.tagline]]) {
    if (!Object.hasOwn(input, field)) continue;
    const r = plainText(input[field], max);
    if (r.error) warn(field, r.error); else out[field] = r.text;
  }

  if (Object.hasOwn(input, 'vertical')) {
    if (VERTICALS.includes(input.vertical)) out.vertical = input.vertical;
    else warn('vertical', `must be one of ${VERTICALS.join(', ')}`);
  }

  let accentOk = false;
  if (Object.hasOwn(input, 'accent')) {
    const v = input.accent;
    if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) warn('accent', 'must be a #rrggbb colour');
    else if (isPurple(v)) warn('accent', 'is in the purple range (250 to 330 degrees), which this app does not use');
    else if (contrast(v, LIGHT_ON_ACCENT) < 4.5) warn('accent', `has ${contrast(v, LIGHT_ON_ACCENT).toFixed(2)}:1 contrast with white button text, needs 4.5:1`);
    else { out.accent = v.toLowerCase(); accentOk = true; }
  }
  if (Object.hasOwn(input, 'accentDark')) {
    const v = input.accentDark;
    if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) warn('accentDark', 'must be a #rrggbb colour');
    else if (isPurple(v)) warn('accentDark', 'is in the purple range (250 to 330 degrees), which this app does not use');
    else if (!darkOk(v)) warn('accentDark', `has ${contrast(v, DARK_ON_ACCENT).toFixed(2)}:1 contrast with dark button text and ${contrast(v, DARK_SURFACE).toFixed(2)}:1 against the dark surface, needs 4.5:1 on both`);
    else out.accentDark = v.toLowerCase();
  } else if (accentOk) {
    // No dark accent given: derive one from the light accent, or keep the default dark accent.
    out.accentDark = deriveDark(out.accent) ?? DEFAULTS.accentDark;
  }

  if (Object.hasOwn(input, 'vocabulary')) {
    const vocab = input.vocabulary;
    if (vocab === null || typeof vocab !== 'object' || Array.isArray(vocab)) warn('vocabulary', 'must be an object');
    else for (const [key, value] of Object.entries(vocab)) {
      if (!VOCAB_KEYS.has(key)) { warnings.push(`vocabulary.${String(key).slice(0, 40).replace(/[^\w.-]/g, '?')}: unknown key ignored`); continue; }
      const r = plainText(value, LIMITS.vocab);
      if (r.error) warn(`vocabulary.${key}`, r.error); else out.vocabulary[key] = r.text;
    }
  }

  if (Object.hasOwn(input, 'cast')) {
    const cast = input.cast;
    if (cast === null || typeof cast !== 'object' || Array.isArray(cast)) warn('cast', 'must be an object');
    else for (const [key, value] of Object.entries(cast)) {
      if (!CAST_KEYS.includes(key)) { warnings.push(`cast.${String(key).slice(0, 40).replace(/[^\w.-]/g, '?')}: unknown key ignored`); continue; }
      const r = plainText(value, LIMITS.cast);
      if (r.error) warn(`cast.${key}`, r.error);
      else out.cast[key] = r.text;
    }
  }
  return { config: out, warnings };
}

// Loads the config file. A missing file is normal (defaults); an unreadable or oversize one is reported.
export function loadCustomerConfig({ file, env = process.env } = {}) {
  const target = file ?? (env.CUSTOMER_CONFIG ? path.resolve(env.CUSTOMER_CONFIG) : DEFAULT_CONFIG_PATH);
  let text;
  try {
    const stat = fs.statSync(target);
    if (stat.size > MAX_FILE_BYTES) return { ...validateConfig(null), warnings: [`config file is larger than ${MAX_FILE_BYTES} bytes; the defaults are used`] };
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && !env.CUSTOMER_CONFIG) return { config: validateConfig({}).config, warnings: [] };
    return { ...validateConfig(null), warnings: ['config file could not be read; the defaults are used'] };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ...validateConfig(null), warnings: ['config file is not valid JSON; the defaults are used'] }; }
  return validateConfig(parsed);
}

// The safe subset exposed through GET /api/config.
export const publicConfig = ({ config, warnings }) => ({
  name: config.name, tagline: config.tagline, accent: config.accent === DEFAULTS.accent ? null : config.accent, accentDark: config.accentDark,
  vertical: config.vertical, vocabulary: config.vocabulary, warnings,
});
