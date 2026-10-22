// The content cache behind the contexo: file system (WP-1.10). Pure: no runtime vscode
// import and generic over the Uri type U, so plain mocha unit tests drive it with plain
// objects. It never decodes bytes and never derives a page state: it only compares the
// sha/hash a StatusDoc entry reports for a ref.
import type { PageEntry } from "../contract/types";

/** At most this many (root, relPath, ref) slots hold bytes. */
export const CONTENT_CACHE_CAPACITY = 200;
/** At most this many byte-less "served" records (URIs to report on a later change) are kept; oldest first out. */
export const SERVED_RECORD_CAPACITY = 1000;
/** Per-URI versions kept (stat mtime); oldest first out. */
const VERSION_CAPACITY = 4096;
/** A read whose version keeps moving while it is fetched gives up after this many fetches. */
const MAX_ATTEMPTS = 3;

const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

export type RefKind = "base" | "server" | "sha";

/** 'base', 'server', or 'sha' for a 7-64 char hex commit sha; undefined for 'empty' and anything else. */
export function refKind(ref: unknown): RefKind | undefined {
  if (ref === "base" || ref === "server") { return ref; }
  return typeof ref === "string" && SHA_RE.test(ref) ? "sha" : undefined;
}

/**
 * The contract path rules (mirror of ctx's syncstate.ValidateRelPath): non-empty; no control
 * character (< 0x20 or 0x7f), '\' or ':'; no lone UTF-16 surrogate; not absolute; every
 * '/'-separated segment non-empty, not '.' or '..', not starting with '-' or '.'; ends in '.md'.
 */
export function isContractRelPath(p: unknown): boolean {
  if (typeof p !== "string" || p === "" || p.startsWith("/") || !p.endsWith(".md")) { return false; }
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c /* \ */ || c === 0x3a /* : */) { return false; }
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = p.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) { return false; }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return p.split("/").every((seg) => seg !== "" && !seg.startsWith(".") && !seg.startsWith("-"));
}

/** What identifies the bytes of one (root, relPath, ref): a commit sha, plus the base hash for 'base'. */
export interface KeyInputs { sha: string; hash?: string; }

/**
 * The key inputs of ref for a status entry, or undefined when the version is unknown:
 * base -> a verified base (present, not stale, with a hash): {base.sha, base.hash};
 * server -> {remote.sha}; an explicit sha ref -> {sha: ref} (always known, immutable).
 */
export function keyInputs(entry: PageEntry | undefined, ref: string): KeyInputs | undefined {
  switch (refKind(ref)) {
    case "base": {
      const b = entry?.base;
      return b && !b.stale && b.sha && b.hash ? { sha: b.sha, hash: b.hash } : undefined;
    }
    case "server": {
      const sha = entry?.remote?.sha;
      return sha ? { sha } : undefined;
    }
    case "sha": return { sha: ref };
    default: return undefined;
  }
}

/** Equal key inputs; two unknowns are equal. */
export function sameInputs(a: KeyInputs | undefined, b: KeyInputs | undefined): boolean {
  if (a === undefined || b === undefined) { return a === b; }
  return a.sha === b.sha && a.hash === b.hash;
}

export interface ContentCacheOptions<U> {
  /** Fetch the bytes (ctx show); never called for 'empty'. */
  fetch(root: string, relPath: string, ref: string): Promise<Uint8Array>;
  /** The current status entry of relPath (read at call time). */
  page(root: string, relPath: string): PageEntry | undefined;
  /** Identity of a URI (de-duplication and versions). */
  uriKey(uri: U): string;
  /** Slots with bytes (default CONTENT_CACHE_CAPACITY). */
  capacity?: number;
  /** Byte-less served records (default SERVED_RECORD_CAPACITY). */
  recordCapacity?: number;
}

/** The URIs one (root, relPath, ref) was served to, and the key inputs they were served for. */
interface Served<U> {
  readonly root: string;
  readonly relPath: string;
  readonly ref: string;
  /** undefined: served while the version was unknown (or never settled). */
  readonly inputs: KeyInputs | undefined;
  readonly uris: Map<string, U>;
}
interface Entry<U> extends Served<U> {
  readonly inputs: KeyInputs;
  readonly bytes: Uint8Array;
}
/** One in-flight fetch of a (slot, inputs); waiters add their URI before it settles. */
interface Flight<U> {
  readonly root: string;
  readonly uris: Map<string, U>;
  readonly done: Promise<Uint8Array>;
}

const slotKey = (root: string, relPath: string, ref: string): string => JSON.stringify([root, relPath, ref]);
const copy = (b: Uint8Array): Uint8Array => new Uint8Array(b);

/**
 * One slot per (root, relPath, ref). A slot with bytes (`entries`, least recently used
 * first) is a hit only while its stored key inputs equal the current ones. A version whose
 * inputs are unknown is fetched but never cached; its URIs are kept in a byte-less record
 * (`records`) so a later status that changes the inputs still reports them. Every read
 * returns a fresh copy; the cached array is never handed out.
 */
export class ContentCache<U> {
  private readonly entries = new Map<string, Entry<U>>();
  private readonly records = new Map<string, Served<U>>();
  private readonly flights = new Map<string, Flight<U>>();
  private readonly versions = new Map<string, number>();
  /** Bumped by dropRoot, so a fetch that started before it never stores. */
  private readonly epochs = new Map<string, number>();
  private clock = 0;
  private readonly capacity: number;
  private readonly recordCapacity: number;

  constructor(private readonly o: ContentCacheOptions<U>) {
    this.capacity = Math.max(1, o.capacity ?? CONTENT_CACHE_CAPACITY);
    this.recordCapacity = Math.max(0, o.recordCapacity ?? SERVED_RECORD_CAPACITY);
  }

  /** Slots holding bytes. */
  get entryCount(): number { return this.entries.size; }

  /**
   * The bytes of ref (never 'empty') for uri. A hit touches the LRU; a miss fetches,
   * sharing one in-flight fetch per (slot, inputs). When the inputs moved while fetching
   * (and are known), it fetches again (at most MAX_ATTEMPTS fetches), so a version an
   * invalidation already passed over is never cached or returned. A rejected fetch rejects
   * every waiter and leaves nothing behind.
   */
  async read(root: string, relPath: string, ref: string, uri: U): Promise<Uint8Array> {
    const key = slotKey(root, relPath, ref);
    const inputs = this.inputsOf(root, relPath, ref);
    const hit = this.entries.get(key);
    if (inputs !== undefined && hit !== undefined && sameInputs(hit.inputs, inputs)) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      hit.uris.set(this.o.uriKey(uri), uri);
      return copy(hit.bytes);
    }
    const flight = this.flight(key, root, relPath, ref, inputs);
    flight.uris.set(this.o.uriKey(uri), uri);
    return copy(await flight.done);
  }

  /**
   * Evict every slot and record of root whose stored inputs differ from the current ones
   * (lookup, else page()): known -> other known, known -> unknown, unknown -> known. Bumps
   * the version of every URI they served and returns those URIs, once each (by uriKey).
   */
  invalidate(root: string, lookup?: (relPath: string) => PageEntry | undefined): U[] {
    const current = (relPath: string): PageEntry | undefined => (lookup ? lookup(relPath) : this.o.page(root, relPath));
    const fired = new Map<string, U>();
    for (const map of [this.entries, this.records] as Map<string, Served<U>>[]) {
      for (const [key, slot] of map) {
        if (slot.root !== root || sameInputs(slot.inputs, keyInputs(current(slot.relPath), slot.ref))) { continue; }
        map.delete(key);
        this.bump(slot.uris);
        for (const [k, u] of slot.uris) { fired.set(k, u); }
      }
    }
    return [...fired.values()];
  }

  /** Forget every slot, record and in-flight fetch of root (a closed repository). */
  dropRoot(root: string): void {
    this.epochs.set(root, (this.epochs.get(root) ?? 0) + 1);
    for (const map of [this.entries, this.records, this.flights] as Map<string, { root: string }>[]) {
      for (const [key, v] of map) {
        if (v.root === root) { map.delete(key); }
      }
    }
  }

  /** The version of uri (stat mtime): 0 until a slot that served it is evicted, then larger after every eviction. */
  version(uri: U): number {
    return this.versions.get(this.o.uriKey(uri)) ?? 0;
  }

  /** The cached byte length of (root, relPath, ref), or 0. */
  sizeOf(root: string, relPath: string, ref: string): number {
    return this.entries.get(slotKey(root, relPath, ref))?.bytes.length ?? 0;
  }

  private inputsOf(root: string, relPath: string, ref: string): KeyInputs | undefined {
    const kind = refKind(ref);
    if (kind === undefined) { return undefined; }
    return keyInputs(kind === "sha" ? undefined : this.o.page(root, relPath), ref);
  }

  private flight(key: string, root: string, relPath: string, ref: string, inputs: KeyInputs | undefined): Flight<U> {
    const fkey = JSON.stringify([key, inputs?.sha ?? null, inputs?.hash ?? null]);
    const existing = this.flights.get(fkey);
    if (existing) { return existing; }
    const uris = new Map<string, U>();
    const epoch = this.epochs.get(root) ?? 0;
    // Started on a microtask, so the flight is in the map before fetch can settle or throw.
    const done = Promise.resolve().then(() => this.fetchAndStore(fkey, uris, epoch, key, root, relPath, ref, inputs));
    const flight: Flight<U> = { root, uris, done };
    this.flights.set(fkey, flight);
    return flight;
  }

  private async fetchAndStore(
    fkey: string, uris: Map<string, U>, epoch: number,
    key: string, root: string, relPath: string, ref: string, inputs: KeyInputs | undefined,
  ): Promise<Uint8Array> {
    const settle = (): void => {
      if (this.flights.get(fkey)?.uris === uris) { this.flights.delete(fkey); }
    };
    try {
      let want = inputs;
      for (let attempt = 1; ; attempt++) {
        const bytes = await this.o.fetch(root, relPath, ref);
        // Checked and stored in one synchronous step: an invalidation can never fall between.
        const now = this.inputsOf(root, relPath, ref);
        const stable = now === undefined || sameInputs(now, want);
        if (stable || attempt >= MAX_ATTEMPTS) {
          settle();
          if ((this.epochs.get(root) ?? 0) === epoch) {
            // A version that never settled is stored like an unknown one: not cached.
            this.store(key, root, relPath, ref, stable ? now : undefined, bytes, uris);
          }
          return bytes;
        }
        want = now;
      }
    } catch (err) {
      settle();
      throw err;
    }
  }

  /**
   * Known inputs -> a slot with a copy of the bytes (LRU); unknown -> a byte-less record.
   * The URIs the slot already served are kept; if they were served for other inputs (only
   * possible when a status change raced a store), their versions are bumped.
   */
  private store(
    key: string, root: string, relPath: string, ref: string,
    inputs: KeyInputs | undefined, bytes: Uint8Array, served: Map<string, U>,
  ): void {
    const old = this.entries.get(key) ?? this.records.get(key);
    this.entries.delete(key);
    this.records.delete(key);
    const uris = new Map<string, U>();
    if (old) {
      if (!sameInputs(old.inputs, inputs)) { this.bump(old.uris); }
      for (const [k, u] of old.uris) { uris.set(k, u); }
    }
    for (const [k, u] of served) { uris.set(k, u); }
    if (inputs === undefined) {
      this.addRecord(key, { root, relPath, ref, inputs: undefined, uris });
      return;
    }
    this.entries.set(key, { root, relPath, ref, inputs, bytes: copy(bytes), uris });
    while (this.entries.size > this.capacity) {
      const [oldestKey, oldest] = this.entries.entries().next().value as [string, Entry<U>];
      this.entries.delete(oldestKey);
      this.bump(oldest.uris);
      this.addRecord(oldestKey, { root: oldest.root, relPath: oldest.relPath, ref: oldest.ref, inputs: oldest.inputs, uris: oldest.uris });
    }
  }

  private addRecord(key: string, record: Served<U>): void {
    this.records.delete(key);
    this.records.set(key, record);
    while (this.records.size > this.recordCapacity) {
      const oldest = this.records.keys().next().value as string;
      this.records.delete(oldest);
    }
  }

  private bump(uris: Map<string, U>): void {
    for (const k of uris.keys()) {
      this.versions.delete(k);
      this.versions.set(k, ++this.clock);
    }
    while (this.versions.size > VERSION_CAPACITY) {
      this.versions.delete(this.versions.keys().next().value as string);
    }
  }
}
