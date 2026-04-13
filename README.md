# ⚡️ Flow Tracker

<p align="center">
  <strong>Privacy-first, zero-effort desktop time tracking.</strong><br />
  Built with memory-safe <b>Rust</b> (Tauri) and modern <b>React/TypeScript</b>.
</p>

<p align="center">
  <a href="https://github.com/carmelodiventi/FlowTracker/releases">
    <img src="https://img.shields.io/github/v/release/carmelodiventi/FlowTracker?style=flat-square&color=58a6ff" alt="Latest Release">
  </a>
  <a href="https://github.com/carmelodiventi/FlowTracker/releases">
    <img src="https://img.shields.io/github/downloads/carmelodiventi/FlowTracker/total?style=flat-square&color=67df70" alt="Total Downloads">
  </a>
  <img src="https://img.shields.io/badge/license-MIT-transparent?style=flat-square" alt="License">
</p>

---

**Flow Tracker** automatically records time on the apps you choose, stores data locally in SQLite, and helps you review your day without the friction of manual start/stop timers.

## 🚀 Status: Beta

The app is usable, but features and UX may change quickly. Occasional bugs are expected and bug reports are highly appreciated.

## 📦 Download

Prebuilt binaries are published on the [GitHub Releases](https://github.com/carmelodiventi/FlowTracker/releases) page:

1. Open the **Latest Release**.
2. Download the installer for your OS (`.dmg` for macOS, `.msi` or `.exe` for Windows).
3. Install and run.

---

## ✨ Why Flow Tracker?

- **Zero-effort**: Passive tracking based on active window focus.
- **Whitelist-based**: Monitor only the apps you care about (e.g., VS Code, Figma).
- **Local-First**: Data is stored locally in a SQLite database for fast, private access.
- **Portable Backups**: Export/import your data as JSON to move between machines.
- **Lightweight**: Built on Tauri for a minimal memory footprint (< 50MB RAM).

## 📸 Screenshots

![Dashboard](docs/screenshots/dashboard.png)

<p align="center"><i>Main dashboard with automatic timeline tracking</i></p>

---

## 🛠 Development & Structure

**Desktop App**: Core application logic and desktop packaging (Tauri v2).

### Prerequisites

- **Node.js 20+** & **pnpm 9+**
- **Rust** (stable toolchain)
- [Tauri prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites) for your specific OS.

### Local Setup (Landing Page)

```bash
pnpm install
pnpm dev
```

### Local Setup (Desktop App)

```bash
# Navigate to the app directory (if separate) and run Tauri dev
pnpm tauri dev
```

---

## 🍎 macOS Permissions (Important)

On macOS, window title tracking requires **Accessibility** permissions:

`System Settings -> Privacy & Security -> Accessibility -> Flow Tracker`

_Without this permission, the app can see process names but window titles (like document names or browser tabs) will remain hidden._

## 🔒 Privacy & Data Ownership

- **Local Storage**: Activity data is stored on your machine in SQLite.
- **User Control**: No third-party tracking or mandatory cloud service.
- **Backup Portability**: Export/import JSON backups whenever you want.
- **Open Source**: Audit the code yourself to see exactly how your data is handled.

---

## 🗺 Roadmap

- [ ] Smart Idle Detection.
- [ ] Timeline editing and manual adjustments.
- [ ] Weekly summary reports (optional/premium).
- [ ] Direct export to Notion, Linear, and Jira.

## 🤝 Contributing

Issues and Pull Requests are welcome. When reporting bugs, please include your OS version and steps to reproduce the issue.

### Pull Request Flow

1. Fork the repository.
2. Create a feature branch from `main`.
3. Make your changes and test locally.
4. Push your branch to your fork.
5. Open a Pull Request against `main` with a clear description of the change.

Suggested branch naming:

- `feat/short-description`
- `fix/short-description`
- `docs/short-description`

### Release Process

Releases are automated by GitHub Actions in `.github/workflows/release.yml`.

To publish a new app release:

1. Update the app version where needed.
2. Commit and push the version changes to `main`.
3. Create an annotated tag matching the version, for example `v0.1.4`.
4. Push the tag to GitHub.
5. GitHub Actions builds the app and creates the GitHub Release for that tag automatically.

Example:

```bash
git checkout main
git pull origin main
git tag -a v0.1.4 -m "Flow Tracker v0.1.4"
git push origin v0.1.4
```

You do not need to manually create the GitHub Release first. Pushing the tag is the trigger.

---

<p align="center">
 Built with ❤️ by makers tired of tracking time manually
</p>
