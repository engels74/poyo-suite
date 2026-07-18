import type { Database } from 'bun:sqlite';

interface SqliteMasterEntry {
  type: string;
  name: string;
  tableName: string;
  sql: string | null;
}

interface TableColumn {
  cid: number;
  name: string;
  type: string;
  notNull: number;
  defaultValue: string | null;
  primaryKeyOrder: number;
  hidden: number;
}

interface ForeignKey {
  id: number;
  sequence: number;
  table: string;
  from: string;
  to: string | null;
  onUpdate: string;
  onDelete: string;
  match: string;
}

interface IndexColumn {
  sequence: number;
  columnId: number;
  name: string | null;
  descending: number;
  collation: string;
  key: number;
}

interface TableIndex {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  columns: IndexColumn[];
}

interface TableSignature {
  name: string;
  columns: TableColumn[];
  foreignKeys: ForeignKey[];
  indexes: TableIndex[];
}

export interface DatabaseSchemaSignature {
  sqliteMaster: SqliteMasterEntry[];
  tables: TableSignature[];
  safetyPragmas: {
    foreignKeys: number;
    journalMode: string;
    synchronous: number;
    busyTimeout: number;
  };
}

interface SqliteMasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface TableColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexColumnRow {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string;
  key: number;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeSql(sql: string | null): string | null {
  if (sql === null) return null;
  return sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
}

function tableSignature(database: Database, name: string): TableSignature {
  const identifier = quoteIdentifier(name);
  const columns = database
    .query<TableColumnRow, []>(`PRAGMA table_xinfo(${identifier})`)
    .all()
    .sort((left, right) => left.cid - right.cid)
    .map((column) => ({
      cid: column.cid,
      name: column.name,
      type: column.type,
      notNull: column.notnull,
      defaultValue: column.dflt_value,
      primaryKeyOrder: column.pk,
      hidden: column.hidden
    }));
  const foreignKeys = database
    .query<ForeignKeyRow, []>(`PRAGMA foreign_key_list(${identifier})`)
    .all()
    .sort((left, right) => left.id - right.id || left.seq - right.seq)
    .map((foreignKey) => ({
      id: foreignKey.id,
      sequence: foreignKey.seq,
      table: foreignKey.table,
      from: foreignKey.from,
      to: foreignKey.to,
      onUpdate: foreignKey.on_update,
      onDelete: foreignKey.on_delete,
      match: foreignKey.match
    }));
  const indexes = database
    .query<IndexListRow, []>(`PRAGMA index_list(${identifier})`)
    .all()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((index) => ({
      name: index.name,
      unique: index.unique,
      origin: index.origin,
      partial: index.partial,
      columns: database
        .query<IndexColumnRow, []>(`PRAGMA index_xinfo(${quoteIdentifier(index.name)})`)
        .all()
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => ({
          sequence: column.seqno,
          columnId: column.cid,
          name: column.name,
          descending: column.desc,
          collation: column.coll,
          key: column.key
        }))
    }));

  return { name, columns, foreignKeys, indexes };
}

export function databaseSchemaSignature(database: Database): DatabaseSchemaSignature {
  const sqliteMaster = database
    .query<SqliteMasterRow, []>(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE type IN ('table', 'index', 'trigger', 'view')
         AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`
    )
    .all()
    .map((entry) => ({
      type: entry.type,
      name: entry.name,
      tableName: entry.tbl_name,
      sql: normalizeSql(entry.sql)
    }));
  const tables = sqliteMaster
    .filter((entry) => entry.type === 'table')
    .map((entry) => tableSignature(database, entry.name));

  return {
    sqliteMaster,
    tables,
    safetyPragmas: {
      foreignKeys:
        database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys ??
        -1,
      journalMode:
        database.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode ??
        '',
      synchronous:
        database.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous ?? -1,
      busyTimeout:
        database.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()?.timeout ?? -1
    }
  };
}
