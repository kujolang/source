// Source — deterministic identifier generation.
//
// IDs are short, stable, and human-readable (e.g. W184, S12, C7, E3, D2).
// They are scoped per project via a monotonic counter stored in the store.

import { randomBytes } from 'node:crypto';

const PREFIXES = {
  org: 'O',
  work: 'W',
  session: 'S',
  change: 'C',
  evidence: 'E',
  decision: 'D',
  project: 'P',
  repository: 'R',
  principal: 'U',
  capability: 'K',
};

export function nextId(store, kind) {
  const prefix = PREFIXES[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind}`);
  if (typeof store.nextId === 'function') return store.nextId(kind, prefix);
  const key = `counter:${kind}`;
  const current = store.getMeta(key) ?? 0;
  const next = current + 1;
  store.setMeta(key, next);
  return `${prefix}${next}`;
}

export async function nextIdAsync(store, kind) {
  const prefix = PREFIXES[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind}`);
  if (typeof store.nextIdAsync === 'function') return store.nextIdAsync(kind, prefix);
  if (typeof store.nextId === 'function') return store.nextId(kind, prefix);
  const key = `counter:${kind}`;
  const current = typeof store.getMetaAsync === 'function' ? await store.getMetaAsync(key) : store.getMeta(key) ?? 0;
  const next = current + 1;
  if (typeof store.setMetaAsync === 'function') await store.setMetaAsync(key, next);
  else store.setMeta(key, next);
  return `${prefix}${next}`;
}

// A short, unguessable random identifier for capability credentials.
export function randomHex(bytes = 24) {
  return randomBytes(bytes).toString('hex');
}
