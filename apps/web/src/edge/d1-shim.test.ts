import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function testDB() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	sqlite.exec(readFileSync(new URL("../../migrations/0001_auth.sql", import.meta.url), "utf8"));

	class Statement {
		sql: string;
		args: unknown[];

		constructor(sql: string, args: unknown[] = []) {
			this.sql = sql;
			this.args = args;
		}

		bind(...args: unknown[]) {
			return new Statement(this.sql, args);
		}

		async first(column?: string) {
			const row = sqlite.prepare(this.sql).get(...this.args) ?? null;
			return column && row ? row[column] : row ? { ...row } : null;
		}

		async all() {
			return {
				results: sqlite
					.prepare(this.sql)
					.all(...this.args)
					.map(row => ({ ...row })),
				success: true,
			};
		}

		async run() {
			return { success: true, meta: sqlite.prepare(this.sql).run(...this.args) };
		}
	}

	const db = {
		prepare: (sql: string) => new Statement(sql),
		async batch(statements: Statement[]) {
			sqlite.exec("BEGIN");
			try {
				const results = [];
				for (const statement of statements) {
					results.push(await statement.run());
				}
				sqlite.exec("COMMIT");
				return results;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
	const user = (id: string, email: string) =>
		sqlite
			.prepare(
				'INSERT INTO "user"(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)',
			)
			.run(id, id, email);
	return { db, sqlite, user, close: () => sqlite.close() };
}
