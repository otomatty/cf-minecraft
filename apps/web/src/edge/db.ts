export const MAX_WORLDS_PER_CREATOR = 5;
export const MAX_MEMBERS_PER_WORLD = 64;
export type Role = "operator" | "player";

export interface World {
	name: string;
	owner_id: string;
	owner_email: string;
}

export function createDB(db: D1Database) {
	const query = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args);
	return {
		async sessionExists(id: string): Promise<boolean> {
			return (await query("SELECT id FROM session WHERE id = ?", id).first<{ id: string }>()) !== null;
		},
		async userIds(email: string) {
			const result = await query('SELECT id FROM "user" WHERE lower(email) = ?', email).all<{
				id: string;
			}>();
			return result.results.map(row => row.id);
		},
		world: (name: string) =>
			query(
				"SELECT w.name, w.owner_id, lower(u.email) AS owner_email FROM world w " +
					'JOIN "user" u ON u.id = w.owner_id WHERE w.name = ?',
				name,
			).first<World>(),
		member: (name: string, email: string) =>
			query("SELECT role FROM world_member WHERE world = ? AND email = ?", name, email).first<{
				role: Role;
			}>(),
		async worlds(userId: string, email: string) {
			return (
				await query(
					"SELECT w.name, m.role, w.owner_id = ? AS owner FROM world w " +
						"JOIN world_member m ON w.name = m.world WHERE m.email = ? ORDER BY w.name",
					userId,
					email,
				).all<{ name: string; role: Role; owner: number }>()
			).results.map(row => ({ ...row, owner: !!row.owner }));
		},
		async createWorld(
			name: string,
			userId: string,
			email: string,
		): Promise<"created" | "exists" | "limit"> {
			// Conditional writes enforce the quota within the D1 batch transaction.
			try {
				const results = await db.batch([
					query(
						"INSERT INTO world(name, owner_id, created_at) SELECT ?, ?, ? " +
							"WHERE (SELECT count(*) FROM world WHERE owner_id = ?) < ?",
						name,
						userId,
						Date.now(),
						userId,
						MAX_WORLDS_PER_CREATOR,
					),
					query(
						"INSERT INTO world_member(world, email, role, created_at) " +
							"SELECT name, ?, 'operator', ? FROM world " +
							"WHERE name = ? AND owner_id = ? AND changes() = 1",
						email,
						Date.now(),
						name,
						userId,
					),
				]);
				return results[0].meta.changes ? "created" : "limit";
			} catch (error) {
				if (await this.world(name)) {
					return "exists";
				}
				throw error;
			}
		},
		async members(name: string) {
			return (
				await query(
					"SELECT email, role FROM world_member WHERE world = ? ORDER BY email",
					name,
				).all<{ email: string; role: Role }>()
			).results;
		},
		async putMember(name: string, email: string, role: Role): Promise<boolean> {
			const result = await query(
				`INSERT INTO world_member(world, email, role, created_at)
				SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM world_member WHERE world = ? AND email = ?)
				OR (SELECT count(*) FROM world_member WHERE world = ?) < ?
				ON CONFLICT(world, email) DO UPDATE SET role = excluded.role`,
				name,
				email,
				role,
				Date.now(),
				name,
				email,
				name,
				MAX_MEMBERS_PER_WORLD,
			).run();
			return result.meta.changes > 0;
		},
		async deleteMember(name: string, email: string) {
			await query("DELETE FROM world_member WHERE world = ? AND email = ?", name, email).run();
		},
	};
}

export type WorldDB = ReturnType<typeof createDB>;
