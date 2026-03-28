#!/usr/bin/env bash
# =============================================================================
# FlowTracker — Project Bootstrap Script
# Run once from the repository root:  bash bootstrap.sh
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "📁  Creating directory structure..."
mkdir -p src
mkdir -p src-tauri/src
mkdir -p src-tauri/capabilities
mkdir -p src-tauri/icons

# -----------------------------------------------------------------------------
# FRONTEND — src/
# -----------------------------------------------------------------------------

cat > src/index.css << 'CSS_EOF'
:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;
  color-scheme: light dark;
  color: rgba(255, 255, 255, 0.87);
  background-color: #242424;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  margin: 0;
  display: flex;
  place-items: center;
  min-width: 320px;
  min-height: 100vh;
}

#root {
  max-width: 1280px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}
CSS_EOF

cat > src/App.css << 'CSS_EOF'
.container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
  padding: 2rem;
}

h1 {
  font-size: 2.5rem;
  font-weight: 700;
  margin: 0;
}

.subtitle {
  color: rgba(255, 255, 255, 0.6);
  font-size: 1rem;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  background: rgba(74, 222, 128, 0.15);
  border: 1px solid rgba(74, 222, 128, 0.4);
  color: #4ade80;
  padding: 0.4rem 1rem;
  border-radius: 999px;
  font-size: 0.875rem;
  font-weight: 500;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4ade80;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
CSS_EOF

cat > src/App.tsx << 'TSX_EOF'
import "./App.css";

function App() {
  return (
    <div className="container">
      <h1>⏱ FlowTracker</h1>
      <p className="subtitle">Privacy-first automatic time tracking</p>
      <span className="status-badge">
        <span className="dot" />
        Watcher running — check terminal for output
      </span>
      <p className="subtitle" style={{ fontSize: "0.8rem", marginTop: "1rem" }}>
        MVP 1 · Active window polling every 5 s
      </p>
    </div>
  );
}

export default App;
TSX_EOF

cat > src/main.tsx << 'TSX_EOF'
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
TSX_EOF

echo "✅  Frontend source files written."

# -----------------------------------------------------------------------------
# RUST BACKEND — src-tauri/
# -----------------------------------------------------------------------------

cat > src-tauri/build.rs << 'RUST_EOF'
fn main() {
    tauri_build::build()
}
RUST_EOF

cat > src-tauri/Cargo.toml << 'TOML_EOF'
[package]
name = "flow-tracker"
version = "0.1.0"
description = "FlowTracker — Privacy-first automatic time tracking"
authors = []
edition = "2021"
rust-version = "1.77"

# The _lib suffix makes the lib name unique from the bin name,
# avoiding a naming collision on Windows (cargo issue #8519).
[lib]
name = "flow_tracker_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri          = { version = "2", features = [] }
tauri-plugin-shell = "2"
serde          = { version = "1", features = ["derive"] }
serde_json     = "1"
active-win-pos-rs = "0.8"
log            = "0.4"
env_logger     = "0.11"

[profile.release]
opt-level  = "s"   # optimise for size
lto        = true
codegen-units = 1
panic      = "abort"
strip      = true
TOML_EOF

cat > src-tauri/tauri.conf.json << 'JSON_EOF'
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "FlowTracker",
  "version": "0.1.0",
  "identifier": "com.flowtracker.app",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "FlowTracker",
        "width": 1200,
        "height": 800,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
JSON_EOF

cat > src-tauri/capabilities/default.json << 'JSON_EOF'
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capabilities granted to the main FlowTracker window.",
  "windows": ["main"],
  "permissions": [
    "core:default"
  ]
}
JSON_EOF

# ---- Rust source files -------------------------------------------------------

cat > src-tauri/src/main.rs << 'RUST_EOF'
// Prevents an extra console window from opening on Windows in release mode.
// DO NOT REMOVE this attribute.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    flow_tracker_lib::run();
}
RUST_EOF

cat > src-tauri/src/lib.rs << 'RUST_EOF'
//! FlowTracker — Tauri application entry point.
//!
//! Responsibilities of this crate root:
//!   1. Start the background active-window watcher thread.
//!   2. Register Tauri plugins and IPC commands.
//!   3. Launch the Tauri runtime.

mod watcher;

/// Called by `main.rs` (and by the mobile entry-point shim when targeting iOS/Android).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialise env_logger so [FlowTracker] messages appear in the terminal.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // Kick off the background watcher before the Tauri event loop blocks.
    watcher::start_watcher();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
RUST_EOF

cat > src-tauri/src/watcher.rs << 'RUST_EOF'
//! Active-window watcher — MVP 1.
//!
//! Polls the OS for the foreground window every [`POLL_INTERVAL`] seconds and
//! prints the application name, window title, and process ID to stdout.
//!
//! The poll loop runs on a dedicated OS thread so it never blocks the Tauri /
//! WebView event loop.  All platform differences are handled by the
//! `active-win-pos-rs` crate (macOS via NSWorkspace / CGWindowList, Windows
//! via GetForegroundWindow + WinAPI).
//!
//! # macOS note
//! On macOS 10.15+ the app must be granted **Accessibility** (or Screen
//! Recording) permission the first time it runs.  Without it,
//! `get_active_window()` may return the app name but an empty title.

use active_win_pos_rs::get_active_window;
use std::thread;
use std::time::Duration;

/// How often to sample the foreground window.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Spawn the background watcher thread.
///
/// The thread runs until the process exits.  Panics only if the OS refuses to
/// create the thread, which is an unrecoverable condition.
pub fn start_watcher() {
    thread::Builder::new()
        .name("flow-watcher".into())
        .spawn(poll_loop)
        .expect("Failed to spawn flow-watcher thread");
}

/// Main body of the watcher thread — never returns under normal operation.
fn poll_loop() {
    println!(
        "[FlowTracker] Watcher started — sampling active window every {}s",
        POLL_INTERVAL.as_secs()
    );

    loop {
        report_active_window();
        thread::sleep(POLL_INTERVAL);
    }
}

/// Sample the active window once and print a structured log line.
fn report_active_window() {
    match get_active_window() {
        Ok(win) => {
            // Trim excessively long titles to keep output readable.
            let title = truncate(&win.title, 80);
            println!(
                "[FlowTracker] app={:?}  title={:?}  pid={}",
                win.app_name, title, win.process_id
            );
        }
        Err(_) => {
            // `get_active_window` returns `Err(())` when the desktop / screen
            // saver is in focus — not an error worth logging at WARNING level.
            println!("[FlowTracker] <no active window>");
        }
    }
}

/// Return a &str that is at most `max_chars` characters long.
fn truncate(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        None => s,
        Some((idx, _)) => &s[..idx],
    }
}

#[cfg(test)]
mod tests {
    use super::truncate;

    #[test]
    fn truncate_short_string_unchanged() {
        assert_eq!(truncate("hello", 80), "hello");
    }

    #[test]
    fn truncate_long_string_clipped() {
        let s = "a".repeat(100);
        assert_eq!(truncate(&s, 80).len(), 80);
    }

    #[test]
    fn truncate_exact_boundary() {
        let s = "x".repeat(80);
        assert_eq!(truncate(&s, 80), s.as_str());
    }
}
RUST_EOF

echo "✅  Rust source files written."

# -----------------------------------------------------------------------------
# Placeholder icons (cargo check doesn't need real PNGs, but tauri-build does)
# -----------------------------------------------------------------------------
# We create 1x1 px valid PNG files so tauri-build doesn't abort.
# Replace these with real icons before shipping.
MINIMAL_PNG="\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
for f in "icons/32x32.png" "icons/128x128.png" "icons/128x128@2x.png"; do
    printf '%b' "$MINIMAL_PNG" > "src-tauri/$f"
done
# .icns and .ico are not checked by `cargo check`, skip them for now.
touch src-tauri/icons/icon.icns
touch src-tauri/icons/icon.ico

echo "✅  Placeholder icons created."

# -----------------------------------------------------------------------------
# Verify Rust compilation
# -----------------------------------------------------------------------------
echo ""
echo "🔍  Running cargo check inside src-tauri/ ..."
echo "    (First run will download crates — this may take a minute)"
echo ""

cd src-tauri
cargo check 2>&1

echo ""
echo "🎉  Bootstrap complete!"
echo ""
echo "Next steps:"
echo "  cd $(dirname "$ROOT_DIR")/FlowTracker"
echo "  npm install          # install JS dependencies"
echo "  npm run tauri dev    # start dev mode (Vite + Tauri)"
