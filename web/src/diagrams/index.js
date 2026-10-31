import signin from './pfl-signin.json';
import dcr from './pfl-dcr.json';
import rar from './pfl-rar.json';
import ciba from './pfl-ciba.json';
import dpop from './pfl-dpop.json';
import tokenExchange from './pfl-token-exchange.json';
import piflow from './pfl-piflow.json';
import par from './pfl-par.json';
import pkce from './pfl-pkce.json';
import userinfo from './pfl-userinfo.json';

// Static diagrams are diagram-studio/1 data, loaded by id. No nodes or edges are built in JSX.
const ALL = [signin, dcr, rar, ciba, dpop, tokenExchange, userinfo, piflow, par, pkce];
const BY_ID = new Map(ALL.map((diagram) => [diagram.id, diagram]));

export function loadDiagram(id) {
  const diagram = BY_ID.get(id);
  if (!diagram) throw new Error(`Unknown diagram: ${id}`);
  return diagram;
}
export const DIAGRAM_IDS = ALL.map((diagram) => diagram.id);
// The named diagram for each card.
export const CARD_DIAGRAM = { signin: 'pfl-signin', dcr: 'pfl-dcr', rar: 'pfl-rar', ciba: 'pfl-ciba', dpop: 'pfl-dpop', tokenExchange: 'pfl-token-exchange', userinfo: 'pfl-userinfo', piflow: 'pfl-piflow', par: 'pfl-par', pkce: 'pfl-pkce' };
