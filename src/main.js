/* ══════════════════════════════════════════════════════════════════════════
   GOOGLE CLASSROOM SYNC - OBSIDIAN PLUGIN (v1.2.0 LUXURY CYBER EDITION)
   Created by Nelxson2099
   - Official Google Classroom API Integration via OAuth 2.0 Desktop
   - Syncs active courses, assignments, due dates, and submissions
   - Hide / Unhide courses feature with automatic cleanup
   - Truncated & responsive course badges
   - Sticky high-contrast luxury cyber header
   ══════════════════════════════════════════════════════════════════════════ */

'use strict';

const obsidian = require('obsidian');
const http = require('http');
const https = require('https');
const url = require('url');

const VIEW_TYPE_CLASSROOM = 'google-classroom-sync-view';
const OAUTH_PORT = 42813;
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/callback`;

const DEFAULT_SETTINGS = {
  clientId: '',
  clientSecret: '',
  tokens: null,
  userProfile: null,
  courses: [],
  assignments: [],
  hiddenCourses: [],
  lastSync: null,
  syncFolder: 'Classroom',
  autoCreateNotes: true
};

// ─── RESILIENT HTTP REQUEST HELPER ───
async function apiRequest(reqOptions) {
  if (typeof obsidian.requestUrl === 'function') {
    try {
      const res = await obsidian.requestUrl({
        url: reqOptions.url,
        method: reqOptions.method || 'GET',
        headers: reqOptions.headers || {},
        contentType: reqOptions.contentType,
        body: reqOptions.body
      });
      return res.json || res.text;
    } catch (e) {
      console.warn('obsidian.requestUrl error, falling back to Node https:', e);
      if (e.status) throw e;
    }
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(reqOptions.url);
    const postData = reqOptions.body;
    const headers = Object.assign({}, reqOptions.headers || {});

    if (postData) {
      headers['Content-Length'] = Buffer.byteLength(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }

    const req = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: reqOptions.method || 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject({ status: res.statusCode, error: json });
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject({ status: res.statusCode, raw: data });
          }
        }
      });
    });

    req.on('error', err => reject(err));

    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

function sanitizeFileName(name) {
  return (name || 'Sin Titulo').replace(/[/\\?%*:|"<>]/g, '-').trim();
}

function formatDueDate(dueDate, dueTime) {
  if (!dueDate || !dueDate.year) return null;
  const y = dueDate.year;
  const m = String(dueDate.month).padStart(2, '0');
  const d = String(dueDate.day).padStart(2, '0');
  let timeStr = '23:59';
  if (dueTime && typeof dueTime.hours !== 'undefined') {
    const hh = String(dueTime.hours).padStart(2, '0');
    const mm = String(dueTime.minutes || 0).padStart(2, '0');
    timeStr = `${hh}:${mm}`;
  }
  return {
    dateStr: `${y}-${m}-${d}`,
    timeStr,
    iso: new Date(`${y}-${m}-${d}T${timeStr}:00`)
  };
}

function getUrgencyBadge(dueDateObj) {
  if (!dueDateObj || !dueDateObj.iso) {
    return { text: 'Sin fecha límite', cls: '', daysDiff: 999 };
  }
  const now = new Date();
  const diffMs = dueDateObj.iso.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffMs < 0) {
    return { text: 'Vencida', cls: 'due-today', daysDiff: diffDays };
  }
  if (diffDays === 0) {
    return { text: '¡Vence Hoy!', cls: 'due-today', daysDiff: 0 };
  }
  if (diffDays === 1) {
    return { text: 'Vence Mañana', cls: 'due-soon', daysDiff: 1 };
  }
  if (diffDays <= 7) {
    return { text: `Faltan ${diffDays} días`, cls: 'due-soon', daysDiff: diffDays };
  }
  return { text: `${dueDateObj.dateStr}`, cls: '', daysDiff: diffDays };
}

// ─── PLUGIN CLASS ──────────────────────────────────────────────────────────
class GoogleClassroomPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    this.oauthServer = null;

    this.registerView(
      VIEW_TYPE_CLASSROOM,
      (leaf) => new GoogleClassroomView(leaf, this)
    );

    this.addRibbonIcon('graduation-cap', 'Google Classroom Sync', () => {
      this.activateView();
    });

    this.addCommand({
      id: 'open-dashboard',
      name: 'Open Dashboard (Abrir Dashboard)',
      callback: () => this.activateView()
    });

    this.addCommand({
      id: 'sync-now',
      name: 'Sync Classroom Now (Sincronizar Cursos y Tareas)',
      callback: () => this.syncAll(true)
    });

    this.addSettingTab(new GoogleClassroomSettingTab(this.app, this));
    console.log('Google Classroom Sync Plugin v1.2.0 listo');
  }

  onunload() {
    this.stopOAuthServer();
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.data = Object.assign({}, DEFAULT_SETTINGS, loaded);
    if (!Array.isArray(this.data.hiddenCourses)) {
      this.data.hiddenCourses = [];
    }
  }

  async saveSettings() {
    await this.saveData(this.data);
  }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_CLASSROOM).forEach(leaf => {
      if (leaf.view && typeof leaf.view.render === 'function') {
        leaf.view.render();
      }
    });
  }

  getActiveCourses() {
    const hidden = new Set(this.data.hiddenCourses || []);
    return (this.data.courses || []).filter(c => !hidden.has(c.id));
  }

  getHiddenCourses() {
    const hidden = new Set(this.data.hiddenCourses || []);
    return (this.data.courses || []).filter(c => hidden.has(c.id));
  }

  getActiveAssignments() {
    const hidden = new Set(this.data.hiddenCourses || []);
    return (this.data.assignments || []).filter(a => !hidden.has(a.courseId));
  }

  async toggleHideCourse(courseId) {
    if (!this.data.hiddenCourses) this.data.hiddenCourses = [];
    const idx = this.data.hiddenCourses.indexOf(courseId);
    const course = (this.data.courses || []).find(c => c.id === courseId);
    const name = course ? course.name : 'Materia';

    if (idx >= 0) {
      this.data.hiddenCourses.splice(idx, 1);
      new obsidian.Notice(`👁️ "${name}" restaurada a las materias activas.`);
    } else {
      this.data.hiddenCourses.push(courseId);
      new obsidian.Notice(`👁️ "${name}" ocultada. Puedes verla en el filtro "Ocultas".`);
    }

    await this.saveSettings();
    this.refreshViews();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_CLASSROOM);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_CLASSROOM, active: true });
    }

    workspace.revealLeaf(leaf);
  }

  // ─── AUTHENTICATION FLOW ───
  getAuthUrl() {
    const scopes = [
      'https://www.googleapis.com/auth/classroom.courses.readonly',
      'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
      'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly',
      'https://www.googleapis.com/auth/classroom.announcements.readonly',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ].join(' ');

    const params = new URLSearchParams({
      client_id: this.data.clientId.trim(),
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: scopes,
      access_type: 'offline',
      prompt: 'consent'
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  startOAuthLogin(onSuccess, onError) {
    this.stopOAuthServer();

    try {
      this.oauthServer = http.createServer(async (req, res) => {
        try {
          const reqUrl = url.parse(req.url, true);
          if (reqUrl.pathname === '/callback') {
            const authCode = reqUrl.query.code;
            const errorParam = reqUrl.query.error;

            if (errorParam) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(`
                <html><body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                  <div style="text-align:center;padding:2rem;background:#1e293b;border:1px solid #ef4444;border-radius:16px;">
                    <h2 style="color:#ef4444;">❌ Error de Autorización</h2>
                    <p style="color:#94a3b8;">${errorParam}</p>
                  </div>
                </body></html>
              `);
              this.stopOAuthServer();
              if (onError) onError(new Error(errorParam));
              return;
            }

            if (authCode) {
              try {
                await this.exchangeCodeForTokens(authCode);

                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`
                  <html><body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                    <div style="text-align:center;padding:2.5rem 3rem;background:#1e293b;border:1px solid #10b981;border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,0.5);">
                      <div style="font-size:3rem;margin-bottom:1rem;">🎉</div>
                      <h2 style="color:#10b981;margin-bottom:0.5rem;">¡Conexión Exitosa con Google Classroom!</h2>
                      <p style="color:#94a3b8;font-size:1.05rem;">Tu cuenta ha sido vinculada correctamente con Obsidian.</p>
                      <p style="color:#64748b;font-size:0.9rem;margin-top:1.5rem;">Ya puedes cerrar esta pestaña del navegador y regresar a Obsidian.</p>
                    </div>
                  </body></html>
                `);

                this.stopOAuthServer();
                if (onSuccess) onSuccess();

              } catch (exchangeErr) {
                console.error('Error exchanging code for tokens:', exchangeErr);
                const errMsg = exchangeErr.error ? (exchangeErr.error.error_description || exchangeErr.error.error || JSON.stringify(exchangeErr.error)) : (exchangeErr.message || 'Error desconocido');
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`
                  <html><body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                    <div style="text-align:center;padding:2.5rem 3rem;background:#1e293b;border:1px solid #ef4444;border-radius:18px;">
                      <div style="font-size:3rem;margin-bottom:1rem;">❌</div>
                      <h2 style="color:#ef4444;margin-bottom:0.5rem;">Error al vincular con Google</h2>
                      <p style="color:#fca5a5;font-size:1rem;">${errMsg}</p>
                    </div>
                  </body></html>
                `);
                this.stopOAuthServer();
                if (onError) onError(exchangeErr);
              }
            }
          }
        } catch (err) {
          console.error('Error in OAuth callback:', err);
          if (onError) onError(err);
        }
      });

      this.oauthServer.listen(OAUTH_PORT, '127.0.0.1', () => {
        const authUrl = this.getAuthUrl();
        window.open(authUrl);
        new obsidian.Notice('🌐 Abriendo navegador para conectar con Google Classroom...');
      });

      this.oauthServer.on('error', (err) => {
        console.error('OAuth Server Error:', err);
        new obsidian.Notice('Error iniciando el servidor local de autenticación.');
        if (onError) onError(err);
      });

    } catch (e) {
      if (onError) onError(e);
    }
  }

  stopOAuthServer() {
    if (this.oauthServer) {
      try {
        this.oauthServer.close();
      } catch (e) {}
      this.oauthServer = null;
    }
  }

  async exchangeCodeForTokens(code) {
    const postBody = new URLSearchParams({
      code,
      client_id: this.data.clientId.trim(),
      client_secret: this.data.clientSecret.trim(),
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    }).toString();

    try {
      const resp = await apiRequest({
        url: 'https://oauth2.googleapis.com/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: postBody
      });

      this.data.tokens = {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token || (this.data.tokens ? this.data.tokens.refresh_token : null),
        expires_at: Date.now() + (resp.expires_in * 1000)
      };

      await this.saveSettings();
      await this.fetchUserProfile();
      await this.syncAll(true);
      new obsidian.Notice('🎉 ¡Google Classroom conectado y sincronizado con éxito!');
      this.refreshViews();

    } catch (err) {
      console.error('Error exchanging tokens:', err);
      new obsidian.Notice('Error obteniendo tokens de Google.');
      throw err;
    }
  }

  async getValidAccessToken() {
    if (!this.data.tokens || !this.data.tokens.access_token) return null;

    if (Date.now() > this.data.tokens.expires_at - 60000 && this.data.tokens.refresh_token) {
      try {
        const postBody = new URLSearchParams({
          client_id: this.data.clientId.trim(),
          client_secret: this.data.clientSecret.trim(),
          refresh_token: this.data.tokens.refresh_token,
          grant_type: 'refresh_token'
        }).toString();

        const resp = await apiRequest({
          url: 'https://oauth2.googleapis.com/token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: postBody
        });

        this.data.tokens.access_token = resp.access_token;
        this.data.tokens.expires_at = Date.now() + (resp.expires_in * 1000);
        await this.saveSettings();
      } catch (err) {
        console.error('Error refreshing token:', err);
        return null;
      }
    }

    return this.data.tokens.access_token;
  }

  async fetchUserProfile() {
    const token = await this.getValidAccessToken();
    if (!token) return;

    try {
      const profile = await apiRequest({
        url: 'https://www.googleapis.com/oauth2/v2/userinfo',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      this.data.userProfile = profile;
      await this.saveSettings();
    } catch (e) {
      console.warn('Could not fetch user profile:', e);
    }
  }

  logout() {
    this.data.tokens = null;
    this.data.userProfile = null;
    this.data.courses = [];
    this.data.assignments = [];
    this.data.hiddenCourses = [];
    this.saveSettings();
    new obsidian.Notice('Sesión de Google Classroom cerrada.');
  }

  // ─── CLASSROOM DATA SYNC ───
  async syncAll(showNotice = false) {
    const token = await this.getValidAccessToken();
    if (!token) {
      if (showNotice) new obsidian.Notice('Debes conectar tu cuenta de Google Classroom primero.');
      return;
    }

    if (showNotice) new obsidian.Notice('🔄 Sincronizando materias y tareas de Google Classroom...');

    try {
      const coursesResp = await apiRequest({
        url: 'https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const courses = coursesResp.courses || [];
      const assignments = [];

      for (const course of courses) {
        try {
          const cwResp = await apiRequest({
            url: `https://classroom.googleapis.com/v1/courses/${course.id}/courseWork?courseWorkStates=PUBLISHED`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
          });

          const works = cwResp.courseWork || [];

          let submissionsMap = {};
          try {
            const subResp = await apiRequest({
              url: `https://classroom.googleapis.com/v1/courses/${course.id}/courseWork/-/studentSubmissions`,
              method: 'GET',
              headers: { 'Authorization': `Bearer ${token}` }
            });
            (subResp.studentSubmissions || []).forEach(sub => {
              submissionsMap[sub.courseWorkId] = sub.state;
            });
          } catch (subErr) {}

          works.forEach(work => {
            const dueObj = formatDueDate(work.dueDate, work.dueTime);
            assignments.push({
              id: work.id,
              courseId: course.id,
              courseName: course.name,
              courseSection: course.section || '',
              title: work.title,
              description: work.description || '',
              alternateLink: work.alternateLink,
              maxPoints: work.maxPoints || 0,
              dueDate: dueObj ? dueObj.dateStr : null,
              dueTime: dueObj ? dueObj.timeStr : null,
              dueIso: dueObj ? dueObj.iso.toISOString() : null,
              submissionState: submissionsMap[work.id] || 'PENDIENTE',
              updatedTime: work.updateTime || work.creationTime
            });
          });
        } catch (cwErr) {
          console.warn(`Error fetching coursework for course ${course.name}:`, cwErr);
        }
      }

      this.data.courses = courses;
      this.data.assignments = assignments;
      this.data.lastSync = new Date().toISOString();

      // Clean up hidden courses if teacher deleted or archived them
      const activeCourseIds = new Set(courses.map(c => c.id));
      if (this.data.hiddenCourses) {
        this.data.hiddenCourses = this.data.hiddenCourses.filter(id => activeCourseIds.has(id));
      }

      await this.saveSettings();

      if (this.data.autoCreateNotes) {
        await this.syncMarkdownNotes();
      }

      if (showNotice) {
        new obsidian.Notice(`✅ Sincronizado: ${courses.length} materias, ${assignments.length} tareas.`);
      }

      this.refreshViews();

    } catch (err) {
      console.error('Error syncing Classroom data:', err);
      if (showNotice) new obsidian.Notice('Error al sincronizar con Google Classroom.');
    }
  }

  async syncMarkdownNotes() {
    const { vault } = this.app;
    const baseFolder = this.data.syncFolder || 'Classroom';

    if (!await vault.adapter.exists(baseFolder)) {
      await vault.createFolder(baseFolder);
    }

    // Only create notes for active (non-hidden) courses
    const activeCourses = this.getActiveCourses();
    const activeAssignments = this.getActiveAssignments();

    const pendingList = activeAssignments.filter(a => a.submissionState !== 'TURNED_IN' && a.submissionState !== 'RETURNED');
    const completedList = activeAssignments.filter(a => a.submissionState === 'TURNED_IN' || a.submissionState === 'RETURNED');

    pendingList.sort((a, b) => {
      if (!a.dueIso) return 1;
      if (!b.dueIso) return -1;
      return new Date(a.dueIso) - new Date(b.dueIso);
    });

    let indexMd = `---\ntype: classroom-overview\nlast_sync: "${new Date().toLocaleString()}"\ntotal_courses: ${activeCourses.length}\npending_tasks: ${pendingList.length}\n---\n\n`;
    indexMd += `# 🎓 Google Classroom - Tablero de Tareas\n\n`;
    indexMd += `> [!INFO] Sincronización Automática\n> **Última actualización:** ${new Date().toLocaleString()}\n> **Materias activas:** ${activeCourses.length} | **Tareas pendientes:** ${pendingList.length}\n\n`;

    indexMd += `## 🚨 Tareas Pendientes\n\n`;
    if (pendingList.length === 0) {
      indexMd += `*¡Felicidades! No tienes tareas pendientes en Google Classroom.* 🎉\n\n`;
    } else {
      pendingList.forEach(t => {
        const dueText = t.dueDate ? `📅 ${t.dueDate} ${t.dueTime || ''}` : '📅 Sin fecha límite';
        const courseSan = sanitizeFileName(t.courseName);
        const taskSan = sanitizeFileName(t.title);
        const noteLink = `[[${baseFolder}/${courseSan}/${taskSan}|${t.title}]]`;
        indexMd += `- [ ] ${noteLink} — **${t.courseName}** (${dueText}) [🔗 Classroom](${t.alternateLink})\n`;
      });
      indexMd += '\n';
    }

    if (completedList.length > 0) {
      indexMd += `## ✅ Tareas Completadas / Entregadas\n\n`;
      completedList.forEach(t => {
        const courseSan = sanitizeFileName(t.courseName);
        const taskSan = sanitizeFileName(t.title);
        const noteLink = `[[${baseFolder}/${courseSan}/${taskSan}|${t.title}]]`;
        indexMd += `- [x] ${noteLink} — **${t.courseName}** [🔗 Ver](${t.alternateLink})\n`;
      });
      indexMd += '\n';
    }

    const indexPath = `${baseFolder}/00 - Tareas Pendientes.md`;
    if (await vault.adapter.exists(indexPath)) {
      const file = vault.getAbstractFileByPath(indexPath);
      if (file instanceof obsidian.TFile) await vault.modify(file, indexMd);
    } else {
      await vault.create(indexPath, indexMd);
    }

    for (const course of activeCourses) {
      const courseFolder = `${baseFolder}/${sanitizeFileName(course.name)}`;
      if (!await vault.adapter.exists(courseFolder)) {
        await vault.createFolder(courseFolder);
      }

      const courseTasks = activeAssignments.filter(a => a.courseId === course.id);
      for (const t of courseTasks) {
        const taskPath = `${courseFolder}/${sanitizeFileName(t.title)}.md`;
        const taskFrontmatter = [
          '---',
          'type: classroom-task',
          `course: "${t.courseName.replace(/"/g, '\\"')}"`,
          `course_id: "${t.courseId}"`,
          `task_id: "${t.id}"`,
          `due_date: "${t.dueDate || ''}"`,
          `due_time: "${t.dueTime || ''}"`,
          `status: "${t.submissionState}"`,
          `max_points: ${t.maxPoints}`,
          `link: "${t.alternateLink}"`,
          '---',
          ''
        ].join('\n');

        const taskBody = [
          `# ${t.title}`,
          '',
          '> [!NOTE] Detalles de la Tarea',
          `> **Materia:** ${t.courseName} ${t.courseSection ? '(' + t.courseSection.slice(0, 30) + ')' : ''}`,
          `> **Fecha Límite:** ${t.dueDate ? t.dueDate + ' ' + (t.dueTime || '') : 'Sin fecha límite'}`,
          `> **Puntuación:** ${t.maxPoints > 0 ? t.maxPoints + ' pts' : 'Sin calificar'}`,
          `> **Estado:** ${t.submissionState}`,
          `> **Enlace Oficial:** [${t.title}](${t.alternateLink})`,
          '',
          '## 📋 Instrucciones del Docente',
          '',
          t.description ? t.description : '*Sin descripción provista por el docente.*',
          '',
          '---',
          '',
          '## ✍️ Mis Notas y Apuntes de Entrega',
          '',
          '- [ ] Borrador preliminar',
          '- [ ] Revisión final',
          ''
        ].join('\n');

        const fullContent = taskFrontmatter + '\n' + taskBody;

        if (await vault.adapter.exists(taskPath)) {
          // Keep user notes
        } else {
          await vault.create(taskPath, fullContent);
        }
      }
    }
  }
}

// ─── CLASSROOM INTERACTIVE DASHBOARD VIEW ─────────────────────────────────
class GoogleClassroomView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeTab = 'courses';
    this.showHidden = false; // toggle for hidden courses
    this.searchQuery = '';
    this.filterCourse = 'ALL';
  }

  getViewType() {
    return VIEW_TYPE_CLASSROOM;
  }

  getDisplayText() {
    return 'Google Classroom';
  }

  getIcon() {
    return 'graduation-cap';
  }

  async onOpen() {
    this.render();
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('gc-container');

    const isConnected = Boolean(this.plugin.data.tokens && this.plugin.data.tokens.access_token);

    // ─── STICKY LUXURY HEADER ───
    const header = container.createEl('div', { cls: 'gc-header' });
    const brand = header.createEl('div', { cls: 'gc-brand' });
    brand.createEl('div', { cls: 'gc-brand-icon', text: '🎓' });
    const titleWrap = brand.createEl('div', { cls: 'gc-title-wrap' });
    titleWrap.createEl('h1', { text: 'Google Classroom Sync' });
    titleWrap.createEl('p', {
      cls: 'gc-subtitle',
      text: isConnected
        ? `Sincronización en vivo • Última actualización: ${this.plugin.data.lastSync ? new Date(this.plugin.data.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Nunca'}`
        : 'Conecta tu cuenta para sincronizar tareas y cursos'
    });

    const headerActions = header.createEl('div', { cls: 'gc-header-actions' });

    if (isConnected) {
      const userBadge = headerActions.createEl('div', { cls: 'gc-user-badge' });
      
      const userName = this.plugin.data.userProfile ? (this.plugin.data.userProfile.name || this.plugin.data.userProfile.email) : 'Nelson';
      const initial = userName.charAt(0).toUpperCase();

      userBadge.createEl('div', { cls: 'gc-user-avatar', text: initial });
      userBadge.createEl('div', { cls: 'gc-user-dot' });
      userBadge.createEl('span', { text: userName });

      const syncBtn = headerActions.createEl('button', {
        cls: 'gc-btn gc-btn-primary',
        text: '🔄 Sincronizar'
      });
      syncBtn.onclick = () => this.plugin.syncAll(true);
    } else {
      const loginBtn = headerActions.createEl('button', {
        cls: 'gc-btn gc-btn-google',
        text: '🔑 Conectar con Google'
      });
      loginBtn.onclick = () => {
        this.plugin.startOAuthLogin(() => this.render(), (err) => {
          new obsidian.Notice('Error al conectar: ' + err.message);
        });
      };
    }

    if (!isConnected) {
      this.renderOnboarding(container);
      return;
    }

    // ─── STATS BANNER ───
    this.renderStats(container);

    // ─── TABS WITH SEARCH ───
    const tabsWrapper = container.createEl('div', { cls: 'gc-tabs-wrapper' });
    const tabs = tabsWrapper.createEl('div', { cls: 'gc-tabs' });

    const activeCourses = this.plugin.getActiveCourses();
    const hiddenCourses = this.plugin.getHiddenCourses();
    const activeAssignments = this.plugin.getActiveAssignments();
    const pendingCount = activeAssignments.filter(a => a.submissionState !== 'TURNED_IN' && a.submissionState !== 'RETURNED').length;

    const tabCourses = tabs.createEl('button', {
      cls: `gc-tab-btn ${this.activeTab === 'courses' ? 'is-active' : ''}`,
      text: `📚 Materias (${activeCourses.length})`
    });
    tabCourses.onclick = () => { this.activeTab = 'courses'; this.render(); };

    const tabTasks = tabs.createEl('button', {
      cls: `gc-tab-btn ${this.activeTab === 'tasks' ? 'is-active' : ''}`,
      text: `📋 Tareas (${pendingCount})`
    });
    tabTasks.onclick = () => { this.activeTab = 'tasks'; this.render(); };

    const tabSettings = tabs.createEl('button', {
      cls: `gc-tab-btn ${this.activeTab === 'settings' ? 'is-active' : ''}`,
      text: '⚙️ Conexión'
    });
    tabSettings.onclick = () => { this.activeTab = 'settings'; this.render(); };

    // Search bar
    if (this.activeTab === 'courses' || this.activeTab === 'tasks') {
      const searchBox = tabsWrapper.createEl('div', { cls: 'gc-search-box' });
      searchBox.createEl('span', { text: '🔍' });
      const input = searchBox.createEl('input', {
        type: 'text',
        placeholder: this.activeTab === 'courses' ? 'Buscar materia...' : 'Buscar tarea...'
      });
      input.value = this.searchQuery;
      input.oninput = (e) => {
        this.searchQuery = e.target.value.toLowerCase().trim();
        this.renderTabContent(container);
      };
    }

    // Dynamic Tab Body
    this.contentContainer = container.createEl('div', { cls: 'gc-tab-body' });
    this.renderTabContent(container);
  }

  renderTabContent(container) {
    if (!this.contentContainer) return;
    this.contentContainer.empty();

    if (this.activeTab === 'courses') {
      this.renderCoursesTab(this.contentContainer);
    } else if (this.activeTab === 'tasks') {
      this.renderTasksTab(this.contentContainer);
    } else if (this.activeTab === 'settings') {
      this.renderSettingsTab(this.contentContainer);
    }
  }

  renderOnboarding(parent) {
    const banner = parent.createEl('div', { cls: 'gc-auth-banner' });
    banner.createEl('div', { cls: 'gc-auth-icon-big', text: '🎓' });
    banner.createEl('h2', { cls: 'gc-auth-title', text: 'Vincula tu Google Classroom' });
    banner.createEl('p', {
      cls: 'gc-auth-desc',
      text: 'Accede a todas tus tareas escolares, fechas de entrega y materias organizadas en tiempo real dentro de tu bóveda Obsidian.'
    });

    const features = banner.createEl('div', { cls: 'gc-auth-features' });
    features.createEl('span', { text: '✨ Sincronización oficial con Google Classroom API' });
    features.createEl('span', { text: '📝 Creación automática de notas Markdown por tarea' });
    features.createEl('span', { text: '⏰ Detección de urgencia (Vence hoy, mañana, esta semana)' });
    features.createEl('span', { text: '🔒 Conexión 100% privada almacenada localmente en tu PC' });

    const btn = banner.createEl('button', {
      cls: 'gc-btn gc-btn-google',
      text: '🚀 Conectar con Google Classroom Ahora'
    });
    btn.style.padding = '0.75rem 1.75rem';
    btn.style.fontSize = '1rem';

    btn.onclick = () => {
      this.plugin.startOAuthLogin(() => this.render(), (err) => {
        new obsidian.Notice('Error al conectar: ' + err.message);
      });
    };
  }

  renderStats(parent) {
    const statsGrid = parent.createEl('div', { cls: 'gc-stats-grid' });

    const activeCourses = this.plugin.getActiveCourses();
    const activeAssignments = this.plugin.getActiveAssignments();

    const pendingTasks = activeAssignments.filter(a => a.submissionState !== 'TURNED_IN' && a.submissionState !== 'RETURNED');
    const urgentTasks = pendingTasks.filter(a => {
      if (!a.dueDate) return false;
      const u = getUrgencyBadge({ iso: new Date(a.dueIso) });
      return u.daysDiff <= 2;
    });

    // 1. Materias Activas
    const stat1 = statsGrid.createEl('div', { cls: 'gc-stat-card' });
    stat1.style.setProperty('--stat-glow', '#10b981');
    stat1.style.setProperty('--stat-bg', 'rgba(16, 185, 129, 0.1)');
    stat1.createEl('div', { cls: 'gc-stat-icon', text: '📚' });
    const s1Text = stat1.createEl('div');
    s1Text.createEl('div', { cls: 'gc-stat-val', text: String(activeCourses.length) });
    s1Text.createEl('div', { cls: 'gc-stat-label', text: 'Materias Activas' });

    // 2. Tareas Pendientes
    const stat2 = statsGrid.createEl('div', { cls: 'gc-stat-card' });
    stat2.style.setProperty('--stat-glow', '#38bdf8');
    stat2.style.setProperty('--stat-bg', 'rgba(56, 189, 248, 0.1)');
    stat2.createEl('div', { cls: 'gc-stat-icon', text: '📝' });
    const s2Text = stat2.createEl('div');
    s2Text.createEl('div', { cls: 'gc-stat-val', text: String(pendingTasks.length) });
    s2Text.createEl('div', { cls: 'gc-stat-label', text: 'Tareas Pendientes' });

    // 3. Vencen Pronto
    const stat3 = statsGrid.createEl('div', { cls: 'gc-stat-card' });
    stat3.style.setProperty('--stat-glow', '#f59e0b');
    stat3.style.setProperty('--stat-bg', 'rgba(245, 158, 11, 0.1)');
    stat3.createEl('div', { cls: 'gc-stat-icon', text: '🔥' });
    const s3Text = stat3.createEl('div');
    s3Text.createEl('div', { cls: 'gc-stat-val', text: String(urgentTasks.length) });
    s3Text.createEl('div', { cls: 'gc-stat-label', text: 'Vencen Pronto' });

    // 4. Carpeta
    const stat4 = statsGrid.createEl('div', { cls: 'gc-stat-card' });
    stat4.style.setProperty('--stat-glow', '#a855f7');
    stat4.style.setProperty('--stat-bg', 'rgba(168, 85, 247, 0.1)');
    stat4.createEl('div', { cls: 'gc-stat-icon', text: '📁' });
    const s4Text = stat4.createEl('div');
    s4Text.createEl('div', { cls: 'gc-stat-val', text: this.plugin.data.syncFolder || 'Classroom' });
    s4Text.createEl('div', { cls: 'gc-stat-label', text: 'Carpeta en Bóveda' });
  }

  renderCoursesTab(parent) {
    const activeCourses = this.plugin.getActiveCourses();
    const hiddenCourses = this.plugin.getHiddenCourses();

    // Mode filter: Activas vs Ocultas
    const toolbar = parent.createEl('div', { cls: 'gc-toolbar' });
    const filterGroup = toolbar.createEl('div', { cls: 'gc-filter-group' });

    const activeChip = filterGroup.createEl('button', {
      cls: `gc-chip ${!this.showHidden ? 'is-active' : ''}`,
      text: `🟢 Activas (${activeCourses.length})`
    });
    activeChip.onclick = () => { this.showHidden = false; this.render(); };

    if (hiddenCourses.length > 0) {
      const hiddenChip = filterGroup.createEl('button', {
        cls: `gc-chip ${this.showHidden ? 'is-active' : ''}`,
        text: `👁️ Ocultas (${hiddenCourses.length})`
      });
      hiddenChip.onclick = () => { this.showHidden = true; this.render(); };
    }

    let coursesToDisplay = this.showHidden ? hiddenCourses : activeCourses;

    if (this.searchQuery) {
      coursesToDisplay = coursesToDisplay.filter(c => 
        (c.name && c.name.toLowerCase().includes(this.searchQuery)) ||
        (c.section && c.section.toLowerCase().includes(this.searchQuery))
      );
    }

    if (coursesToDisplay.length === 0) {
      const empty = parent.createEl('div', { cls: 'gc-empty-state' });
      empty.createEl('div', { cls: 'gc-empty-icon', text: this.showHidden ? '✨' : '🔍' });
      empty.createEl('p', {
        text: this.showHidden
          ? 'No tienes materias ocultas. Puedes ocultar cualquier materia tocando el botón "Ocultar".'
          : (this.searchQuery ? `No se encontraron materias con "${this.searchQuery}"` : 'No hay materias activas.')
      });
      return;
    }

    const grid = parent.createEl('div', { cls: 'gc-courses-grid' });

    const courseThemes = [
      {
        grad: 'linear-gradient(135deg, rgba(5, 150, 105, 0.9) 0%, rgba(16, 185, 129, 0.6) 60%, rgba(6, 78, 59, 0.95) 100%)',
        accent: '#10b981',
        glow: 'rgba(16, 185, 129, 0.25)'
      },
      {
        grad: 'linear-gradient(135deg, rgba(29, 78, 216, 0.9) 0%, rgba(59, 130, 246, 0.6) 60%, rgba(30, 27, 75, 0.95) 100%)',
        accent: '#3b82f6',
        glow: 'rgba(59, 130, 246, 0.25)'
      },
      {
        grad: 'linear-gradient(135deg, rgba(124, 58, 237, 0.9) 0%, rgba(139, 92, 246, 0.6) 60%, rgba(49, 16, 75, 0.95) 100%)',
        accent: '#8b5cf6',
        glow: 'rgba(139, 92, 246, 0.25)'
      },
      {
        grad: 'linear-gradient(135deg, rgba(217, 119, 6, 0.9) 0%, rgba(245, 158, 11, 0.6) 60%, rgba(69, 26, 3, 0.95) 100%)',
        accent: '#f59e0b',
        glow: 'rgba(245, 158, 11, 0.25)'
      },
      {
        grad: 'linear-gradient(135deg, rgba(219, 39, 119, 0.9) 0%, rgba(236, 72, 153, 0.6) 60%, rgba(80, 7, 36, 0.95) 100%)',
        accent: '#ec4899',
        glow: 'rgba(236, 72, 153, 0.25)'
      },
      {
        grad: 'linear-gradient(135deg, rgba(13, 148, 136, 0.9) 0%, rgba(20, 184, 166, 0.6) 60%, rgba(4, 47, 46, 0.95) 100%)',
        accent: '#14b8a6',
        glow: 'rgba(20, 184, 166, 0.25)'
      },
      {
        grad: 'linear-gradient(135deg, rgba(2, 132, 199, 0.9) 0%, rgba(6, 182, 212, 0.6) 60%, rgba(8, 47, 73, 0.95) 100%)',
        accent: '#06b6d4',
        glow: 'rgba(6, 182, 212, 0.25)'
      },
      {
        grad: 'linear-gradient(135deg, rgba(147, 51, 234, 0.9) 0%, rgba(192, 132, 252, 0.6) 60%, rgba(59, 7, 100, 0.95) 100%)',
        accent: '#c084fc',
        glow: 'rgba(192, 132, 252, 0.25)'
      }
    ];

    coursesToDisplay.forEach((c, idx) => {
      const theme = courseThemes[idx % courseThemes.length];
      const card = grid.createEl('div', {
        cls: `gc-course-card ${this.showHidden ? 'is-hidden-mode' : ''}`
      });
      card.style.setProperty('--course-accent', theme.accent);
      card.style.setProperty('--course-glow', theme.glow);

      const top = card.createEl('div', { cls: 'gc-course-top' });
      top.style.setProperty('--course-grad', theme.grad);

      // Hide / Unhide button
      const hideBtn = top.createEl('button', {
        cls: `gc-hide-course-btn ${this.showHidden ? 'is-unhide' : ''}`,
        text: this.showHidden ? '👁️ Restaurar' : '✕ Ocultar',
        title: this.showHidden ? 'Restaurar esta materia al panel activo' : 'Ocultar esta materia del panel principal y tareas'
      });
      hideBtn.onclick = (e) => {
        e.stopPropagation();
        this.plugin.toggleHideCourse(c.id);
      };

      // Clean section tag (safely truncated)
      let sectionText = c.section || c.room || '';
      if (sectionText) {
        let displaySection = sectionText;
        if (displaySection.length > 28) {
          displaySection = displaySection.slice(0, 26) + '...';
        }
        const tag = top.createEl('div', {
          cls: 'gc-course-section-tag',
          text: displaySection
        });
        if (sectionText.length > 28) {
          tag.setAttribute('title', sectionText);
        }
      }

      top.createEl('h3', { cls: 'gc-course-name', text: c.name });

      const body = card.createEl('div', { cls: 'gc-course-body' });

      const courseTasks = this.plugin.data.assignments.filter(a => a.courseId === c.id);
      const pendingCount = courseTasks.filter(a => a.submissionState !== 'TURNED_IN' && a.submissionState !== 'RETURNED').length;

      // Metrics Row
      const metricsRow = body.createEl('div', { cls: 'gc-course-metrics-row' });

      const m1 = metricsRow.createEl('div', { cls: 'gc-metric-box' });
      m1.createEl('div', { cls: 'gc-metric-val', text: String(courseTasks.length) });
      m1.createEl('div', { cls: 'gc-metric-label', text: 'Tareas Totales' });

      const m2 = metricsRow.createEl('div', { cls: 'gc-metric-box' });
      const val2 = m2.createEl('div', { cls: 'gc-metric-val', text: pendingCount > 0 ? `🔥 ${pendingCount}` : '✨ 0' });
      if (pendingCount > 0) val2.style.color = '#f59e0b';
      else val2.style.color = '#10b981';
      m2.createEl('div', { cls: 'gc-metric-label', text: pendingCount > 0 ? 'Pendientes' : 'Al Día' });

      // Actions Row
      const actions = card.createEl('div', { cls: 'gc-course-actions' });

      const viewTasksBtn = actions.createEl('button', {
        cls: 'gc-btn gc-btn-sm',
        text: '📋 Ver Tareas'
      });
      viewTasksBtn.onclick = () => {
        this.filterCourse = c.id;
        this.activeTab = 'tasks';
        this.render();
      };

      if (c.alternateLink) {
        const link = actions.createEl('a', {
          cls: 'gc-btn gc-btn-sm gc-btn-primary',
          text: '↗ Classroom',
          href: c.alternateLink
        });
        link.target = '_blank';
      }
    });
  }

  renderTasksTab(parent) {
    const activeCourses = this.plugin.getActiveCourses();
    const activeAssignments = this.plugin.getActiveAssignments();

    // Toolbar: Filter chips
    const toolbar = parent.createEl('div', { cls: 'gc-toolbar' });
    const filterGroup = toolbar.createEl('div', { cls: 'gc-filter-group' });

    const allChip = filterGroup.createEl('button', {
      cls: `gc-chip ${this.filterCourse === 'ALL' ? 'is-active' : ''}`,
      text: 'Todas'
    });
    allChip.onclick = () => { this.filterCourse = 'ALL'; this.render(); };

    activeCourses.forEach(c => {
      const chip = filterGroup.createEl('button', {
        cls: `gc-chip ${this.filterCourse === c.id ? 'is-active' : ''}`,
        text: c.name
      });
      chip.onclick = () => { this.filterCourse = c.id; this.render(); };
    });

    const list = parent.createEl('div', { cls: 'gc-assignments-list' });

    let tasks = activeAssignments;
    if (this.filterCourse !== 'ALL') {
      tasks = tasks.filter(t => t.courseId === this.filterCourse);
    }
    if (this.searchQuery) {
      tasks = tasks.filter(t => 
        (t.title && t.title.toLowerCase().includes(this.searchQuery)) ||
        (t.courseName && t.courseName.toLowerCase().includes(this.searchQuery))
      );
    }

    if (tasks.length === 0) {
      const empty = list.createEl('div', { cls: 'gc-empty-state' });
      empty.createEl('div', { cls: 'gc-empty-icon', text: '🎉' });
      empty.createEl('p', { text: '¡Excelente! No hay tareas pendientes en este filtro.' });
      return;
    }

    tasks.sort((a, b) => {
      const isDoneA = a.submissionState === 'TURNED_IN' || a.submissionState === 'RETURNED';
      const isDoneB = b.submissionState === 'TURNED_IN' || b.submissionState === 'RETURNED';
      if (isDoneA !== isDoneB) return isDoneA ? 1 : -1;
      if (!a.dueIso) return 1;
      if (!b.dueIso) return -1;
      return new Date(a.dueIso) - new Date(b.dueIso);
    });

    tasks.forEach(t => {
      const isDone = t.submissionState === 'TURNED_IN' || t.submissionState === 'RETURNED';
      const dueObj = t.dueIso ? { iso: new Date(t.dueIso), dateStr: t.dueDate } : null;
      const urgency = getUrgencyBadge(dueObj);
      const isUrgent = !isDone && urgency.daysDiff <= 2;

      const card = list.createEl('div', {
        cls: `gc-task-card ${isUrgent ? 'is-urgent' : ''} ${isDone ? 'is-done' : ''}`
      });

      const header = card.createEl('div', { cls: 'gc-task-header' });
      const titleArea = header.createEl('div', { cls: 'gc-task-title-area' });

      titleArea.createEl('div', {
        cls: 'gc-task-course-pill',
        text: t.courseName
      });

      titleArea.createEl('h3', { cls: 'gc-task-title', text: t.title });

      const meta = card.createEl('div', { cls: 'gc-task-meta' });

      if (t.dueDate) {
        meta.createEl('span', {
          cls: `gc-due-badge ${urgency.cls}`,
          text: `⏰ ${urgency.text} (${t.dueDate} ${t.dueTime || ''})`
        });
      } else {
        meta.createEl('span', {
          cls: 'gc-due-badge',
          text: '⏰ Sin fecha de entrega'
        });
      }

      if (t.maxPoints > 0) {
        meta.createEl('span', { text: `🎯 ${t.maxPoints} pts` });
      }

      const statusBadge = meta.createEl('span', {
        text: isDone ? '✅ Entregada' : '⏳ Pendiente'
      });
      statusBadge.style.color = isDone ? '#10b981' : '#f59e0b';
      statusBadge.style.fontWeight = '600';

      if (t.description) {
        card.createEl('div', {
          cls: 'gc-task-desc',
          text: t.description
        });
      }

      const actions = card.createEl('div', { cls: 'gc-task-actions' });

      const openNoteBtn = actions.createEl('button', {
        cls: 'gc-btn gc-btn-sm',
        text: '📄 Ver Nota en Obsidian'
      });
      openNoteBtn.onclick = async () => {
        const baseFolder = this.plugin.data.syncFolder || 'Classroom';
        const taskPath = `${baseFolder}/${sanitizeFileName(t.courseName)}/${sanitizeFileName(t.title)}.md`;
        const file = this.app.vault.getAbstractFileByPath(taskPath);
        if (file instanceof obsidian.TFile) {
          this.app.workspace.getLeaf(true).openFile(file);
        } else {
          new obsidian.Notice('La nota aún no ha sido creada. Pulsa Sincronizar.');
        }
      };

      if (t.alternateLink) {
        const extLink = actions.createEl('a', {
          cls: 'gc-btn gc-btn-sm gc-btn-primary',
          text: '🔗 Abrir en Classroom',
          href: t.alternateLink
        });
        extLink.target = '_blank';
      }
    });
  }

  renderSettingsTab(parent) {
    const wrap = parent.createEl('div');
    wrap.style.maxWidth = '640px';
    wrap.style.margin = '1rem auto';

    wrap.createEl('h2', { text: '⚙️ Conexión de Google Classroom' });

    const infoBox = wrap.createEl('div', {
      text: 'Tu conexión utiliza el protocolo oficial OAuth 2.0 Desktop de Google. Tus tokens se almacenan de manera local en tu máquina.'
    });
    infoBox.style.padding = '1.1rem';
    infoBox.style.borderRadius = '14px';
    infoBox.style.background = 'rgba(255,255,255,0.04)';
    infoBox.style.border = '1px solid rgba(255,255,255,0.08)';
    infoBox.style.marginBottom = '1.5rem';
    infoBox.style.fontSize = '0.86rem';
    infoBox.style.color = 'var(--text-muted)';

    if (this.plugin.data.userProfile) {
      const userBox = wrap.createEl('div');
      userBox.style.padding = '1.25rem';
      userBox.style.borderRadius = '16px';
      userBox.style.background = 'rgba(16, 185, 129, 0.08)';
      userBox.style.border = '1px solid rgba(16, 185, 129, 0.25)';
      userBox.style.marginBottom = '1.5rem';

      userBox.createEl('h3', { text: '👤 Cuenta Vinculada', attr: { style: 'margin:0 0 0.5rem 0; font-size:1.05rem; color:#10b981;' } });
      userBox.createEl('div', { text: `Nombre: ${this.plugin.data.userProfile.name || 'Usuario'}` });
      userBox.createEl('div', { text: `Correo: ${this.plugin.data.userProfile.email || 'N/A'}` });
    }

    const btnRow = wrap.createEl('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '1rem';

    const reconnectBtn = btnRow.createEl('button', {
      cls: 'gc-btn gc-btn-primary',
      text: '🔄 Reconectar / Cambiar Cuenta'
    });
    reconnectBtn.onclick = () => {
      this.plugin.startOAuthLogin(() => this.render(), (err) => {
        new obsidian.Notice('Error: ' + err.message);
      });
    };

    const logoutBtn = btnRow.createEl('button', {
      cls: 'gc-btn gc-btn-danger',
      text: '🚪 Cerrar Sesión'
    });
    logoutBtn.onclick = () => {
      this.plugin.logout();
      this.render();
    };
  }
}

// ─── PLUGIN SETTINGS TAB ──────────────────────────────────────────────────
class GoogleClassroomSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Configuración de Google Classroom Sync' });

    new obsidian.Setting(containerEl)
      .setName('Carpeta de Sincronización')
      .setDesc('Nombre de la carpeta en tu bóveda donde se guardarán las notas de tareas y materias.')
      .addText(text => text
        .setPlaceholder('Classroom')
        .setValue(this.plugin.data.syncFolder)
        .onChange(async (value) => {
          this.plugin.data.syncFolder = value.trim() || 'Classroom';
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Crear Notas Markdown Automáticas')
      .setDesc('Genera automáticamente notas individuales para cada tarea y un archivo maestro "00 - Tareas Pendientes.md".')
      .addToggle(toggle => toggle
        .setValue(this.plugin.data.autoCreateNotes)
        .onChange(async (value) => {
          this.plugin.data.autoCreateNotes = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Materias Ocultas')
      .setDesc(`Tienes ${(this.plugin.data.hiddenCourses || []).length} materias ocultas en tu panel.`)
      .addButton(btn => btn
        .setButtonText('Restaurar Todas las Materias')
        .onClick(async () => {
          this.plugin.data.hiddenCourses = [];
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
          this.display();
          new obsidian.Notice('Todas las materias han sido restauradas.');
        }));

    new obsidian.Setting(containerEl)
      .setName('ID de Cliente OAuth (Google Cloud)')
      .setDesc('El Client ID obtenido en Google Cloud Console.')
      .addText(text => text
        .setValue(this.plugin.data.clientId)
        .onChange(async (value) => {
          this.plugin.data.clientId = value.trim();
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Secreto de Cliente (Google Cloud)')
      .setDesc('El Client Secret obtenido en Google Cloud Console.')
      .addText(text => text
        .setValue(this.plugin.data.clientSecret)
        .onChange(async (value) => {
          this.plugin.data.clientSecret = value.trim();
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Estado de la Cuenta')
      .setDesc(this.plugin.data.tokens ? '🟢 Cuenta conectada y activa' : '⚪ Desconectada')
      .addButton(btn => btn
        .setButtonText(this.plugin.data.tokens ? 'Desconectar' : 'Conectar con Google')
        .onClick(() => {
          if (this.plugin.data.tokens) {
            this.plugin.logout();
            this.display();
          } else {
            this.plugin.startOAuthLogin(() => this.display());
          }
        }));
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────
module.exports = GoogleClassroomPlugin;
module.exports.default = GoogleClassroomPlugin;
