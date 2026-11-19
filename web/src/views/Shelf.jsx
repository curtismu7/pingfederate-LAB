import Readiness from './Readiness.jsx';
import { EXPLAIN } from '../content.js';

// The home: one card per demo, in the owner's order. Link cards open the sibling apps.
export default function Shelf({ cards, story, verticals, vertical, onVertical }) {
  const shown = cards.filter((c) => c.kind !== 'check');
  // One primary per view (UI patterns section 9): the first card's Open is the red one; the rest are secondary.
  const firstOpen = shown.find((c) => c.kind !== 'link')?.id;
  return (
    <section aria-labelledby="shelf-title">
      <div className="shelf-head">
        <h2 id="shelf-title" data-n="1">The shelf</h2>
        {story?.intro?.[0] && <p className="intro">{story.intro[0]}</p>}
        {verticals.length > 0 && (
          <fieldset className="verticals">
            <legend>Tell the stories as</legend>
            {verticals.map((v) => (
              <label key={v.id} className="check">
                <input type="radio" name="vertical" value={v.id} checked={vertical === v.id} onChange={() => onVertical(v.id)} /> {v.label}
              </label>
            ))}
          </fieldset>
        )}
      </div>
      <ul className="shelf">
        {shown.map((card, i) => (
          <li key={card.id} className={`shelf-card kind-${card.kind}`}>
            <div className="sc-top">
              <span className="sc-n" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
              <Readiness card={card} />
            </div>
            <h3>{card.title}</h3>
            {story?.cards?.[card.id] && <p className="story">{story.cards[card.id]}</p>}
            <p className="explain">{EXPLAIN[card.id]}</p>
            {card.kind === 'link' ? (
              <>
                <p className="hint">This lives in a sibling app, {card.app}; it is not built into this lab.</p>
                {card.url
                  ? <a className="btn" href={card.url} target="_blank" rel="noopener noreferrer">Open {card.app}</a>
                  : <a className="btn" href={`#/settings/links.${card.setting}`}>Set its address in Settings</a>}
              </>
            ) : (
              <a className={card.id === firstOpen ? 'btn primary' : 'btn'} href={card.kind === 'playground' ? '#/playground' : `#/run/${card.id}`}>Open</a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
