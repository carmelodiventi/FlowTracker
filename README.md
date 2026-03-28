# ⏱ FlowTracker

> Privacy-first, zero-effort desktop time-tracking built with **Tauri 2** (Rust + React/TypeScript) and a **local SQLite** database.

---

## Architecture

```
FlowTracker/
├── src/                    # React + TypeScript frontend (Vite)
│   ├── main.tsx
│   ├── App.tsx
│   ├── App.css
│   └── index.css
├── src-tauri/              # Rust backend (Tauri 2)
│   ├── src/
│   │   ├── main.rs         # Binary entry-point
│   │   ├── lib.rs          # Tauri builder + plugin registration
│   │   └── watcher.rs      # Active-window poller (MVP 1)
│   ├── capabilities/
│   │   └── default.json    # Tauri 2 capability grants
│   ├── icons/              # App icons (replace placeholders before shipping)
│   ├── Cargo.toml
│   ├── build.rs
│   └── tauri.conf.json
├── bootstrap.sh            # One-shot scaffold script (run once)
├── package.json
├── vite.config.ts
├── tsconfig.json
└── index.html
```

---

## First-time setup

```bash
# 1. Scaffold directories and Rust/React source files
bash bootstrap.sh          # also runs `cargo check` at the end

# 2. Install JS dependencies
npm install

# 3. Launch dev mode (Vite + Tauri hot-reload)
npm run tauri dev
```

---

## MVP Milestones

| # | Status | Description |
|---|--------|-------------|
| 1 | ✅ **Done** | Rust `watcher.rs` — prints focused window name every 5 s |
| 2 | 🔜 Next | Tauri UI to manage app whitelist + SQLite session logging |
| 3 | 🔜 Future | Session aggregation, idle detection, daily summary dashboard |

---

## Database Schema (planned — MVP 2)

```sql
CREATE TABLE Applications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    process_name TEXT    NOT NULL UNIQUE,
    icon         BLOB,
    is_enabled   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE Sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id     INTEGER NOT NULL REFERENCES Applications(id),
    start_time TEXT    NOT NULL,   -- ISO-8601
    end_time   TEXT,
    duration   INTEGER,            -- seconds
    task_name  TEXT,
    status     TEXT    NOT NULL DEFAULT 'pending'
);

CREATE TABLE Settings (
    idle_timeout          INTEGER NOT NULL DEFAULT 300,   -- seconds
    auto_merge_threshold  INTEGER NOT NULL DEFAULT 120,   -- seconds
    theme                 TEXT    NOT NULL DEFAULT 'system'
);
```

---

## macOS — Accessibility Permission

`active-win-pos-rs` reads window titles via **CGWindowList / NSWorkspace**.  
On first launch you'll see a macOS permission dialog — click **Allow** in:

> System Settings → Privacy & Security → Accessibility → FlowTracker ✅

Without this, app names are returned but window titles may be blank.

---

## Key Rust crates

| Crate | Purpose |
|-------|---------|
| `tauri 2` | Desktop runtime, IPC, system tray |
| `active-win-pos-rs` | Cross-platform foreground window detection |
| `rusqlite` *(MVP 2)* | Local SQLite database |
| `serde / serde_json` | IPC serialisation |
| `env_logger / log` | Structured logging to terminal |

---

## Privacy guarantee

All data is stored in `~/.local/share/flowtracker/` (Linux/Windows) or  
`~/Library/Application Support/com.flowtracker.app/` (macOS).  
**No data is ever sent to an external server.**
