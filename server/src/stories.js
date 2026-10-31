import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERTICALS, CAST_KEYS, DEFAULTS } from './customer.js';

// Stories as data: stories/common.json (intro and the list of cards) and one pack per vertical (cast and one story
// line per card). Text carries {{cast.name}} tokens; rendering fails loudly on any token
// the cast does not define, so a typo never reaches a presenter's screen.
const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../stories');
const TOKEN = /\{\{\s*cast\.([A-Za-z]+)\s*\}\}/g;
export const WORD_KEYS = ['agentWord', 'userWord', 'serviceWord'];

export class StoryError extends Error {}

export const tokensIn = (text) => [...String(text).matchAll(TOKEN)].map((m) => m[1]);

export function fill(text, cast) {
  const out = String(text).replace(TOKEN, (whole, key) => {
    if (!Object.hasOwn(cast, key) || typeof cast[key] !== 'string' || !cast[key]) throw new StoryError(`undefined cast token: ${key}`);
    return cast[key];
  });
  if (/\{\{|\}\}/.test(out)) throw new StoryError('malformed token left in text');
  return out;
}

export function loadStories(dir = DEFAULT_DIR) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const common = read('common.json');
  const packs = {};
  for (const id of VERTICALS) packs[id] = read(`${id}.json`);
  return { common, packs };
}

export const STORIES = loadStories();

export const verticalList = (stories = STORIES) => VERTICALS.map((id) => ({ id, label: stories.packs[id].label }));

// Cast = the pack's own cast, overridden by the customer's cast, plus the customer's vocabulary words.
export function castFor(pack, customer) {
  const cast = { ...pack.cast, ...customer.cast };
  cast.agentWord = customer.vocabulary.agent;
  cast.userWord = customer.vocabulary.user;
  cast.serviceWord = customer.vocabulary.service;
  return cast;
}

export function renderStory(vertical, customer = DEFAULTS, stories = STORIES) {
  if (typeof vertical !== 'string' || !Object.hasOwn(stories.packs, vertical) || !VERTICALS.includes(vertical)) throw new StoryError('unknown vertical');
  const pack = stories.packs[vertical];
  const cast = castFor(pack, { vocabulary: DEFAULTS.vocabulary, cast: {}, ...customer });
  return {
    vertical,
    label: pack.label,
    cast: Object.fromEntries(CAST_KEYS.filter((k) => cast[k]).map((k) => [k, cast[k]])),
    intro: stories.common.intro.map((text) => fill(text, cast)),
    // One story line per card, told in the vertical's words.
    cards: Object.fromEntries(stories.common.cards.map((card) => {
      if (!Object.hasOwn(pack.cards, card)) throw new StoryError(`pack ${vertical} has no story for ${card}`);
      return [card, fill(pack.cards[card], cast)];
    })),
  };
}

