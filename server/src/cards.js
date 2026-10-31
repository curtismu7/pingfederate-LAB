import { LabError } from './pf.js';
import { newTraceId } from './trace.js';

// The cards: what each one is, whether its settings are complete, and the two helpers that are not flows of their
// own (the discovery check and the RAR authorization detail). CIMD and ID-JAG are link cards to sibling apps.

// Shelf order (owner, 2026-10-29). The playground is a view over the other cards; discovery lives in Settings.
export const CARDS = [
  { id: 'signin', title: 'Sign in (pi.flow)', kind: 'flow' },
  { id: 'dcr', title: 'Dynamic client registration (RFC 7591/7592)', kind: 'flow' },
  { id: 'rar', title: 'RAR via PAR (banking_transaction)', kind: 'flow', variants: ['dpop'] },
  { id: 'ciba', title: 'CIBA (start and poll)', kind: 'flow' },
  { id: 'dpop', title: 'DPoP sign-in', kind: 'flow' },
  { id: 'tokenExchange', title: 'Token exchange, two hops (RFC 8693)', kind: 'flow' },
  { id: 'userinfo', title: 'Userinfo', kind: 'flow' },
  { id: 'piflow', title: 'Authentication API: open and read a pi.flow', kind: 'flow' },
  { id: 'par', title: 'PAR', kind: 'flow' },
  { id: 'pkce', title: 'PKCE', kind: 'flow' },
  { id: 'playground', title: 'PingFederate Protocol Playground', kind: 'playground' },
  { id: 'cimd', title: 'Client ID metadata documents', kind: 'link', setting: 'cimdLabUrl', app: 'cimd-lab' },
  { id: 'idJag', title: 'ID-JAG', kind: 'link', setting: 'idJagUrl', app: 'id-jag-standalone' },
  { id: 'discovery', title: 'PingFederate discovery check', kind: 'check' },
];

// extra.mockUser: the demo user, which the RAR card uses when nobody is signed in (mock mode only).
export function cardList(settings, extra = {}) {
  return CARDS.map((card) => {
    if (card.kind === 'link') {
      const url = settings.value('links', card.setting) || null;
      return { ...card, url, ready: Boolean(url), missing: url ? [] : [`links.${card.setting}`] };
    }
    if (card.kind === 'playground') return { ...card, ready: settings.ready('discovery'), missing: settings.missing('discovery') };
    return {
      ...card, ready: settings.ready(card.id), missing: settings.missing(card.id),
      ...(card.variants ? { variantsReady: { dpop: settings.ready('rarDpop') }, variantsMissing: { dpop: settings.missing('rarDpop') } } : {}),
      // What the RAR card fills in when the fields are left empty. Mode-aware: the mock's accounts and user in mock mode,
      // the owner's saved accounts in live mode (settings is the mode-aware reader).
      ...(card.id === 'rar' ? { defaults: { user: extra.mockUser || '', sourceAccount: settings.value('rar', 'sourceAccount') || '', destinationAccount: settings.value('rar', 'destinationAccount') || '' } } : {}),
    };
  });
}

export const RAR_TYPE = 'banking_transaction';
const ACCOUNT = /^[A-Za-z0-9._-]{1,64}$/;

// One banking_transaction detail (RFC 9396), in the shape PingFederate's banking_transaction processor accepts:
// exactly type, user_id, actions, source_account, destination_account, amount and currency. After sign-in it checks
// that user_id is the signed-in user and both accounts are theirs, so there are no made-up defaults for them.
export function buildAuthorizationDetail({ amount = 125, currency = 'USD', userId, sourceAccount, destinationAccount } = {}) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 256 || /[\u0000-\u001f\u007f]/.test(userId)) {
    throw new LabError('rar_user_required', 'Name the user making the transfer (or sign in first)', 400);
  }
  if (!sourceAccount || !destinationAccount) throw new LabError('rar_accounts_required', 'Set the from and to accounts (on the card or in Settings)', 400);
  // Only a number, or a plain decimal string: Number([5]) and Number(true) must not pass as amounts.
  const value = typeof amount === 'number' ? amount
    : (typeof amount === 'string' && /^\d{1,7}(\.\d{1,2})?$/.test(amount) ? Number(amount) : NaN);
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) throw new LabError('bad_amount', 'Amount must be a number above 0 and at most 1000000', 400);
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new LabError('bad_currency', 'Currency must be three capital letters', 400);
  for (const [name, account] of [['sourceAccount', sourceAccount], ['destinationAccount', destinationAccount]]) {
    if (typeof account !== 'string' || !ACCOUNT.test(account)) throw new LabError('bad_account', `${name} must be 1 to 64 letters, digits or . _ -`, 400);
  }
  return {
    type: RAR_TYPE,
    user_id: userId.trim(),
    actions: ['transfer'],
    source_account: sourceAccount,
    destination_account: destinationAccount,
    amount: Math.round(value * 100) / 100,
    currency,
  };
}

// What PingFederate says it can do, read from its discovery document.
export async function discoveryCheck(pf) {
  const traceId = newTraceId();
  const { metadata, step } = await pf.discover({ traceId, fresh: true });
  const doc = metadata.raw;
  const list = (field) => (Array.isArray(doc[field]) ? doc[field].map(String) : []);
  const grants = list('grant_types_supported');
  const features = [
    { id: 'pkce', label: 'PKCE S256', supported: list('code_challenge_methods_supported').includes('S256') },
    { id: 'par', label: 'Pushed authorization requests', supported: Boolean(metadata.parEndpoint), required: doc.require_pushed_authorization_requests === true },
    { id: 'rar', label: `Authorization details (${RAR_TYPE})`, supported: list('authorization_details_types_supported').includes(RAR_TYPE), types: list('authorization_details_types_supported') },
    { id: 'dpop', label: 'DPoP', supported: list('dpop_signing_alg_values_supported').length > 0, algs: list('dpop_signing_alg_values_supported') },
    { id: 'ciba', label: 'CIBA', supported: Boolean(metadata.backchannelEndpoint) && grants.includes('urn:openid:params:grant-type:ciba'), modes: list('backchannel_token_delivery_modes_supported') },
    { id: 'dcr', label: 'Dynamic client registration', supported: Boolean(metadata.registrationEndpoint) },
    { id: 'tokenExchange', label: 'Token exchange', supported: grants.includes('urn:ietf:params:oauth:grant-type:token-exchange') },
    { id: 'userinfo', label: 'Userinfo', supported: Boolean(metadata.userinfoEndpoint) },
    { id: 'clientCredentials', label: 'Client credentials', supported: grants.includes('client_credentials') },
    { id: 'cimd', label: 'Client ID metadata documents', supported: doc.client_id_metadata_document_supported === true },
  ];
  return {
    issuer: metadata.issuer,
    endpoints: {
      authorization: metadata.authorizationEndpoint, token: metadata.tokenEndpoint, jwks: metadata.jwksUri,
      par: metadata.parEndpoint || null, backchannel: metadata.backchannelEndpoint || null, registration: metadata.registrationEndpoint || null,
    },
    features,
    trace: step ? [step] : [],
  };
}
