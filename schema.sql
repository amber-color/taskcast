CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE,
    password   TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id             TEXT    NOT NULL,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date           TEXT    NOT NULL,
    title          TEXT    NOT NULL DEFAULT '',
    memo           TEXT    NOT NULL DEFAULT '',
    url            TEXT    NOT NULL DEFAULT '',
    done           INTEGER NOT NULL DEFAULT 0,
    color          TEXT    NOT NULL DEFAULT '#B2DFDB',
    estimate       INTEGER NOT NULL DEFAULT 15,
    actual         INTEGER NOT NULL DEFAULT 0,
    task_order     INTEGER NOT NULL DEFAULT 0,
    start_time     INTEGER NOT NULL DEFAULT 0,
    repeat_days    TEXT    NOT NULL DEFAULT '[]',
    template_id    INTEGER DEFAULT NULL,
    scheduled_time TEXT    NOT NULL DEFAULT '',
    waiting        INTEGER NOT NULL DEFAULT 0,
    wait_until     TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, date);
CREATE INDEX IF NOT EXISTS idx_tasks_template_id ON tasks(template_id);
CREATE INDEX IF NOT EXISTS idx_repeat_templates_user_id ON repeat_templates(user_id);

CREATE TABLE IF NOT EXISTS repeat_templates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title            TEXT    NOT NULL DEFAULT '',
    memo             TEXT    NOT NULL DEFAULT '',
    url              TEXT    NOT NULL DEFAULT '',
    color            TEXT    NOT NULL DEFAULT '#B2DFDB',
    estimate         INTEGER NOT NULL DEFAULT 15,
    fixed_start_time TEXT    NOT NULL DEFAULT '',
    rule             TEXT    NOT NULL DEFAULT '{}',
    skipped_dates    TEXT    NOT NULL DEFAULT '[]',
    generated_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT    NOT NULL,
    value   TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, key)
);
