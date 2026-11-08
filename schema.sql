DROP TABLE IF EXISTS CosmoUsers;
CREATE TABLE IF NOT EXISTS CosmoUsers (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    name TEXT
);

INSERT INTO CosmoUsers(email, name) VALUES ("ryanoc102@gmail.com", "Ryan");

-- Magic: The Gathering Commander Service Tables
CREATE TABLE IF NOT EXISTS MagicUsers (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    email TEXT DEFAULT '',
    username TEXT NOT NULL,
    avatar_url TEXT DEFAULT '',
    stats_json TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS MagicSessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS MagicDecks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    commanders_json TEXT NOT NULL,
    cards_json TEXT NOT NULL,
    color_identity TEXT NOT NULL,
    card_count INTEGER DEFAULT 100,
    is_legal INTEGER DEFAULT 1,
    validation_errors_json TEXT DEFAULT '[]',
    win_count INTEGER DEFAULT 0,
    play_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS MagicLobbies (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    is_private INTEGER DEFAULT 1,
    rules_json TEXT NOT NULL,
    seats_json TEXT NOT NULL,
    game_state_json TEXT DEFAULT '',
    version INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS MagicChatMessages (
    id TEXT PRIMARY KEY,
    lobby_code TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT DEFAULT '',
    seat_idx INTEGER DEFAULT -1,
    kind TEXT DEFAULT 'chat',
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
