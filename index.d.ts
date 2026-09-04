// Type definitions for echodb

export interface EchoEntriesDBOptions {
  /**
   * Echo Entries account email.
   * Not required when `memoryOnly: true`.
   */
  email?: string;
  /**
   * Echo Entries account password.
   * Not required when `memoryOnly: true`.
   */
  password?: string;
  /**
   * Run entirely in RAM without any network calls, WAL, or authentication.
   * Ideal for unit tests, CI/CD pipelines, and offline development.
   * All collection, transaction, exportJSON, and importJSON APIs work normally.
   * Default: false
   */
  memoryOnly?: boolean;
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
  /** Max ops per bulk POST to Echo Entries. Default: 10 */
  batchSize?: number;
  /** Ms to wait for more ops to accumulate before firing a batch. Default: 8 */
  batchWindowMs?: number;
}

/** Canonical PocketBase-compatible document metadata automatically added to every stored document. */
export interface DocMeta {
  /** PocketBase-compatible 15-character lowercase alphanumeric identifier ([a-z0-9]{15}). */
  id: string;
  /** Canonical ISO-8601 UTC creation timestamp. */
  created: string;
  /** Canonical ISO-8601 UTC last update timestamp. */
  updated: string;
  /** Internal revision version counter. */
  _v?: number;
  /** Internal cloud row id. */
  _eeId?: string | null;
  /** Resolved relational objects populated via expand. */
  expand?: Record<string, any>;
}

export type Predicate<T> = (doc: T & DocMeta) => boolean;

export interface IndexOptions {
  /** Enforce unique constraint across all documents in this collection. */
  unique?: boolean;
}

export type FieldType =
  | 'text'
  | 'string'
  | 'number'
  | 'int'
  | 'float'
  | 'bool'
  | 'boolean'
  | 'json'
  | 'relation'
  | 'select'
  | 'email'
  | 'url'
  | 'date'
  | 'datetime';

export interface FieldSchema {
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  index?: boolean;
  default?: any;
  options?: string[];
  collection?: string;
}

export type CollectionSchema = Record<string, FieldSchema>;

export interface GetOneOptions {
  /**
   * Fields to expand into related document records.
   * Accepts field name string ('customerId'), comma-separated ('customerId,shiftId'),
   * array of fields (['customerId']), or object mapping field to collection ({ customerId: 'customers' }).
   */
  expand?: string | string[] | Record<string, string>;
  /**
   * Comma-separated list of fields to project in the response.
   * Mirrors the PocketBase SDK `fields` option.
   * Example: 'id,name,email' — only those fields will be present in the returned object.
   */
  fields?: string;
}

export interface GetListOptions<T> extends GetOneOptions {
  /** Filter predicate function or equality object. */
  filter?: Predicate<T> | Partial<T> | Record<string, unknown>;
  /**
   * Sort criteria. Supports PocketBase sort syntax:
   * '-created' (descending), '+created' or 'created' (ascending), 'title:asc', 'title:desc',
   * or comma-separated / array of sort keys.
   */
  sort?: string | string[];
  /**
   * When true, skip computing totalItems and totalPages (faster).
   * Returned values will be -1 when skipTotal is set.
   * Mirrors the PocketBase SDK `skipTotal` option.
   */
  skipTotal?: boolean;
}

export interface PocketBaseListResult<T> {
  page: number;
  perPage: number;
  /** -1 when skipTotal: true was used. */
  totalItems: number;
  /** -1 when skipTotal: true was used. */
  totalPages: number;
  items: (T & DocMeta)[];
}

export interface PocketBaseBatchRequest {
  action: 'create' | 'update' | 'delete' | 'upsert';
  collection: string;
  body: Record<string, unknown>;
}

export interface PocketBaseBatchPayload {
  requests: PocketBaseBatchRequest[];
}

export interface PocketBaseBatchOptions {
  /** Max operations per batch payload (default: 100). */
  batchSize?: number;
  /** Subset of collections to export (default: all). */
  collections?: string[];
}

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

export interface ExportOptions {
  /** Filter specific collection names to export (default: all) */
  collections?: string[];
  /** Format JSON output with 2-space indentation (default: false) */
  pretty?: boolean;
  /** Return a JSON string if true, or a plain JavaScript object if false (default: true) */
  stringify?: boolean;
  /** Strip internal metadata fields (_v, _eeId) from exported documents (default: false) */
  excludeMeta?: boolean;
}

export interface ImportOptions {
  /**
   * Import strategy:
   * - 'upsert': insert new, update existing (default)
   * - 'overwrite': clear collection before importing
   * - 'insert': insert only (throws error if document already exists)
   */
  mode?: 'upsert' | 'overwrite' | 'insert';
  /** Optional subset of collection names to import */
  collections?: string[];
}

export interface CollectionExportResult<T = Record<string, unknown>> {
  collection: string;
  count: number;
  exportedAt: string;
  documents: (T & DocMeta)[] | Partial<T>[];
}

export interface DatabaseExportResult {
  version: number;
  exportedAt: string;
  collections: Record<string, (DocMeta & Record<string, unknown>)[]>;
}

export interface DatabaseImportResult {
  imported: Record<string, number>;
  total: number;
}

export interface CollectionImportResult {
  imported: number;
}

// ── Collection ────────────────────────────────────────────────────────────────

export class Collection<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;

  // ── Reads O(1) ───────────────────────────────────────────────────────────
  findById(id: string): (T & DocMeta) | null;

  // ── PocketBase Query Parity ──────────────────────────────────────────────
  /**
   * Fetch single record by ID with optional relation expansion and field projection.
   * PocketBase SDK compatible method.
   */
  getOne(id: string, options?: GetOneOptions): (T & DocMeta) | null;

  /**
   * Fetch first record matching predicate, field value, or query object.
   * Supports optional expand and field projection.
   * PocketBase SDK compatible method.
   */
  getFirstListItem(
    filterOrField: Predicate<T> | keyof T | Partial<T>,
    valueOrOptions?: unknown,
    maybeOptions?: GetOneOptions
  ): (T & DocMeta) | null;

  /**
   * Fetch all records matching optional filter, sort, expand and field projection.
   * PocketBase SDK compatible method.
   */
  getFullList(options?: GetListOptions<T>): (T & DocMeta)[];

  /**
   * Fetch paginated list of records matching PocketBase response format.
   * PocketBase SDK compatible method. Supports skipTotal for faster queries.
   */
  getList(page?: number, perPage?: number, options?: GetListOptions<T>): PocketBaseListResult<T>;

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
  findBy(field: keyof T | string, value: unknown): (T & DocMeta)[];
  findOneBy(field: keyof T | string, value: unknown): (T & DocMeta) | null;

  /**
   * Declare a secondary index on this collection.
   * @param field Field name to index
   * @param opts Index options (e.g. { unique: true })
   */
  createIndex(field: keyof T | string, opts?: IndexOptions): void;

  // ── Chainable query builder ───────────────────────────────────────────────
  /**
   * Start a chainable query. Uses indexes automatically when available.
   * @example
   *   col.where({ role: 'admin' }).sortBy('age', 'desc').limit(10).exec()
   */
  where(conditions: Partial<T & DocMeta>): Query<T>;

  // ── Writes (RAM-immediate + async persist to EE) ──────────────────────────
  /**
   * Create a new document — canonical PocketBase SDK method name.
   * Auto-generates a 15-char PocketBase ID if none is provided.
   * `insert()` is kept as a backward-compatible alias.
   */
  create(bodyParams: Partial<T> & { id?: string }, options?: GetOneOptions): Promise<T & DocMeta>;

  /**
   * Insert a new document.
   * Alias for `create()` — kept for backward compatibility.
   */
  insert(doc: Partial<T> & { id?: string }): Promise<T & DocMeta>;

  /**
   * Update a document by ID (PATCH semantics — partial merge).
   * Canonical PocketBase SDK method name and signature.
   * Supports optional expand and field projection in the response.
   */
  update(id: string, bodyParams: Partial<T>, options?: GetOneOptions): Promise<T & DocMeta>;

  /** Upsert — insert if id does not exist, update if it does. */
  upsert(doc: Partial<T> & { id?: string }): Promise<T & DocMeta>;
  delete(id: string): Promise<boolean>;

  /** Delete all documents in this collection. Returns count of deleted documents. */
  clear(): Promise<number>;

  /** Export this collection to JSON string or object. */
  exportJSON(opts?: Omit<ExportOptions, 'collections'>): string | CollectionExportResult<T>;

  /** Import documents into this collection. */
  importJSON(
    data: string | (Partial<T> & { id?: string })[] | { documents: (Partial<T> & { id?: string })[] },
    opts?: ImportOptions
  ): Promise<CollectionImportResult>;
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
   *   db.createIndex('users', 'email', { unique: true });
   */
  createIndex(colName: string, field: string, opts?: IndexOptions): void;

  /**
   * Register a lightweight schema contract for a collection.
   * Enables automatic SQLite zero-value coercion, validation, and PocketBase migration generation.
   * Also automatically registers unique indexes for fields with `unique: true`.
   */
  defineSchema(colName: string, schema: CollectionSchema): this;

  /** Get registered schema definition for a collection. */
  getSchema(colName: string): CollectionSchema | null;

  /** Generate a PocketBase (v0.23+) JS migration script from registered schemas. */
  generatePocketBaseMigration(opts?: { migrationName?: string }): string;

  /**
   * Export all database records partitioned into chunks formatted for PocketBase's
   * transactional batch endpoint (POST /api/batch, introduced in v0.22+).
   */
  exportPocketBaseBatch(opts?: PocketBaseBatchOptions): PocketBaseBatchPayload[];

  /**
   * Atomic transaction — rolls back all RAM changes (stores + indexes + unique sets) if fn throws.
   * WAL ops are only committed on success.
   */
  transaction<R>(fn: (db: EchoEntriesDB) => Promise<R>): Promise<R>;

  /**
   * Export all (or selected) database collections to JSON string or object.
   */
  exportJSON(opts?: ExportOptions): string | DatabaseExportResult;

  /**
   * Atomically import JSON database dump across one or multiple collections.
   */
  importJSON(
    data: string | DatabaseExportResult | Record<string, (Record<string, unknown> & { id?: string })[]>,
    opts?: ImportOptions
  ): Promise<DatabaseImportResult>;
}

export default EchoEntriesDB;
