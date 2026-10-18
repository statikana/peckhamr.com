DROP TABLE IF EXISTS CosmoUsers;
CREATE TABLE IF NOT EXISTS CosmoUsers (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    name TEXT
);

INSERT INTO CosmoUsers(email, name) VALUES ("ryanoc102@gmail.com", "Ryan");