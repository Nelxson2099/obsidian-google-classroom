# Google Classroom Sync for Obsidian

[![Obsidian Plugin](https://img.shields.io/badge/Obsidian-Plugin-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.2.0-10B981.svg)](https://github.com/Nelxson2099/obsidian-google-classroom/releases)

**Google Classroom Sync** brings your academic life directly into Obsidian. Connect your Google Classroom account to visualize courses, track upcoming assignments with smart urgency badges, and automatically generate structured Markdown study notes.

---

## ✨ Features

- 🎓 **Interactive Academic Dashboard**: View all enrolled courses, active announcements, and upcoming deadlines in a dedicated workspace tab.
- ⚡ **Official OAuth 2.0 Desktop Integration**: Secure local loopback authorization protocol. Your tokens and credentials stay 100% on your machine.
- ⏰ **Smart Urgency Badges**: Assignments are visually tagged with relative countdowns (*Due Today*, *Due Tomorrow*, *X days left*, or *Overdue*).
- 📝 **Automatic Markdown Note Creation**: Generates clean notes for each assignment with instructions, due dates, materials, and a checklist of deliverables.
- 📁 **Organized Folder Structure**: Groups course notes cleanly inside your designated vault folder (default: `Classroom/<Course Name>/`).
- 🙈 **Course Filtering**: Hide completed or archived subjects with one click.

---

## 🔑 Setup Guide (Google Cloud Credentials)

Google Classroom requires OAuth 2.0 access. To connect your account:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., `Obsidian Classroom`).
3. Under **APIs & Services** → **Library**, enable the **Google Classroom API**.
4. Under **APIs & Services** → **OAuth consent screen**, select **External**, fill in the app name, and add your email as a **Test User**.
5. Under **APIs & Services** → **Credentials**, click **Create Credentials** → **OAuth client ID**:
   - Application type: **Desktop app**.
   - Name: `Obsidian Classroom Sync`.
6. Copy your **Client ID** and **Client Secret**.
7. In Obsidian, go to **Settings** → **Google Classroom Sync**, paste both values, and click **Conectar con Google**.

---

## 🚀 Installation

### Option 1: Community Plugins (Recommended)
1. In Obsidian, open **Settings** → **Community Plugins**.
2. Click **Browse** and search for **Google Classroom Sync**.
3. Click **Install**, then **Enable**.

### Option 2: Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the [Latest Release](https://github.com/Nelxson2099/obsidian-google-classroom/releases).
2. Place them into `<vault>/.obsidian/plugins/google-classroom-sync/`.
3. Reload Obsidian and enable the plugin.

---

## ⌨️ Commands

| Command | Action |
|---|---|
| `Open Dashboard` | Opens the interactive Google Classroom dashboard. |
| `Sync Classroom Now` | Fetches the latest courses and assignments from Google. |

---

## 🛡️ Privacy & Security

Your data never leaves your device. This plugin connects directly between your local Obsidian vault and Google's official API servers using standard HTTPS. No third-party servers, no analytics, and zero tracking.

---

## 📄 License

Released under the [MIT License](LICENSE). Built with excellence by **[Nelxson2099](https://github.com/Nelxson2099)**.
