// The part of Node's built-in SQLite the tests use as a stand-in for D1
// (@types/node is not among the project's types)
declare module 'node:sqlite' {
  type SQLValue = null | number | bigint | string | Uint8Array;

  export class StatementSync {
    all(...params: SQLValue[]): Record<string, SQLValue>[];
    run(...params: SQLValue[]): unknown;
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
