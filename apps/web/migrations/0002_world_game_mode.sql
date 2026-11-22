ALTER TABLE world ADD COLUMN game_mode TEXT NOT NULL DEFAULT 'creative'
	CHECK (game_mode IN ('creative', 'survival'));
