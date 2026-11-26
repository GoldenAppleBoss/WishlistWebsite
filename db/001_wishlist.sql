BEGIN;

CREATE TABLE IF NOT EXISTS accounts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  name_key text NOT NULL UNIQUE,
  salt text NOT NULL CHECK (length(salt) = 32),
  password_hash text NOT NULL CHECK (length(password_hash) = 64)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES accounts(id),
  expires bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires);

CREATE TABLE IF NOT EXISTS attempts (
  bucket text PRIMARY KEY,
  count integer NOT NULL,
  reset_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_expiry ON attempts (reset_at);

CREATE TABLE IF NOT EXISTS carts (
  user_id integer NOT NULL REFERENCES accounts(id),
  item_id text NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS carts_item ON carts (item_id);

CREATE TABLE IF NOT EXISTS cart_revision (
  id integer PRIMARY KEY CHECK (id = 1),
  instance uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO cart_revision (id) VALUES (1) ON CONFLICT DO NOTHING;

COMMIT;
