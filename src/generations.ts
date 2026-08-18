// src/generations.ts — generation chains.
//
// THE PROBLEM THIS FILE EXISTS TO FIX: plain `--resume` does NOT always keep
// a session's id. Verified on real data: resuming can write a FRESH transcript
// under a FRESH id, copying the predecessor's content as a prefix (and with it
// the custom-title record). One logical conversation therefore appears on disk
// as several transcripts — several ids — with identical names and no marker
// the fork resolver reads. Rendered naively, that is N same-named root rows,
// and a fork of the row the user recognises by name forks an OLD generation.
//
// The fix separates identity from address: the CONVERSATION is the durable
// entity and a session id is a mutable pointer onto it. A chain groups every id one
// conversation has worn; the tree shows exactly ONE row per chain (its TIP —
// the current generation), and every verb that targets a chain member acts on
// the tip.
//
// Chain edges come from two EXACT sources only, in the spirit of lineage.ts's
// "a wrong edge is worse than no edge":
//   * transcript continuation signal — a transcript whose head names a
//     different session id and carries no forkedFrom marker is a plain-resume
//     continuation of that id (forks rewrite their copied head to their own id
//     and write forkedFrom; verified on all 13 fork transcripts on this
//     machine, zero ambiguous cases). Extracted by archive.ts as
//     ArchivedSession.continuesId.
//   * recorded re-keys — persisted ChainRecords written when a hook event's
//     inherited LINEAGE_NODE_ID differs from its session_id (state.ts).
//
// Deliberately NOT used: byte-prefix containment between generations. The
// copied prefix is NOT byte-identical in real data (an old generation can gain
// trailing lines after being continued), so any byte-comparison scheme would
// mis-order chains.
//
// Dependencies are deliberately minimal — ./types and ./log, never vscode and
// never node IO: every input is handed in, so the whole module is pure and
// unit-testable.

import { log } from './log';
import {
  isSessionId,
  type ArchivedSession,
  type ChainRecord,
  type EditorialRecord,
  type RosterEntry,
} from './types';

// ------------------------------------------------------------------ facts

/** What chain-building needs to know about one transcript. Produced by
 *  archive.ts for every indexed transcript, live ones included. */
export interface GenerationFacts {
  sessionId: string;
  /** ArchivedSession.continuesId — set only for verified continuations. */
  continuesId?: string;
  /** Transcript mtime — the tip-selection key among dead members. */
  mtimeMs?: number;
  bytes?: number;
  /** ArchivedSession.startedAt, copied through unconditionally for every
   *  indexed transcript — live ones included, since chainFacts() (unlike
   *  current()) covers them. buildChainIndex reduces these to Chain's
   *  rootStartedAt, the conversation's true start time independent of which
   *  physical id currently wears it. */
  startedAt?: number;
}

/**
 * Strip continuation claims that CONTRADICT an exact fork edge.
 *
 * A fork is a NEW BRANCH, never a re-key — the rule the hook path already
 * enforces (a SessionStart with `source: 'fork'` is never chained). Both
 * continuation sources can transiently claim one anyway: the daemon roster
 * reports a fork launch as `mode: 'resume'` before (or without) its `fork`
 * flag, and a child transcript head-read mid-copy can precede its
 * `forkedFrom` marker. Folding such a claim chains the child onto its own
 * parent, and the collapse then swallows the PARENT'S row into the branch —
 * observed as "the parent disappeared and the forks became roots" until the
 * roster moved on and the tree healed.
 *
 * The tiebreak is not a judgement call: a minted edge is written BEFORE the
 * child process exists, so where the two sources name the same (child,
 * parent) pair the fork edge is exact and the continuation is simply wrong.
 * A continuation naming any OTHER id is left alone — that is real
 * information, not the race.
 *
 * `forkParentOf` answers from the persisted editorial records; pure and
 * injected so this stays testable without a store.
 */
export function dropForkContinuations(
  facts: readonly GenerationFacts[],
  forkParentOf: (childId: string) => string | undefined,
): GenerationFacts[] {
  return facts.map((fact) => {
    if (fact.continuesId === undefined) return fact;
    if (forkParentOf(fact.sessionId) !== fact.continuesId) return fact;
    const { continuesId: _dropped, ...kept } = fact;
    return kept;
  });
}

// ------------------------------------------------------------------ index

/** Which member of a chain is current, and how everyone else maps to it. */
export interface Chain {
  rootId: string;
  /** Every id this conversation has worn, oldest-known first. */
  members: string[];
  tipId: string;
  /** The MINIMUM GenerationFacts.startedAt across every member that has one —
   *  i.e. when the CONVERSATION began, not when its current physical id was
   *  minted. collapseChains overwrites the tip's own startedAt with this, so
   *  sibling order and displayed age survive a plain `--resume` re-mint,
   *  whose fresh transcript would otherwise carry a fresh birthtimeMs and
   *  make a long-running conversation look freshly started. Undefined only
   *  when NO member's facts carried a startedAt — this index only ever sees
   *  the facts it is handed, so a future caller that filters chainFacts()
   *  before passing them in would silently degrade this to "unknown" rather
   *  than wrong. */
  rootStartedAt?: number;
}

export interface ChainIndexInput {
  facts: Iterable<GenerationFacts>;
  /** Persisted ChainRecords from state.json — the recorded re-keys. */
  recorded?: Iterable<ChainRecord>;
  /** Ids with a live roster row. Liveness outranks mtime for tip selection,
   *  and a live member is never suppressed (see supersededIds). */
  liveIds?: ReadonlySet<string>;
}

/**
 * The chain lookup the rebuild pass and the verbs share. Ids that belong to
 * no chain map to themselves everywhere, so callers never special-case.
 */
export class ChainIndex {
  private readonly chainOf = new Map<string, Chain>();
  private readonly superseded = new Set<string>();
  private readonly all: Chain[] = [];

  constructor(chains: Chain[], liveIds: ReadonlySet<string>) {
    for (const chain of chains) {
      if (chain.members.length < 2) continue; // a chain of one is no chain
      this.all.push(chain);
      for (const id of chain.members) {
        this.chainOf.set(id, chain);
        // A superseded generation loses its row — EXCEPT a live one. A live
        // process is never hidden by inference: if two generations of one
        // conversation are somehow both running, both render, because
        // suppressing a running session would be the one truly destructive
        // rendering mistake this module could make.
        if (id !== chain.tipId && !liveIds.has(id)) this.superseded.add(id);
      }
    }
  }

  /** The current generation of `id`'s conversation; `id` itself when unchained. */
  tipOf(id: string): string {
    return this.chainOf.get(id)?.tipId ?? id;
  }

  rootOf(id: string): string {
    return this.chainOf.get(id)?.rootId ?? id;
  }

  /** All ids of `id`'s conversation (oldest first); [id] when unchained. */
  membersOf(id: string): string[] {
    const chain = this.chainOf.get(id);
    return chain ? [...chain.members] : [id];
  }

  /** Non-tip, non-live members: the ids whose rows disappear. */
  supersededIds(): ReadonlySet<string> {
    return this.superseded;
  }

  isSuperseded(id: string): boolean {
    return this.superseded.has(id);
  }

  chains(): readonly Chain[] {
    return this.all;
  }
}

/** An index that chains nothing — the seed value before the first build. */
export function emptyChainIndex(): ChainIndex {
  return new ChainIndex([], new Set());
}

/**
 * Union facts + recorded chains into a ChainIndex.
 *
 * Tip selection, in order:
 *   1. a LIVE member (roster presence beats every file signal; when several
 *      are live, the newest mtime among them);
 *   2. newest transcript mtime — the honest "which generation was written
 *      last" signal, robust to the observed case where an old generation
 *      gains a couple of trailing lines after being continued;
 *   3. larger transcript, then recorded member order, then id — pure
 *      tie-breakers so the answer is total and stable across ticks.
 */
export function buildChainIndex(input: ChainIndexInput): ChainIndex {
  const liveIds = input.liveIds ?? new Set<string>();
  const factOf = new Map<string, GenerationFacts>();
  for (const f of input.facts) {
    if (!isSessionId(f?.sessionId)) continue;
    if (!factOf.has(f.sessionId)) factOf.set(f.sessionId, f);
  }

  // Union-find. Parent pointers only; path-compressed on find.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Order hints: recorded members carry an explicit oldest→newest order;
  // continuation edges say "continuesId is older than sessionId".
  const orderHint = new Map<string, number>();
  let hintCounter = 0;

  for (const rec of input.recorded ?? []) {
    if (!isSessionId(rec?.rootId) || !Array.isArray(rec?.members)) continue;
    let prev: string | null = null;
    for (const raw of rec.members) {
      if (!isSessionId(raw)) continue;
      if (!orderHint.has(raw)) orderHint.set(raw, hintCounter++);
      if (prev !== null && prev !== raw) union(prev, raw);
      if (raw !== rec.rootId) union(rec.rootId, raw);
      prev = raw;
    }
  }
  for (const f of factOf.values()) {
    const from = f.continuesId;
    if (!isSessionId(from) || from === f.sessionId) continue;
    union(f.sessionId, from);
    if (!orderHint.has(from)) orderHint.set(from, hintCounter++);
    if (!orderHint.has(f.sessionId)) orderHint.set(f.sessionId, hintCounter++);
  }

  // Group members per set representative.
  const groups = new Map<string, string[]>();
  const seen = new Set<string>([...parent.keys(), ...orderHint.keys()]);
  for (const id of seen) {
    const rep = find(id);
    const list = groups.get(rep);
    if (list) list.push(id);
    else groups.set(rep, [id]);
  }

  const mtimeOf = (id: string): number => factOf.get(id)?.mtimeMs ?? -1;
  const bytesOf = (id: string): number => factOf.get(id)?.bytes ?? -1;
  const hintOf = (id: string): number => orderHint.get(id) ?? Number.MAX_SAFE_INTEGER;

  const chains: Chain[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;

    // Oldest-first member order: recorded/observation order, then mtime.
    const ordered = [...members].sort((a, b) => {
      const ha = hintOf(a);
      const hb = hintOf(b);
      if (ha !== hb) return ha - hb;
      const ma = mtimeOf(a);
      const mb = mtimeOf(b);
      if (ma !== mb) return ma - mb;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    const pickNewest = (ids: string[]): string =>
      ids.reduce((best, id) => {
        const dm = mtimeOf(id) - mtimeOf(best);
        if (dm !== 0) return dm > 0 ? id : best;
        const db = bytesOf(id) - bytesOf(best);
        if (db !== 0) return db > 0 ? id : best;
        const dh = hintOf(id) - hintOf(best);
        if (dh !== 0) return dh > 0 ? id : best;
        return id > best ? id : best;
      });

    const liveMembers = ordered.filter((id) => liveIds.has(id));
    const tipId =
      liveMembers.length > 0 ? pickNewest(liveMembers) : pickNewest(ordered);

    // The conversation's start time, independent of tip selection: the
    // MINIMUM startedAt any member's facts carried. A `--resume` re-mint's
    // own birthtimeMs is the moment of the re-mint, not the conversation, so
    // taking the minimum (not the tip's own value) is what makes this stable
    // across every future re-mint too, not just the first one.
    let rootStartedAt: number | undefined;
    for (const m of ordered) {
      const s = factOf.get(m)?.startedAt;
      if (s === undefined) continue;
      if (rootStartedAt === undefined || s < rootStartedAt) rootStartedAt = s;
    }

    const chain: Chain = { rootId: ordered[0], members: ordered, tipId };
    if (rootStartedAt !== undefined) chain.rootStartedAt = rootStartedAt;
    chains.push(chain);
  }

  if (chains.length > 0) {
    log(
      `generations: ${chains.length} chain(s), ` +
        `${chains.reduce((n, c) => n + c.members.length - 1, 0)} superseded id(s)`,
    );
  }
  return new ChainIndex(chains, liveIds);
}

// ------------------------------------------------------------------ collapse

/** Editorial fields a collapsed row INHERITS from its older generations.
 *  Deliberately narrow: view-state verbs (`hidden`, `deleted`, `closed`,
 *  `boundWindowId`, `wrapRequestedAt`) stay with the physical id they were
 *  aimed at — a user who hid a stale duplicate row must not find the LIVE
 *  conversation muted the day the duplicate collapses into it. */
const INHERITED_RECORD_KEYS = [
  'title',
  'summary',
  'cwd',
  'provider',
  'parentId',
  'parentSource',
  'launchedByUs',
  // Muting notifications names the CONVERSATION — a re-minted id must stay
  // muted. doneAt/seenAt are deliberately NOT here: they describe one
  // physical session's turn, and inheriting a stale doneAt would light the
  // green dot on a fresh generation nobody finished anything in.
  'notify',
  // Same rationale as `notify`. Being a chat names the CONVERSATION, not one
  // physical id, so a plain `--resume` that mints a fresh generation must
  // stay a chat — otherwise the re-keyed chat surfaces as an ordinary row.
  'chat',
] as const;

export interface CollapseInput {
  entries: RosterEntry[];
  archived: ArchivedSession[];
  records: Record<string, EditorialRecord>;
  chains: ChainIndex;
}

export interface CollapseResult {
  entries: RosterEntry[];
  archived: ArchivedSession[];
  /** The caller's records plus, for each chain tip, an EFFECTIVE record that
   *  overlays inherited fields oldest-generation-first (so a title given to
   *  generation 1 carries to the current row, and a recorded parent edge on
   *  the chain root parents the whole conversation). */
  records: Record<string, EditorialRecord>;
}

/**
 * Drop superseded generations from the forest inputs and surface each chain's
 * editorial history on its tip. Pure; never mutates its inputs.
 */
export function collapseChains(input: CollapseInput): CollapseResult {
  const { chains } = input;
  const superseded = chains.supersededIds();
  if (superseded.size === 0) {
    return {
      entries: input.entries,
      archived: input.archived,
      records: input.records,
    };
  }

  const entries = input.entries.filter((e) => !superseded.has(e.sessionId));
  const archived = input.archived.filter((a) => !superseded.has(a.sessionId));

  const records: Record<string, EditorialRecord> = { ...input.records };
  // A chain's rootStartedAt overwrites the tip's own startedAt below, on the
  // same read-time-overlay principle as the records merge it sits next to:
  // collected here regardless of whether the chain has any records at all
  // (rootStartedAt comes from transcript facts, not from editorial history),
  // then applied once, after the loop, to the already-filtered entries/
  // archived arrays.
  const tipStartedAt = new Map<string, number>();
  for (const chain of chains.chains()) {
    if (chain.rootStartedAt !== undefined) {
      tipStartedAt.set(chain.tipId, chain.rootStartedAt);
    }
    const merged: Record<string, unknown> = {};
    let newestStamp = '';
    let oldestCreated = '';
    let sawAny = false;

    // Oldest → newest so a later generation's explicit value wins, exactly
    // like upsert's "undefined never clobbers" overlay, ordered by the
    // record's own updatedAt (member order breaks ties).
    const memberRecords = chain.members
      .map((id) => input.records[id])
      .filter((r): r is EditorialRecord => r !== undefined)
      .sort((a, b) =>
        (a.updatedAt ?? '') < (b.updatedAt ?? '')
          ? -1
          : (a.updatedAt ?? '') > (b.updatedAt ?? '')
            ? 1
            : 0,
      );
    for (const rec of memberRecords) {
      sawAny = true;
      for (const key of INHERITED_RECORD_KEYS) {
        const value = (rec as unknown as Record<string, unknown>)[key];
        if (value !== undefined) merged[key] = value;
      }
      if ((rec.updatedAt ?? '') > newestStamp) newestStamp = rec.updatedAt ?? '';
      if (oldestCreated === '' || (rec.createdAt ?? '') < oldestCreated) {
        oldestCreated = rec.createdAt ?? '';
      }
    }
    if (!sawAny) continue;

    // The tip's OWN record wins outright where it speaks — including its
    // view-state fields, which are never inherited.
    const own = input.records[chain.tipId];
    const effective: Record<string, unknown> = {
      ...merged,
      ...(own ? (own as unknown as Record<string, unknown>) : {}),
    };
    effective.id = chain.tipId;
    effective.createdAt =
      own?.createdAt ?? (oldestCreated !== '' ? oldestCreated : undefined);
    effective.updatedAt = own?.updatedAt ?? newestStamp;
    // A recorded parent edge inside the conversation's own chain is not a
    // parent — it is the continuation the chain already expresses.
    if (
      typeof effective.parentId === 'string' &&
      chain.members.includes(effective.parentId)
    ) {
      delete effective.parentId;
      delete effective.parentSource;
    }
    records[chain.tipId] = effective as unknown as EditorialRecord;
  }

  // Overwrite the tip's startedAt with its chain's rootStartedAt. Applied
  // AFTER the superseded filter, over what is by now only each chain's one
  // surviving row (its tip) — a plain `.map()` is cheap because tipStartedAt
  // only ever has as many entries as there are collapsed chains, not as many
  // as there are rows.
  const entriesOut =
    tipStartedAt.size === 0
      ? entries
      : entries.map((e) => {
          const startedAt = tipStartedAt.get(e.sessionId);
          return startedAt === undefined ? e : { ...e, startedAt };
        });
  const archivedOut =
    tipStartedAt.size === 0
      ? archived
      : archived.map((a) => {
          const startedAt = tipStartedAt.get(a.sessionId);
          return startedAt === undefined ? a : { ...a, startedAt };
        });

  const dropped = input.entries.length - entries.length;
  if (dropped > 0) {
    log(`generations: suppressed ${dropped} superseded live row(s)`);
  }
  return { entries: entriesOut, archived: archivedOut, records };
}
