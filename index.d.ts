// Type definitions for @isclaudeia/echo-entries-db

export interface EchoEntriesDBOptions {
  /** Echo Entries account email */
  email: string;
  /** Echo Entries account password */
  password: string;
  /**
   * Optional extra secret for the inner encryption layer.
   * When provided, data is encrypted twice:
   *   1. Inner: AES-GCM(encryptionSecret) — even EE admins cannot read
   *   2. Outer: AES-GCM(userId)           — identical format to EE UI entries
   */
  encryptionSecret?: string;
  /** Path to WAL file on disk. Default: ./.echodb_wal.json */
  walPath?: string;
  /** Auto-sync interval in ms (0 = disabled). Default: 300000 */
  autoSyncMs?: number;
  /** Op-entries before automatic compaction per collection. Default: 20 */
  compactEvery?: number;
  /** Max parallel POSTs per drain cycle. Default: 10 */
  batchSize?: number;
  /** Ms to wait for more ops to accumulate before firing a batch. Default: 8 */
  batchWindowMs?: number;
}

/** Metadata automatically added to every stored document. */
export interface DocMeta {
  id: string;
  _col: string;
  _id: string;
  _type: 'op' | 'snapshot';
  _op: 'INSERT' | 'UPDATE' | 'DELETE';
  _v: number;
  _eeId: string | null;
  _createdAt: string;
  _updatedAt: string;
}

export type Predicate<T> = (doc: T & DocMeta) => boolean;

// ── Query builder ─────────────────────────────────────────────────────────────

export class Query<T extends Record<string, unknown>> {
  /** Apply additional filter conditions. */
  where(conditions: Partial<T>): this;
  /** Sort by field. Default direction: 'asc'. */
  sortBy(field: keyof T | keyof DocMeta, direction?: 'asc' | 'desc'): this;
  /** Max number of results. */
  limit(n: number): this;
  /** Skip first n results. */
  offset(n: number): this;
  /** Execute and return results. */
  exec(): (T & DocMeta)[];
  /** Alias for exec(). */
  get(): (T & DocMeta)[];
  /** Return first result or null. */
  first(): (T & DocMeta) | null;
  /** Return count of matching documents. */
  count(): number;
}

// ── Collection ────────────────────────────────────────────────────────────────

export class Collection<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;

  // ── Reads O(1) ───────────────────────────────────────────────────────────
  findById(id: string): (T & DocMeta) | null;

  // ── Reads O(n) full scan ─────────────────────────────────────────────────
  find(predicate?: Predicate<T>): (T & DocMeta)[];
  findOne(predicate: Predicate<T>): (T & DocMeta) | null;
  all(): (T & DocMeta)[];
  count(predicate?: Predicate<T>): number;

  // ── Reads O(1) via secondary index ───────────────────────────────────────
  /**
   * Exact-match lookup using a secondary index.
   * Requires db.createIndex(colName, field) first.
   * Falls back to O(n) scan with a warning if index doesn't exist.
   */
  findBy(field: keyof T, value: unknown): (T & DocMeta)[];
  findOneBy(field: keyof T, value: unknown): (T & DocMeta) | null;

  // ── Chainable query builder ───────────────────────────────────────────────
  /**
   * Start a chainable query. Uses indexes automatically when available.
   * @example
   *   col.where({ role: 'admin' }).sortBy('age', 'desc').limit(10).exec()
   */
  where(conditions: Partial<T & DocMeta>): Query<T>;

  // ── Writes (RAM-immediate + async persist to EE) ──────────────────────────
  insert(doc: Partial<T> & { id?: string }): Promise<T & DocMeta>;
  update(id: string, updates: Partial<T>): Promise<T & DocMeta>;
  upsert(doc: Partial<T> & { id: string }): Promise<T & DocMeta>;
  delete(id: string): Promise<boolean>;
}

export interface RegisterOptions {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

export interface RegisterResult {
  user: Record<string, unknown> | null;
  session: Record<string, unknown> | null;
  /** True when EE requires the user to confirm their email before logging in. */
  emailConfirmationRequired: boolean;
}

// ── EchoEntriesDB ─────────────────────────────────────────────────────────────

export class EchoEntriesDB {
  constructor(opts: EchoEntriesDBOptions);

  /**
   * Create a new Echo Entries account.
   * Static — no existing instance needed.
   *
   * @example
   *   const { emailConfirmationRequired } = await EchoEntriesDB.register({
   *     email: 'user@example.com',
   *     password: 'secure-password',
   *     firstName: 'Ana',
   *     lastName: 'López'
   *   });
   *   if (emailConfirmationRequired) {
   *     console.log('Check your inbox and confirm your email first.');
   *   }
   */
  static register(opts: RegisterOptions): Promise<RegisterResult>;

  /** Authenticate, load WAL, sync from EE, drain pending ops. */
  init(): Promise<this>;

  /** Flush all pending ops and close. */
  close(): Promise<void>;

  /** Block until WAL is fully drained to EE. */
  flush(): Promise<void>;

  /** Re-sync from Echo Entries into RAM. Rebuilds all declared indexes. */
  sync(): Promise<void>;

  /** Get (or lazily create) a typed collection. */
  collection<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string
  ): Collection<T>;

  /**
   * Declare a secondary index on a collection field.
   * Built immediately from current RAM state.
   * Maintained automatically on insert/update/delete.
   * Rebuilt automatically on sync().
   *
   * @example
   *   db.createIndex('posts', 'authorId');
   *   col.findBy('authorId', 'usr_123');   // O(1)
   */
  createIndex(colName: string, field: string): void;

  /**
   * Atomic transaction — rolls back all RAM changes (stores + indexes) if fn throws.
   * WAL ops are only committed on success.
   */
  transaction<R>(fn: (db: EchoEntriesDB) => Promise<R>): Promise<R>;
}

export default EchoEntriesDB;
