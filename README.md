# Flow Tracker

Privacy-first, zero-effort desktop time tracking built with Tauri (Rust + React/TypeScript).

Flow Tracker automatically records time on apps you choose, keeps data local, and helps you review your day without manual start/stop timers.

## Download

Prebuilt binaries are published on the GitHub Releases page:

- Open the latest release
- Download the installer for your OS
- Install and run

After publishing this repository, replace this placeholder with your real URL:

- https://github.com/OWNER/FlowTracker/releases

## Why Flow Tracker

- Zero-effort tracking based on active window focus
- Whitelist-based app monitoring
- Local-first data storage (privacy by default)
- Built for makers who switch context often

## Current Status

Flow Tracker is in active development.

- Core window tracking is implemented
- Whitelist/session workflow is in progress
- Aggregation and richer analytics are planned

## macOS Permission Required

On macOS, window title tracking requires Accessibility permission:

System Settings -> Privacy & Security -> Accessibility -> Flow Tracker

Without this permission, app names may still be visible but window titles can be empty.

## Privacy

Flow Tracker is local-first.

- No cloud sync by default
- No third-party telemetry by default
- No external server required for core tracking

## Development Setup

Prerequisites:

- Node.js 20+
- pnpm 9+
- Rust stable toolchain
- Tauri prerequisites for your OS

Install dependencies and run in development mode:

```bash
pnpm install
pnpm tauri dev
```

Build desktop bundles locally:

```bash
pnpm tauri build
```

## Repository Structure

- `src/` - React + TypeScript frontend
- `src-tauri/` - Rust backend and desktop packaging config
- `.github/workflows/` - CI/release automation

## Contributing

Issues and pull requests are welcome.

When reporting bugs, include:

- OS version
- Flow Tracker version
- Steps to reproduce
- Expected vs actual behavior

## Roadmap

- Session merge and idle logic improvements
- Timeline editing UX
- Better day/week summaries
- Optional premium features in the future
