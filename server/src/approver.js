import crypto from 'node:crypto';
import { LabError } from './pf.js';

// The lab's own CIBA approval channel. PingFederate's web-approver authenticator (a plugin instance whose Approval
// URL is <lab>/api/ciba-approver) registers each CIBA request here with a shared secret, then polls for the answer;
// the person who started the CIBA card approves or denies on the card. PingFederate still runs CIBA itself: it
// issues auth_req_id, asks this channel, and decides what the poll on its token endpoint returns.
// In memory only: a restart drops pending requests, and PingFederate then expires them.
const TTL_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 50;
const TRANSACTION_ID = /^[0-9a-f-]{36}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

const sameSecret = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(a).digest(),
  crypto.createHash('sha256').update(b).digest(),
);

export function createApprover({ settings, now = Date.now }) {
  const requests = new Map(); // transactionId -> { subject, bindingMessage, status, createdAt, expiresAt }
  const secret = () => settings.value('ciba', 'approverSecret') || '';
  const prune = () => { for (const [id, entry] of requests) if (entry.expiresAt <= now()) requests.delete(id); };

  // PingFederate authenticates with the shared secret; anything else gets the same 404 as "not set up".
  function authorize(header) {
    const expected = secret();
    const match = /^Bearer (.+)$/.exec(String(header || ''));
    if (!expected || !match || !sameSecret(match[1], expected)) throw new LabError('not_found', 'Not found', 404);
  }

  function register(header, body) {
    authorize(header);
    const { transactionId, subject, bindingMessage } = body || {};
    if (typeof transactionId !== 'string' || !TRANSACTION_ID.test(transactionId)
      || typeof subject !== 'string' || !subject.trim() || subject.length > 256 || CONTROL.test(subject)) {
      throw new LabError('request_invalid', 'A transactionId and subject are required', 400);
    }
    prune();
    // Oldest first out, so a burst can never grow this without bound.
    while (requests.size >= MAX_REQUESTS) requests.delete(requests.keys().next().value);
    requests.set(transactionId, {
      subject: subject.trim(),
      bindingMessage: typeof bindingMessage === 'string' && !CONTROL.test(bindingMessage) ? bindingMessage.slice(0, 64) : null,
      status: 'pending',
      createdAt: now(),
      expiresAt: now() + TTL_MS,
    });
    return { ok: true };
  }

  function lookup(header, transactionId) {
    authorize(header);
    prune();
    const entry = requests.get(transactionId);
    if (!entry) throw new LabError('not_found', 'Not found', 404);
    return { status: entry.status };
  }

  // The newest request PingFederate registered for this user since the card started its run.
  function pendingFor(subject, since) {
    prune();
    const hint = String(subject).toLowerCase();
    return [...requests.values()]
      .filter((e) => e.status === 'pending' && e.createdAt >= since && e.subject.toLowerCase() === hint)
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  return { enabled: () => Boolean(secret()), register, lookup, pendingFor };
}
