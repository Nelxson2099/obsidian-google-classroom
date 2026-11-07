# Privacy Policy for Google Classroom Sync for Obsidian

*Last updated: November 2026*

**Google Classroom Sync** is an open-source community plugin developed by **Nelxson2099** for Obsidian (https://obsidian.md).

---

## 1. Local-First Data Philosophy & No Remote Storage
Google Classroom Sync operates entirely on a **local-first** architecture:
- All data retrieved from the Google Classroom API (courses, coursework, assignments, announcements, and submissions) is stored **exclusively on your local machine** within your Obsidian vault.
- **No external servers, databases, or intermediary proxies** are used. Your data never leaves your device and is never transmitted to the developer or any third party.

---

## 2. Google OAuth 2.0 & Token Security
- Authentication is performed directly between your browser and Google's official OAuth 2.0 servers (RFC 8252 Desktop standard).
- Your OAuth authorization tokens (`access_token` and `refresh_token`) are saved locally in your Obsidian vault's plugin directory (`data.json`).
- These tokens are used solely to fetch your own Classroom data and refresh your session.

---

## 3. Google API Services User Data Policy (Limited Use)
Google Classroom Sync's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements:
- Data accessed via Google Classroom APIs is used solely to provide and improve user-facing features (displaying courses, assignments, and generating local Markdown notes).
- We do not share, sell, or transfer your Google user data to third parties.
- We do not use Google user data for advertising, machine learning models, or analytics.

---

## 4. User Control & Data Deletion
You maintain full control of your data at all times:
- **Disconnect Account:** You can log out at any time from the plugin settings or the Classroom view in Obsidian, which immediately purges all saved tokens from your machine.
- **Revoke Access:** You can revoke the plugin's access to your Google account at any time via [Google Security Settings](https://myaccount.google.com/permissions).
- **Local Deletion:** Deleting the plugin or the generated `Classroom/` folder in your Obsidian vault completely removes all associated files.

---

## 5. Contact
If you have questions or concerns regarding this Privacy Policy, please open an issue on GitHub or contact the developer:
- **Repository:** https://github.com/Nelxson2099/obsidian-google-classroom
- **Email:** oficialnelxson@gmail.com
