ALTER TABLE world ADD COLUMN game_mode TEXT NOT NULL DEFAULT 'creative'
	CHECK (game_mode IN ('creative', 'survival'));

ALTER TABLE world ADD COLUMN game_mode_revision INTEGER NOT NULL DEFAULT 0;
