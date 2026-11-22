export const MAX_WORLDS_PER_CREATOR = 5;
export const MAX_MEMBERS_PER_WORLD = 64;
export type Role = "operator" | "player";
export type GameMode = "creative" | "survival";

export interface World {
	name: string;
	owner_id: string;
	owner_email: string;
	gameMode: GameMode;
	gameModeRevision: number;
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
		async world(name: string) {
			const row = await query(
				"SELECT w.name, w.owner_id, lower(u.email) AS owner_email, w.game_mode AS gameMode, " +
					"w.game_mode_revision AS gameModeRevision FROM world w " +
					'JOIN "user" u ON u.id = w.owner_id WHERE w.name = ?',
				name,
			).first<World>();
			if (!row) return null;
			return { ...row, gameModeRevision: Number(row.gameModeRevision) };
		},
		member: (name: string, email: string) =>
			query("SELECT role FROM world_member WHERE world = ? AND email = ?", name, email).first<{
				role: Role;
			}>(),
		async worlds(userId: string, email: string) {
			return (
				await query(
					"SELECT w.name, m.role, w.owner_id = ? AS owner, w.game_mode AS gameMode, " +
						"w.game_mode_revision AS gameModeRevision FROM world w " +
						"JOIN world_member m ON w.name = m.world WHERE m.email = ? ORDER BY w.name",
					userId,
					email,
				).all<{ name: string; role: Role; owner: number; gameMode: GameMode; gameModeRevision: number }>()
			).results.map(row => ({ ...row, owner: !!row.owner, gameModeRevision: Number(row.gameModeRevision) }));
		},
		async createWorld(
			name: string,
			userId: string,
			email: string,
			gameMode: GameMode = "creative",
		): Promise<"created" | "exists" | "limit"> {
			// Conditional writes enforce the quota within the D1 batch transaction.
			// Revision 1 is newer than a WorldDO that has not stored one (0), so the
			// mode chosen at creation is applied on the first join. Migrated rows stay at 0.
			try {
				const results = await db.batch([
					query(
						"INSERT INTO world(name, owner_id, created_at, game_mode, game_mode_revision) SELECT ?, ?, ?, ?, 1 " +
							"WHERE (SELECT count(*) FROM world WHERE owner_id = ?) < ?",
						name,
						userId,
						Date.now(),
						gameMode,
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
		async setWorldGameMode(name: string, gameMode: GameMode): Promise<number> {
			const row = await query(
				"UPDATE world SET game_mode = ?, game_mode_revision = game_mode_revision + 1 " +
					"WHERE name = ? RETURNING game_mode_revision AS gameModeRevision",
				gameMode,
				name,
			).first<{ gameModeRevision: number }>();
			const revision = Number(row?.gameModeRevision);
			if (!Number.isSafeInteger(revision)) throw new Error("game mode revision update failed");
			return revision;
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
