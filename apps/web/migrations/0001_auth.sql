-- Better Auth 1.7.21 の getMigrations の出力と同じ定義。
CREATE TABLE "user" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL,
  image TEXT,
  createdAt date NOT NULL,
  updatedAt date NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt date NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt date NOT NULL,
  updatedAt date NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX session_userId_idx ON session(userId);
CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt date,
  refreshTokenExpiresAt date,
  scope TEXT,
  password TEXT,
  createdAt date NOT NULL,
  updatedAt date NOT NULL
);
CREATE INDEX account_userId_idx ON account(userId);
CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt date NOT NULL,
  createdAt date NOT NULL,
  updatedAt date NOT NULL
);
CREATE INDEX verification_identifier_idx ON verification(identifier);
CREATE TABLE world (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX world_owner ON world(owner_id);
CREATE TABLE world_member (
  world TEXT NOT NULL REFERENCES world(name) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('operator', 'player')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (world, email)
) WITHOUT ROWID;
CREATE INDEX world_member_email ON world_member(email);
