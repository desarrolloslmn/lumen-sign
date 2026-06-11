(() => {
  'use strict';

  const cfg = window.LUMEN_CONFIG || {};
  const requiredConfig = cfg.supabaseUrl && cfg.supabasePublishableKey && !cfg.supabaseUrl.includes('TU-PROYECTO');
  if (!requiredConfig) {
    document.body.innerHTML = `
      <main style="max-width:760px;margin:60px auto;padding:24px;font-family:system-ui">
        <h1>Falta configurar Supabase</h1>
        <p>Edita <code>config.js</code> y coloca la URL y la clave pública de tu proyecto.</p>
        <p>No uses una clave <code>secret</code> ni <code>service_role</code>.</p>
      </main>`;
    return;
  }

  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const MAX_FILE_MB = Number(cfg.maxFileMB || 6);
  const state = {
    session: null,
    profile: null,
    profiles: [],
    documents: [],
    tasks: [],
    signatures: [],
    appliedSignatures: [],
    activeDocumentId: null,
    flowDocumentId: null,
    signatureDrawing: false,
    profileDirty: false, loadedUserId: null, sessionLoadPromise: null,
    prepare: null, signing: null
  };

  const els = {};
  const byId = (id) => document.getElementById(id);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const isAdmin = () => ['superadmin', 'admin'].includes(state.profile?.role);
  const isContracts = () => state.profile?.role === 'contracts';
  const isActive = () => state.profile?.status === 'active';

  const roleLabels = {
    superadmin: 'Superadministrador', admin: 'Administrador', contracts: 'Contratos',
    approver: 'Aprobador', signer: 'Firmante', user: 'Usuario', auditor: 'Auditor'
  };
  const statusLabels = {
    pending: 'Pendiente', active: 'Activo', suspended: 'Suspendido',
    draft: 'Borrador', awaiting_approval: 'En aprobación', awaiting_signature: 'En firma',
    completed: 'Completado', rejected: 'Rechazado', cancelled: 'Cancelado',
    approved: 'Aprobado', signed: 'Firmado'
  };
  const participantRoleLabels = { editor: 'Editor', approver: 'Aprobador', signer: 'Firmante', viewer: 'Consulta' };

  function cacheElements() {
    [
      'auth-view','app-view','login-form','register-form','forgot-password','logout-button','admin-nav',
      'sidebar-user','user-status-pill','pending-banner','stats-grid','recent-documents','documents-table',
      'document-search','document-status-filter','new-document-form','participants-builder','add-participant',
      'tasks-table','profile-form','signature-canvas','clear-signature','save-signature','signature-list','signed-history-table',
      'admin-users-table','refresh-users','document-dialog','document-detail','flow-dialog','flow-builder',
      'flow-add-participant','save-flow','menu-button','main-nav','page-title','page-subtitle','toast',
      'prepare-dialog','prepare-save','prepare-save-submit','field-assignee','field-type','field-label','field-required','add-field',
      'selected-field-panel','selected-field-assignee','selected-field-type','selected-field-label','selected-field-required','delete-field',
      'prepare-pages','prepare-page-number','prepare-page-count','prepare-prev-page','prepare-next-page','prepare-zoom-in','prepare-zoom-out','prepare-zoom-label',
      'sign-dialog','sign-pages','finish-signing','sign-progress','next-required-field'
    ].forEach(id => els[id] = byId(id));
    byId('max-file-label').textContent = String(MAX_FILE_MB);
  }

  function toast(message, error = false) {
    els.toast.textContent = message;
    els.toast.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.className = 'toast', 3800);
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }

  function fmtDate(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  function fmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (!n) return '—';
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function pill(value) {
    const label = statusLabels[value] || value || '—';
    const cls = ['completed','approved','signed','active'].includes(value) ? 'success'
      : ['rejected','cancelled','suspended'].includes(value) ? 'danger'
      : ['pending','awaiting_approval','awaiting_signature'].includes(value) ? 'warning' : '';
    return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
  }

  function safeFilename(name) {
    return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 150);
  }

  async function sha256(input) {
    const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function run(task, successMessage = '') {
    try {
      setBusy(true);
      const result = await task();
      if (successMessage) toast(successMessage);
      return result;
    } catch (error) {
      console.error(error);
      toast(error?.message || 'Ocurrió un error.', true);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function setBusy(busy) {
    qsa('button').forEach(button => {
      if (button.dataset.keepEnabled === 'true') return;
      if (busy) {
        if (!('busyWasDisabled' in button.dataset)) button.dataset.busyWasDisabled = button.disabled ? '1' : '0';
        button.disabled = true;
      } else if ('busyWasDisabled' in button.dataset) {
        button.disabled = button.dataset.busyWasDisabled === '1';
        delete button.dataset.busyWasDisabled;
      }
    });
    document.body.style.cursor = busy ? 'progress' : '';
  }

  function showAuth() {
    els['auth-view'].classList.remove('hidden');
    els['app-view'].classList.add('hidden');
  }

  function showApp() {
    els['auth-view'].classList.add('hidden');
    els['app-view'].classList.remove('hidden');
  }

  function switchAuthTab(tab) {
    qsa('[data-auth-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.authTab === tab));
    els['login-form'].classList.toggle('hidden', tab !== 'login');
    els['register-form'].classList.toggle('hidden', tab !== 'register');
  }

  async function handleSession(session, force = false) {
    state.session = session;
    if (!session) {
      state.profile = null; state.loadedUserId = null; state.profiles = []; state.documents = [];
      state.tasks = []; state.signatures = []; state.appliedSignatures = []; showAuth(); return;
    }
    const userId = session.user.id;
    if (!force && state.loadedUserId === userId && state.profile) { showApp(); return; }
    if (state.sessionLoadPromise) return state.sessionLoadPromise;
    state.sessionLoadPromise = (async () => {
      await loadProfile(); showApp(); configureAppForProfile();
      await Promise.all([loadProfiles(), loadSignatures(), loadDocuments(), loadTasks(), loadAppliedSignatures()]);
      renderAll(); state.loadedUserId = userId;
    })();
    try { await state.sessionLoadPromise; } finally { state.sessionLoadPromise = null; }
  }


  async function loadProfile() {
    const { data, error } = await client.from('profiles').select('*').eq('id', state.session.user.id).single();
    if (error) throw error;
    state.profile = data;
  }

  async function loadProfiles() {
    const { data, error } = await client.from('profiles').select('id,email,full_name,department,role,status,created_at').order('full_name');
    if (error) throw error;
    state.profiles = data || [];
    refreshParticipantUserOptions();
  }


  function refreshParticipantUserOptions() {
    qsa('.participant-user').forEach(select => {
      const selected = select.value;
      select.innerHTML = `<option value="">Selecciona</option>${activeProfilesOptions(selected)}`;
      if (selected && state.profiles.some(p => p.id === selected && p.status === 'active')) select.value = selected;
    });
  }

  async function loadDocuments() {
    if (!isActive()) { state.documents = []; return; }
    const { data, error } = await client.from('documents').select('*').order('updated_at', { ascending: false });
    if (error) throw error;
    state.documents = data || [];
  }

  async function loadTasks() {
    if (!isActive()) { state.tasks = []; return; }
    const { data, error } = await client.from('document_participants')
      .select('id,document_id,participant_role,sequence,action_status,documents(id,title,status,category,updated_at)')
      .eq('user_id', state.session.user.id).eq('action_status', 'pending').in('participant_role', ['approver','signer']).order('sequence');
    if (error) throw error;
    state.tasks = (data || []).filter(item => item.documents);
  }

  async function loadSignatures() {
    const { data, error } = await client.from('user_signatures').select('*').is('revoked_at', null).order('created_at', { ascending: false });
    if (error) throw error;
    state.signatures = data || [];
  }

  async function loadAppliedSignatures() {
    if (!isActive()) { state.appliedSignatures = []; return; }
    const { data, error } = await client.from('document_signatures')
      .select('id,document_id,file_hash,signed_at,documents(id,title,status,category,active_file_name)')
      .eq('signer_id', state.session.user.id).order('signed_at', { ascending: false });
    if (error) throw error;
    state.appliedSignatures = (data || []).filter(item => item.documents);
  }

  function configureAppForProfile(forceProfileForm = false) {
    const p = state.profile;
    els['sidebar-user'].innerHTML = `<strong>${escapeHtml(p.full_name || p.email)}</strong><br>${escapeHtml(roleLabels[p.role] || p.role)}`;
    els['user-status-pill'].outerHTML = `<span id="user-status-pill" class="pill ${p.status === 'active' ? 'success' : 'warning'}">${escapeHtml(statusLabels[p.status] || p.status)}</span>`;
    els['user-status-pill'] = byId('user-status-pill');
    els['pending-banner'].classList.toggle('hidden', p.status === 'active');
    els['admin-nav'].classList.toggle('hidden', !isAdmin());
    qsa('[data-section="new-document"], [data-section="tasks"]').forEach(btn => btn.disabled = !isActive());
    fillProfileForm(forceProfileForm);
  }


  function renderAll() {
    renderDashboard();
    renderDocuments();
    renderTasks();
    renderSignatures();
    renderAppliedSignatures();
    if (isAdmin()) renderAdminUsers();
  }

  function renderDashboard() {
    const counts = {
      total: state.documents.length,
      draft: state.documents.filter(d => d.status === 'draft').length,
      pending: state.tasks.length,
      completed: state.documents.filter(d => d.status === 'completed').length
    };
    els['stats-grid'].innerHTML = [
      ['Documentos visibles', counts.total], ['Borradores', counts.draft],
      ['Mis pendientes', counts.pending], ['Completados', counts.completed]
    ].map(([label, count]) => `<article class="stat"><span class="muted">${label}</span><strong>${count}</strong></article>`).join('');
    const recent = state.documents.slice(0, 6);
    els['recent-documents'].innerHTML = recent.length ? documentTable(recent, false) : '<div class="empty">Aún no hay actividad.</div>';
  }

  function filteredDocuments() {
    const text = (els['document-search'].value || '').trim().toLowerCase();
    const status = els['document-status-filter'].value;
    return state.documents.filter(d => (!text || `${d.title} ${d.description || ''}`.toLowerCase().includes(text)) && (!status || d.status === status));
  }

  function renderDocuments() {
    const docs = filteredDocuments();
    els['documents-table'].innerHTML = docs.length ? documentTable(docs, true) : '<div class="empty">No se encontraron documentos.</div>';
  }

  function documentTable(docs, includeCategory = true) {
    return `<div class="table-wrap"><table><thead><tr><th>Título</th>${includeCategory ? '<th>Tipo</th>' : ''}<th>Estado</th><th>Versión</th><th>Actualización</th><th></th></tr></thead><tbody>
      ${docs.map(d => `<tr>
        <td><strong>${escapeHtml(d.title)}</strong><br><span class="muted small">${escapeHtml(d.active_file_name || 'Sin archivo')}</span></td>
        ${includeCategory ? `<td>${escapeHtml({contract:'Contrato',invoice:'Factura',other:'Otro'}[d.category] || d.category)}</td>` : ''}
        <td>${pill(d.status)}</td><td>v${d.current_version}</td><td>${fmtDate(d.updated_at)}</td>
        <td><button class="secondary" data-open-document="${d.id}">Ver</button></td>
      </tr>`).join('')}
    </tbody></table></div>`;
  }

  function renderTasks() {
    const tasks = state.tasks;
    els['tasks-table'].innerHTML = tasks.length ? `<div class="table-wrap"><table><thead><tr><th>Documento</th><th>Mi función</th><th>Secuencia</th><th>Estado</th><th></th></tr></thead><tbody>
      ${tasks.map(t => `<tr><td><strong>${escapeHtml(t.documents.title)}</strong></td><td>${escapeHtml(participantRoleLabels[t.participant_role])}</td><td>${t.sequence}</td><td>${pill(t.documents.status)}</td><td><button class="secondary" data-open-document="${t.document_id}">Abrir</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No tienes acciones pendientes.</div>';
  }

  function profileDraftKey() { return state.session?.user?.id ? `lumen-sign:profile-draft:${state.session.user.id}` : ''; }
  function getProfileDraft() { try { const raw = sessionStorage.getItem(profileDraftKey()); return raw ? JSON.parse(raw) : null; } catch { return null; } }
  function saveProfileDraft() {
    const key = profileDraftKey(); if (!key) return;
    sessionStorage.setItem(key, JSON.stringify({ full_name: byId('profile-name').value, department: byId('profile-department').value, phone: byId('profile-phone').value }));
    state.profileDirty = true;
  }
  function clearProfileDraft() { const key = profileDraftKey(); if (key) sessionStorage.removeItem(key); state.profileDirty = false; }
  function fillProfileForm(force = false) {
    const p = state.profile, draft = force ? null : getProfileDraft();
    byId('profile-email').value = p.email || '';
    byId('profile-name').value = draft?.full_name ?? p.full_name ?? '';
    byId('profile-department').value = draft?.department ?? p.department ?? '';
    byId('profile-phone').value = draft?.phone ?? p.phone ?? '';
    byId('profile-role').value = roleLabels[p.role] || p.role;
    byId('profile-status').value = statusLabels[p.status] || p.status;
    state.profileDirty = Boolean(draft);
  }


  async function renderSignatures() {
    const rows = [];
    for (const sig of state.signatures) {
      const { data } = await client.storage.from('signatures').createSignedUrl(sig.storage_path, 120);
      rows.push(`<div class="signature-card">
        <div>${data?.signedUrl ? `<img src="${data.signedUrl}" alt="${escapeHtml(sig.label)}">` : ''}<br><strong>${escapeHtml(sig.label)}</strong> ${sig.is_default ? '<span class="pill success">Predeterminada</span>' : ''}<br><span class="muted small">${fmtDate(sig.created_at)}</span></div>
        <button class="danger" data-revoke-signature="${sig.id}">Revocar</button>
      </div>`);
    }
    els['signature-list'].innerHTML = rows.length ? `<h3>Mis firmas</h3>${rows.join('')}` : '<div class="empty">No tienes una firma registrada.</div>';
  }

  function renderAppliedSignatures() {
    const rows = state.appliedSignatures;
    els['signed-history-table'].innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Documento</th><th>Estado</th><th>Fecha de firma</th><th>Hash</th><th></th></tr></thead><tbody>
      ${rows.map(item => `<tr><td><strong>${escapeHtml(item.documents.title)}</strong></td><td>${pill(item.documents.status)}</td><td>${fmtDate(item.signed_at)}</td><td><code>${escapeHtml((item.file_hash || '').slice(0,18))}…</code></td><td><button class="secondary" data-open-document="${item.document_id}">Abrir</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Todavía no has firmado documentos.</div>';
  }

  function renderAdminUsers() {
    const canSetAdmin = state.profile.role === 'superadmin';
    const roles = ['user','approver','signer','contracts','auditor', ...(canSetAdmin ? ['admin','superadmin'] : [])];
    els['admin-users-table'].innerHTML = `<div class="table-wrap"><table><thead><tr><th>Usuario</th><th>Departamento</th><th>Rol</th><th>Estado</th><th></th></tr></thead><tbody>
      ${state.profiles.map(p => {
        const protectedAccount = p.id === state.profile.id || (!canSetAdmin && ['admin','superadmin'].includes(p.role));
        const availableRoles = roles.includes(p.role) ? roles : [p.role, ...roles];
        return `<tr>
        <td><strong>${escapeHtml(p.full_name || 'Sin nombre')}</strong><br><span class="muted small">${escapeHtml(p.email)}</span></td>
        <td>${escapeHtml(p.department || '—')}</td>
        <td><select data-admin-role="${p.id}" ${protectedAccount ? 'disabled' : ''}>${availableRoles.map(r => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${roleLabels[r]}</option>`).join('')}</select></td>
        <td><select data-admin-status="${p.id}" ${protectedAccount ? 'disabled' : ''}><option value="pending" ${p.status==='pending'?'selected':''}>Pendiente</option><option value="active" ${p.status==='active'?'selected':''}>Activo</option><option value="suspended" ${p.status==='suspended'?'selected':''}>Suspendido</option></select></td>
        <td><button class="primary" data-save-user="${p.id}" ${protectedAccount ? 'disabled' : ''}>Guardar</button></td>
      </tr>`; }).join('')}
    </tbody></table></div>`;
  }

  function navigate(section) {
    if (!isActive() && ['new-document','tasks','documents','dashboard'].includes(section)) section = 'profile';
    qsa('.page-section').forEach(s => s.classList.add('hidden'));
    byId(`section-${section}`).classList.remove('hidden');
    qsa('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.section === section));
    const titles = {
      dashboard: ['Resumen', 'Estado general de tus documentos'], documents: ['Documentos', 'Expedientes a los que tienes acceso'],
      'new-document': ['Nuevo documento', 'Carga un PDF y define su flujo'], tasks: ['Mis pendientes', 'Aprobaciones y firmas asignadas'],
      profile: ['Mi perfil y firma', 'Datos personales y firma registrada'], admin: ['Administración', 'Usuarios, estados y permisos']
    };
    els['page-title'].textContent = titles[section][0];
    els['page-subtitle'].textContent = titles[section][1];
    document.querySelector('.sidebar').classList.remove('open');
    if (section === 'profile') setTimeout(prepareCanvas, 50);
  }

  function activeProfilesOptions(selected = '') {
    return state.profiles.filter(p => p.status === 'active').map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${escapeHtml(p.full_name || p.email)} — ${escapeHtml(roleLabels[p.role] || p.role)}</option>`).join('');
  }

  function addParticipantRow(container, value = {}) {
    const row = document.createElement('div');
    row.className = 'participant-row';
    row.innerHTML = `
      <label>Usuario<select class="participant-user" required><option value="">Selecciona</option>${activeProfilesOptions(value.user_id)}</select></label>
      <label>Función<select class="participant-role"><option value="approver" ${value.participant_role==='approver'?'selected':''}>Aprobador</option><option value="signer" ${value.participant_role==='signer'?'selected':''}>Firmante</option><option value="editor" ${value.participant_role==='editor'?'selected':''}>Editor</option><option value="viewer" ${value.participant_role==='viewer'?'selected':''}>Consulta</option></select></label>
      <label>Secuencia<input class="participant-sequence" type="number" min="1" max="99" value="${Number(value.sequence || 1)}" required></label>
      <button class="danger remove-participant" type="button">Quitar</button>`;
    container.appendChild(row);
  }

  function readParticipantRows(container) {
    return qsa('.participant-row', container).map(row => ({
      user_id: row.querySelector('.participant-user').value,
      participant_role: row.querySelector('.participant-role').value,
      sequence: Number(row.querySelector('.participant-sequence').value)
    })).filter(p => p.user_id);
  }

  async function createDocument(event) {
    event.preventDefault();
    if (!isActive()) throw new Error('Tu cuenta no está activa.');
    const file = byId('doc-file').files[0], attachment = byId('doc-attachment').files[0];
    validateFile(file, ['application/pdf'], true); if (attachment) validateFile(attachment, [], false);
    const participants = readParticipantRows(els['participants-builder']);
    if (!participants.some(p => p.participant_role === 'signer')) throw new Error('Agrega al menos un firmante.');
    const openPreparer = byId('prepare-after-save').checked;
    let newDocId = null;
    await run(async () => {
      const { data: docId, error: createError } = await client.rpc('create_document', { p_title: byId('doc-title').value.trim(), p_description: byId('doc-description').value.trim(), p_category: byId('doc-category').value });
      if (createError) throw createError; newDocId = docId;
      const filePath = `${docId}/v1/${Date.now()}-${safeFilename(file.name)}`, hash = await sha256(file);
      const { error: uploadError } = await client.storage.from('documents').upload(filePath, file, { contentType: file.type || 'application/pdf', upsert: false }); if (uploadError) throw uploadError;
      const { error: attachError } = await client.rpc('attach_primary_file', { p_document_id: docId, p_file_path: filePath, p_file_name: file.name, p_file_hash: hash, p_mime_type: file.type || 'application/pdf', p_size_bytes: file.size }); if (attachError) throw attachError;
      if (attachment) {
        const path = `${docId}/attachments/${Date.now()}-${safeFilename(attachment.name)}`, attachmentHash = await sha256(attachment);
        const { error: up2 } = await client.storage.from('documents').upload(path, attachment, { contentType: attachment.type || 'application/octet-stream' }); if (up2) throw up2;
        const { error: a2 } = await client.rpc('add_document_attachment', { p_document_id: docId, p_file_path: path, p_file_name: attachment.name, p_file_hash: attachmentHash, p_mime_type: attachment.type || 'application/octet-stream', p_size_bytes: attachment.size }); if (a2) throw a2;
      }
      const { error: flowError } = await client.rpc('set_document_participants', { p_document_id: docId, p_items: participants }); if (flowError) throw flowError;
      event.target.reset(); byId('prepare-after-save').checked = true; els['participants-builder'].innerHTML = '';
      addParticipantRow(els['participants-builder'], { participant_role: 'approver', sequence: 1 }); addParticipantRow(els['participants-builder'], { participant_role: 'signer', sequence: 1 });
      await refreshData(); navigate('documents');
    }, 'Borrador creado. Ahora coloca los campos de firma.');
    if (openPreparer && newDocId) await openPrepareDocument(newDocId);
  }


  function validateFile(file, mimeTypes = [], required = false) {
    if (!file && required) throw new Error('Selecciona un archivo.');
    if (!file) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`El archivo excede ${MAX_FILE_MB} MB.`);
    if (mimeTypes.length && !mimeTypes.includes(file.type) && !file.name.toLowerCase().endsWith('.pdf')) throw new Error('El documento principal debe ser PDF.');
  }

  async function openDocument(id) {
    state.activeDocumentId = id;
    await run(async () => {
      const [docRes, participantsRes, versionsRes, attachmentsRes, eventsRes, signaturesRes] = await Promise.all([
        client.from('documents').select('*').eq('id', id).single(),
        client.from('document_participants').select('*').eq('document_id', id).order('sequence'),
        client.from('document_versions').select('*').eq('document_id', id).order('version_number', { ascending: false }),
        client.from('document_attachments').select('*').eq('document_id', id).order('created_at', { ascending: false }),
        client.from('audit_events').select('*').eq('document_id', id).order('created_at', { ascending: false }),
        client.from('document_signatures').select('*').eq('document_id', id).order('signed_at', { ascending: false })
      ]);
      [docRes, participantsRes, versionsRes, attachmentsRes, eventsRes, signaturesRes].forEach(r => { if (r.error) throw r.error; });
      renderDocumentDetail(docRes.data, participantsRes.data || [], versionsRes.data || [], attachmentsRes.data || [], eventsRes.data || [], signaturesRes.data || []);
      els['document-dialog'].showModal();
    });
  }

  function profileName(id) {
    const p = state.profiles.find(x => x.id === id);
    return p?.full_name || p?.email || 'Usuario';
  }

  function renderDocumentDetail(doc, participants, versions, attachments, events, signatures) {
    const me = state.session.user.id;
    const myApproval = participants.find(p => p.user_id === me && p.participant_role === 'approver' && p.action_status === 'pending');
    const mySignature = participants.find(p => p.user_id === me && p.participant_role === 'signer' && p.action_status === 'pending');
    const isAssignedEditor = participants.some(p => p.user_id === me && p.participant_role === 'editor');
    const canConfigure = doc.status === 'draft' && (doc.owner_id === me || isAdmin() || isContracts() || isAssignedEditor);
    const canReplace = (doc.status === 'draft' && (doc.owner_id === me || isAdmin() || isContracts() || isAssignedEditor))
      || (doc.status === 'rejected' && (isAdmin() || isContracts()));
    const actions = [
      doc.active_file_path ? `<button class="secondary" data-download-path="${escapeHtml(doc.active_file_path)}" data-download-name="${escapeHtml(doc.active_file_name || 'documento.pdf')}">Descargar actual</button>` : '',
      canReplace ? `<button class="secondary" data-replace-document="${doc.id}">Subir nueva versión</button>` : '',
      canConfigure ? `<button class="secondary" data-configure-flow="${doc.id}">Configurar flujo</button><button class="secondary" data-prepare-document="${doc.id}">Preparar firmas</button><button class="primary" data-submit-document="${doc.id}">Enviar a flujo</button>` : '',
      myApproval && doc.status === 'awaiting_approval' ? `<button class="primary" data-approve-document="${doc.id}">Aprobar</button><button class="danger" data-reject-document="${doc.id}">Rechazar</button>` : '',
      mySignature && doc.status === 'awaiting_signature' ? `<button class="primary" data-sign-document="${doc.id}">Revisar y firmar</button>` : ''
    ].join('');

    els['document-detail'].innerHTML = `
      <div class="stack">
        <div><h2>${escapeHtml(doc.title)}</h2><div class="button-row">${actions}</div></div>
        <div class="detail-grid">
          <div><strong>Estado</strong><p>${pill(doc.status)}</p></div><div><strong>Tipo</strong><p>${escapeHtml({contract:'Contrato',invoice:'Factura',other:'Otro'}[doc.category] || doc.category)}</p></div>
          <div><strong>Propietario</strong><p>${escapeHtml(profileName(doc.owner_id))}</p></div><div><strong>Versión actual</strong><p>v${doc.current_version} · ${fmtBytes(doc.size_bytes)}</p></div>
          <div><strong>Creado</strong><p>${fmtDate(doc.created_at)}</p></div><div><strong>Última actualización</strong><p>${fmtDate(doc.updated_at)}</p></div>
        </div>
        <div><strong>Descripción</strong><p>${escapeHtml(doc.description || 'Sin descripción')}</p></div>
        <div><h3>Participantes</h3>${participants.length ? `<div class="table-wrap"><table><thead><tr><th>Usuario</th><th>Función</th><th>Secuencia</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>${participants.map(p => `<tr><td>${escapeHtml(profileName(p.user_id))}</td><td>${escapeHtml(participantRoleLabels[p.participant_role])}</td><td>${p.sequence}</td><td>${pill(p.action_status)}</td><td>${fmtDate(p.acted_at)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Sin participantes.</div>'}</div>
        <div><h3>Versiones</h3>${versions.length ? `<div class="table-wrap"><table><thead><tr><th>Versión</th><th>Archivo</th><th>Hash SHA-256</th><th>Fecha</th><th></th></tr></thead><tbody>${versions.map(v => `<tr><td>v${v.version_number}</td><td>${escapeHtml(v.file_name)}</td><td><code title="${escapeHtml(v.file_hash)}">${escapeHtml((v.file_hash || '').slice(0,16))}…</code></td><td>${fmtDate(v.created_at)}</td><td><button class="secondary" data-download-path="${escapeHtml(v.file_path)}" data-download-name="${escapeHtml(v.file_name)}">Descargar</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Sin versiones.</div>'}</div>
        <div><h3>Anexos</h3>${attachments.length ? attachments.map(a => `<div class="signature-card"><span>${escapeHtml(a.file_name)} · ${fmtBytes(a.size_bytes)}</span><button class="secondary" data-download-path="${escapeHtml(a.file_path)}" data-download-name="${escapeHtml(a.file_name)}">Descargar</button></div>`).join('') : '<p class="muted">Sin anexos.</p>'}</div>
        <div><h3>Firmas aplicadas</h3>${signatures.length ? signatures.map(s => `<div class="timeline-item"><strong>${escapeHtml(profileName(s.signer_id))}</strong><p>${fmtDate(s.signed_at)}</p><p class="muted small">Hash: ${escapeHtml((s.file_hash || '').slice(0,24))}…</p></div>`).join('') : '<p class="muted">Aún no hay firmas.</p>'}</div>
        <div><h3>Historial</h3><div class="timeline">${events.length ? events.map(e => `<div class="timeline-item"><strong>${escapeHtml(eventLabel(e.action))}</strong><p>${escapeHtml(profileName(e.actor_id))} · ${fmtDate(e.created_at)}</p>${e.metadata?.comment ? `<p>${escapeHtml(e.metadata.comment)}</p>` : ''}</div>`).join('') : '<p class="muted">Sin eventos.</p>'}</div></div>
      </div>`;
  }

  function eventLabel(action) {
    return ({document_created:'Documento creado',primary_file_attached:'Archivo principal cargado',attachment_added:'Anexo agregado',flow_updated:'Flujo actualizado',document_submitted:'Documento enviado',document_approved:'Documento aprobado',document_rejected:'Documento rechazado',document_signed:'Documento firmado',document_completed:'Flujo completado',signature_fields_updated:'Campos de firma preparados'}[action] || action);
  }

  async function replaceDocumentFile(id) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      validateFile(file, ['application/pdf'], true);
      await run(async () => {
        const doc = state.documents.find(d => d.id === id) || (await client.from('documents').select('*').eq('id', id).single()).data;
        const nextVersion = Number(doc.current_version) + 1;
        const path = `${id}/v${nextVersion}/${Date.now()}-${safeFilename(file.name)}`;
        const hash = await sha256(file);
        const { error: uploadError } = await client.storage.from('documents').upload(path, file, { contentType: file.type || 'application/pdf', upsert: false });
        if (uploadError) throw uploadError;
        const { error } = await client.rpc('attach_primary_file', {
          p_document_id: id, p_file_path: path, p_file_name: file.name, p_file_hash: hash,
          p_mime_type: file.type || 'application/pdf', p_size_bytes: file.size
        });
        if (error) throw error;
        if (els['document-dialog'].open) els['document-dialog'].close();
        await refreshData();
        await openDocument(id);
      }, 'Nueva versión cargada.');
    }, { once: true });
    input.click();
  }

  async function downloadPrivate(path, name) {
    await run(async () => {
      const { data, error } = await client.storage.from('documents').createSignedUrl(path, 90, { download: name });
      if (error) throw error;
      const a = document.createElement('a');
      a.href = data.signedUrl; a.download = name; a.target = '_blank'; a.rel = 'noopener'; a.click();
    });
  }

  async function configureFlow(docId) {
    state.flowDocumentId = docId;
    const { data, error } = await client.from('document_participants').select('*').eq('document_id', docId).order('sequence');
    if (error) throw error;
    els['flow-builder'].innerHTML = '';
    (data || []).forEach(p => addParticipantRow(els['flow-builder'], p));
    if (!(data || []).length) addParticipantRow(els['flow-builder'], { participant_role: 'signer', sequence: 1 });
    if (els['document-dialog'].open) els['document-dialog'].close();
    els['flow-dialog'].showModal();
  }

  async function saveFlow() {
    const items = readParticipantRows(els['flow-builder']);
    if (!items.some(p => p.participant_role === 'signer')) throw new Error('Agrega al menos un firmante.');
    await run(async () => {
      const { error } = await client.rpc('set_document_participants', { p_document_id: state.flowDocumentId, p_items: items });
      if (error) throw error;
      els['flow-dialog'].close();
      await refreshData();
      await openDocument(state.flowDocumentId);
    }, 'Flujo actualizado.');
  }

  async function submitDocument(id) {
    await run(async () => {
      const { error } = await client.rpc('submit_document', { p_document_id: id });
      if (error) throw error;
      els['document-dialog'].close();
      await refreshData();
    }, 'Documento enviado al flujo.');
  }

  async function actOnDocument(id, action) {
    const comment = prompt(action === 'approve' ? 'Comentario opcional de aprobación:' : 'Motivo del rechazo:') || '';
    if (action === 'reject' && !comment.trim()) throw new Error('Escribe el motivo del rechazo.');
    await run(async () => {
      const { error } = await client.rpc('act_on_document', { p_document_id: id, p_action: action, p_comment: comment.trim() });
      if (error) throw error;
      els['document-dialog'].close();
      await refreshData();
    }, action === 'approve' ? 'Aprobación registrada.' : 'Documento rechazado.');
  }


  const fieldTypeLabels = { signature:'Firma', initials:'Iniciales', date:'Fecha', name:'Nombre', text:'Texto', checkbox:'Casilla' };
  function initialsOf(name) { return String(name || '').trim().split(/\s+/).filter(Boolean).slice(0,3).map(x => x[0]?.toUpperCase() || '').join(''); }
  function defaultFieldSize(type) { return type === 'signature' ? [28,9] : type === 'checkbox' ? [6,6] : type === 'text' ? [28,6] : [20,5]; }
  async function getDocumentBundle(id) {
    const [docRes, partsRes, fieldsRes] = await Promise.all([
      client.from('documents').select('*').eq('id',id).single(),
      client.from('document_participants').select('*').eq('document_id',id).order('sequence'),
      client.from('document_fields').select('*').eq('document_id',id).order('page_number')
    ]);
    [docRes,partsRes,fieldsRes].forEach(r => { if (r.error) throw r.error; });
    const { data:url, error:urlError } = await client.storage.from('documents').createSignedUrl(docRes.data.active_file_path,300); if (urlError) throw urlError;
    const response = await fetch(url.signedUrl); if (!response.ok) throw new Error('No se pudo abrir el PDF.');
    return { doc:docRes.data, participants:partsRes.data||[], fields:fieldsRes.data||[], bytes:await response.arrayBuffer() };
  }
  function signerOptions(participants, selected='') {
    return participants.filter(p => p.participant_role === 'signer').map(p => `<option value="${p.user_id}" ${p.user_id===selected?'selected':''}>${escapeHtml(profileName(p.user_id))} · secuencia ${p.sequence}</option>`).join('');
  }
  async function renderPdfPage(container, pdf, pageNumber, scale, fields, mode) {
    container.innerHTML = '<div class="visual-loading">Renderizando página…</div>';
    const page = await pdf.getPage(pageNumber), viewport = page.getViewport({scale});
    const wrapper = document.createElement('div'); wrapper.className='pdf-page'; wrapper.dataset.page=String(pageNumber);
    const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d'); canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
    wrapper.style.width=`${canvas.width}px`; wrapper.style.height=`${canvas.height}px`; wrapper.append(canvas);
    const badge=document.createElement('span'); badge.className='pdf-page-number'; badge.textContent=`Página ${pageNumber}`; wrapper.append(badge); container.innerHTML=''; container.append(wrapper);
    await page.render({canvasContext:ctx,viewport}).promise;
    fields.filter(f => Number(f.page_number)===pageNumber).forEach(f => wrapper.append(createFieldOverlay(f,mode)));
    return wrapper;
  }
  function positionOverlay(el, field) {
    el.style.left=`${field.x_pct}%`; el.style.top=`${field.y_pct}%`; el.style.width=`${field.width_pct}%`; el.style.height=`${field.height_pct}%`;
  }
  function createFieldOverlay(field, mode) {
    const el=document.createElement('div'); el.className='field-overlay'; el.dataset.fieldId=field.id; positionOverlay(el,field);
    if (field.required) el.insertAdjacentHTML('beforeend','<span class="field-required-mark">*</span>');
    if (mode==='prepare') {
      el.innerHTML += `<span class="field-caption">${escapeHtml(fieldTypeLabels[field.field_type])}: ${escapeHtml(profileName(field.assigned_to))}</span><span class="resize-handle"></span>`;
      el.addEventListener('pointerdown', startFieldPointer); el.addEventListener('click', e => { e.stopPropagation(); selectPreparedField(field.id); });
      if (state.prepare?.selectedId===field.id) el.classList.add('selected');
    } else {
      if (field.assigned_to !== state.session.user.id) { el.classList.add('other-signer'); el.innerHTML += `<span class="field-caption">${escapeHtml(fieldTypeLabels[field.field_type])}</span>`; return el; }
      renderSigningControl(el,field);
    }
    return el;
  }
  function renderSigningControl(el,field) {
    const values=state.signing.values; const value=values[field.id] ?? '';
    if (value) el.classList.add('completed');
    if (field.field_type==='text') {
      el.innerHTML += `<input type="text" maxlength="4000" placeholder="${escapeHtml(field.placeholder||field.label||'Escribe aquí')}" value="${escapeHtml(value)}">`;
      el.querySelector('input').addEventListener('input',e=>{values[field.id]=e.target.value; updateSignProgress();});
    } else if (field.field_type==='checkbox') {
      el.innerHTML += `<input type="checkbox" ${value==='true'?'checked':''}>`; el.querySelector('input').addEventListener('change',e=>{values[field.id]=e.target.checked?'true':''; updateSignProgress(); renderSigningPages(false);});
    } else if (field.field_type==='signature') {
      el.innerHTML += value ? `<div class="field-value"><img src="${state.signing.signatureUrl}" alt="Firma"></div>` : '<button class="sign-field-button" type="button">Aplicar mi firma</button>';
      const b=el.querySelector('button'); if (b) b.addEventListener('click',()=>{values[field.id]='signature'; renderSigningPages(false); updateSignProgress();});
    } else {
      const auto = field.field_type==='initials' ? initialsOf(state.profile.full_name||state.profile.email) : field.field_type==='date' ? new Date().toLocaleDateString('es-MX') : (state.profile.full_name||state.profile.email);
      if (!value) values[field.id]=auto;
      el.innerHTML += `<div class="field-value">${escapeHtml(values[field.id])}</div>`; el.classList.add('completed');
    }
  }
  async function openPrepareDocument(id) {
    await run(async()=>{
      const bundle=await getDocumentBundle(id); const signers=bundle.participants.filter(p=>p.participant_role==='signer'); if(!signers.length) throw new Error('Configura al menos un firmante.');
      const pdf=await pdfjsLib.getDocument({data:bundle.bytes.slice(0)}).promise;
      state.prepare={...bundle,pdf,page:1,pageCount:pdf.numPages,zoom:1.15,selectedId:null,fields:bundle.fields.map(f=>({...f,x_pct:Number(f.x_pct),y_pct:Number(f.y_pct),width_pct:Number(f.width_pct),height_pct:Number(f.height_pct)}))};
      const options=signerOptions(bundle.participants); els['field-assignee'].innerHTML=options; els['selected-field-assignee'].innerHTML=options;
      els['prepare-page-count'].textContent=String(pdf.numPages); els['prepare-dialog'].showModal(); await renderPreparePage();
    });
  }
  async function renderPreparePage() {
    const p=state.prepare; if(!p) return; els['prepare-page-number'].textContent=String(p.page); els['prepare-zoom-label'].textContent=`${Math.round(p.zoom*100/1.15)}%`;
    await renderPdfPage(els['prepare-pages'],p.pdf,p.page,p.zoom,p.fields,'prepare');
  }
  function selectPreparedField(id) {
    const p=state.prepare, f=p?.fields.find(x=>x.id===id); if(!f) return; p.selectedId=id; els['selected-field-panel'].classList.remove('hidden');
    els['selected-field-assignee'].value=f.assigned_to; els['selected-field-type'].value=f.field_type; els['selected-field-label'].value=f.label||''; els['selected-field-required'].checked=Boolean(f.required);
    qsa('.field-overlay',els['prepare-pages']).forEach(x=>x.classList.toggle('selected',x.dataset.fieldId===id));
  }
  function addPreparedField() {
    const p=state.prepare, type=els['field-type'].value, assigned=els['field-assignee'].value; if(!p||!assigned) throw new Error('Selecciona un firmante.');
    const [w,h]=defaultFieldSize(type); const offset=(p.fields.filter(f=>Number(f.page_number)===p.page).length%8)*2;
    const f={id:crypto.randomUUID(),document_id:p.doc.id,assigned_to:assigned,field_type:type,page_number:p.page,x_pct:8+offset,y_pct:10+offset,width_pct:w,height_pct:h,required:els['field-required'].checked,label:els['field-label'].value.trim(),placeholder:''};
    p.fields.push(f); p.selectedId=f.id; renderPreparePage().then(()=>selectPreparedField(f.id));
  }
  function startFieldPointer(event) {
    const p=state.prepare; if(!p) return; const el=event.currentTarget, f=p.fields.find(x=>x.id===el.dataset.fieldId); if(!f) return;
    event.preventDefault(); event.stopPropagation(); selectPreparedField(f.id); el.setPointerCapture(event.pointerId);
    const page=el.parentElement, rect=page.getBoundingClientRect(), startX=event.clientX,startY=event.clientY, original={x:f.x_pct,y:f.y_pct,w:f.width_pct,h:f.height_pct}; const resizing=event.target.classList.contains('resize-handle');
    const move=e=>{const dx=(e.clientX-startX)/rect.width*100,dy=(e.clientY-startY)/rect.height*100;if(resizing){f.width_pct=Math.max(4,Math.min(100-original.x,original.w+dx));f.height_pct=Math.max(3,Math.min(100-original.y,original.h+dy));}else{f.x_pct=Math.max(0,Math.min(100-original.w,original.x+dx));f.y_pct=Math.max(0,Math.min(100-original.h,original.y+dy));}positionOverlay(el,f);};
    const stop=()=>{el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',stop);el.removeEventListener('pointercancel',stop);}; el.addEventListener('pointermove',move);el.addEventListener('pointerup',stop);el.addEventListener('pointercancel',stop);
  }
  function updateSelectedPreparedField() {
    const p=state.prepare,f=p?.fields.find(x=>x.id===p.selectedId);if(!f)return;f.assigned_to=els['selected-field-assignee'].value;f.field_type=els['selected-field-type'].value;f.label=els['selected-field-label'].value.trim();f.required=els['selected-field-required'].checked;renderPreparePage().then(()=>selectPreparedField(f.id));
  }
  function deletePreparedField() { const p=state.prepare;if(!p?.selectedId)return;p.fields=p.fields.filter(f=>f.id!==p.selectedId);p.selectedId=null;els['selected-field-panel'].classList.add('hidden');renderPreparePage(); }
  async function savePreparedFields(submit=false) {
    const p=state.prepare;if(!p)return;const signers=p.participants.filter(x=>x.participant_role==='signer');
    for(const s of signers) if(!p.fields.some(f=>f.assigned_to===s.user_id&&f.field_type==='signature')) throw new Error(`Falta un campo Firma para ${profileName(s.user_id)}.`);
    await run(async()=>{const payload=p.fields.map(f=>({id:f.id,assigned_to:f.assigned_to,field_type:f.field_type,page_number:Number(f.page_number),x_pct:Number(f.x_pct.toFixed(4)),y_pct:Number(f.y_pct.toFixed(4)),width_pct:Number(f.width_pct.toFixed(4)),height_pct:Number(f.height_pct.toFixed(4)),required:Boolean(f.required),label:f.label||'',placeholder:f.placeholder||''}));
      const {error}=await client.rpc('save_document_fields',{p_document_id:p.doc.id,p_fields:payload});if(error)throw error;if(submit){const r=await client.rpc('submit_document',{p_document_id:p.doc.id});if(r.error)throw r.error;}els['prepare-dialog'].close();await refreshData();
    },submit?'Campos guardados y documento enviado.':'Campos guardados.');
  }
  async function openSigningDocument(id) {
    const defaultSignature=state.signatures.find(s=>s.is_default&&!s.revoked_at)||state.signatures[0];if(!defaultSignature)throw new Error('Primero registra una firma en Mi perfil y firma.');
    await run(async()=>{const bundle=await getDocumentBundle(id);const mine=bundle.fields.filter(f=>f.assigned_to===state.session.user.id);if(!mine.length)throw new Error('No tienes campos asignados.');
      const {data:sigUrl,error:sigErr}=await client.storage.from('signatures').createSignedUrl(defaultSignature.storage_path,300);if(sigErr)throw sigErr;
      const pdf=await pdfjsLib.getDocument({data:bundle.bytes.slice(0)}).promise;const values={};mine.forEach(f=>{if(f.value_text)values[f.id]=f.value_text;});
      state.signing={...bundle,pdf,fields:bundle.fields.map(f=>({...f,x_pct:Number(f.x_pct),y_pct:Number(f.y_pct),width_pct:Number(f.width_pct),height_pct:Number(f.height_pct)})),mine,values,signature:defaultSignature,signatureUrl:sigUrl.signedUrl};
      if(els['document-dialog'].open)els['document-dialog'].close();els['sign-dialog'].showModal();await renderSigningPages(true);updateSignProgress();
    });
  }
  async function renderSigningPages(reset=true) {
    const s=state.signing;if(!s)return;const scroll=reset?0:els['sign-pages'].scrollTop;els['sign-pages'].innerHTML='<div class="visual-loading">Preparando vista previa…</div>';
    const frag=document.createDocumentFragment();for(let i=1;i<=s.pdf.numPages;i++){const holder=document.createElement('div');await renderPdfPage(holder,s.pdf,i,1.15,s.fields,'sign');while(holder.firstChild)frag.append(holder.firstChild);}els['sign-pages'].innerHTML='';els['sign-pages'].append(frag);if(!reset)els['sign-pages'].scrollTop=scroll;
  }
  function updateSignProgress() { const s=state.signing;if(!s)return;const required=s.mine.filter(f=>f.required),complete=required.filter(f=>String(s.values[f.id]||'').trim()).length;els['sign-progress'].textContent=`${complete} de ${required.length} campos obligatorios completos`; }
  function nextRequiredField() { const s=state.signing;if(!s)return;const target=s.mine.find(f=>f.required&&!String(s.values[f.id]||'').trim())||s.mine[0];if(!target)return;const el=els['sign-pages'].querySelector(`[data-field-id="${target.id}"]`);el?.scrollIntoView({behavior:'smooth',block:'center'}); }
  async function finishVisualSigning() {
    const s=state.signing;if(!s)return;const missing=s.mine.filter(f=>f.required&&!String(s.values[f.id]||'').trim());if(missing.length)throw new Error(`Faltan ${missing.length} campos obligatorios.`);
    await run(async()=>{const sigResponse=await fetch(s.signatureUrl);if(!sigResponse.ok)throw new Error('No se pudo cargar tu firma.');const sigBytes=await sigResponse.arrayBuffer();
      const {PDFDocument,StandardFonts,rgb}=PDFLib,pdfDoc=await PDFDocument.load(s.bytes),font=await pdfDoc.embedFont(StandardFonts.Helvetica),sigImage=await pdfDoc.embedPng(sigBytes),pages=pdfDoc.getPages();
      for(const f of s.mine){const page=pages[Number(f.page_number)-1];if(!page)continue;const size=page.getSize(),x=size.width*f.x_pct/100,w=size.width*f.width_pct/100,h=size.height*f.height_pct/100,y=size.height-(size.height*f.y_pct/100)-h,value=String(s.values[f.id]||'');
        if(f.field_type==='signature'){const scaled=sigImage.scaleToFit(Math.max(10,w-6),Math.max(10,h-6));page.drawImage(sigImage,{x:x+(w-scaled.width)/2,y:y+(h-scaled.height)/2,width:scaled.width,height:scaled.height});}
        else if(f.field_type==='checkbox'){page.drawRectangle({x,y,width:w,height:h,borderColor:rgb(.1,.1,.1),borderWidth:1});if(value==='true'){page.drawLine({start:{x:x+2,y:y+2},end:{x:x+w-2,y:y+h-2},thickness:1.5});page.drawLine({start:{x:x+w-2,y:y+2},end:{x:x+2,y:y+h-2},thickness:1.5});}}
        else {let fontSize=Math.max(6,Math.min(12,h*.45));page.drawText(value.slice(0,500),{x:x+3,y:y+Math.max(2,(h-fontSize)/2),size:fontSize,font,color:rgb(.05,.12,.2),maxWidth:Math.max(5,w-6)});}
      }
      const output=await pdfDoc.save(),blob=new Blob([output],{type:'application/pdf'}),hash=await sha256(output.buffer),nextVersion=Number(s.doc.current_version)+1,path=`${s.doc.id}/signed/v${nextVersion}-${state.session.user.id}-${Date.now()}.pdf`,fileName=`${s.doc.title.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ -]/g,'').trim().replace(/\s+/g,'-')}-firmado-v${nextVersion}.pdf`;
      const up=await client.storage.from('documents').upload(path,blob,{contentType:'application/pdf',upsert:false});if(up.error)throw up.error;
      const rec=await client.rpc('record_document_signature_v2',{p_document_id:s.doc.id,p_user_signature_id:s.signature.id,p_file_path:path,p_file_name:fileName,p_file_hash:hash,p_size_bytes:blob.size,p_user_agent:navigator.userAgent.slice(0,500),p_values:s.mine.map(f=>({id:f.id,value:String(s.values[f.id]||'')}))});if(rec.error)throw rec.error;
      els['sign-dialog'].close();state.signing=null;await refreshData();
    },'Documento firmado en los campos indicados.');
  }

  async function signDocument(id) { await openSigningDocument(id); }


  function prepareCanvas() {
    const canvas = els['signature-canvas'], rect = canvas.getBoundingClientRect(); if (!rect.width) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1), nextWidth = Math.floor(rect.width * ratio), nextHeight = Math.floor(220 * ratio);
    const snapshot = canvas.dataset.hasInk === '1' && canvas.width && canvas.height ? canvas.toDataURL('image/png') : '';
    const same = canvas.width === nextWidth && canvas.height === nextHeight && canvas.dataset.canvasReady === '1';
    if (!same) { canvas.width = nextWidth; canvas.height = nextHeight; canvas.dataset.canvasReady = '1'; }
    const ctx = canvas.getContext('2d'); ctx.setTransform(ratio,0,0,ratio,0,0); ctx.lineWidth=2.2;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#13283d';
    if (!same && snapshot) { const img=new Image(); img.onload=()=>{ctx.drawImage(img,0,0,rect.width,220);canvas.dataset.hasInk='1';}; img.src=snapshot; }
  }


  function canvasPoint(event) {
    const rect = els['signature-canvas'].getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function clearCanvas() {
    const c = els['signature-canvas'];
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    c.dataset.hasInk = '';
  }

  async function saveSignature() {
    const canvas = els['signature-canvas'];
    if (!canvas.dataset.hasInk) throw new Error('Dibuja tu firma antes de guardarla.');
    const label = byId('signature-label').value.trim() || 'Firma principal';
    await run(async () => {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const path = `${state.session.user.id}/${crypto.randomUUID()}.png`;
      const { error: uploadError } = await client.storage.from('signatures').upload(path, blob, { contentType: 'image/png', upsert: false });
      if (uploadError) throw uploadError;
      const { error } = await client.rpc('register_signature', { p_storage_path: path, p_label: label });
      if (error) throw error;
      clearCanvas();
      await loadSignatures();
      await renderSignatures();
    }, 'Firma guardada.');
  }

  async function revokeSignature(id) {
    if (!confirm('¿Revocar esta firma? No se borrarán las firmas ya aplicadas a documentos.')) return;
    await run(async () => {
      const { error } = await client.rpc('revoke_signature', { p_signature_id: id });
      if (error) throw error;
      await loadSignatures();
      await renderSignatures();
    }, 'Firma revocada.');
  }

  async function updateProfile(event) {
    event.preventDefault();
    await run(async () => {
      const { error } = await client.rpc('update_my_profile', { p_full_name: byId('profile-name').value.trim(), p_department: byId('profile-department').value.trim(), p_phone: byId('profile-phone').value.trim() });
      if (error) throw error; clearProfileDraft(); await loadProfile(); configureAppForProfile(true);
    }, 'Perfil actualizado.');
  }


  async function updateAdminUser(id) {
    const role = document.querySelector(`[data-admin-role="${id}"]`).value;
    const status = document.querySelector(`[data-admin-status="${id}"]`).value;
    await run(async () => {
      const { error } = await client.rpc('admin_update_profile', { p_user_id: id, p_role: role, p_status: status });
      if (error) throw error;
      await loadProfiles();
      renderAdminUsers();
    }, 'Usuario actualizado.');
  }

  async function refreshData() {
    await Promise.all([loadProfiles(), loadDocuments(), loadTasks(), loadSignatures(), loadAppliedSignatures()]);
    renderAll();
  }

  function bindEvents() {
    qsa('[data-auth-tab]').forEach(btn => btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab)));
    els['login-form'].addEventListener('submit', async e => {
      e.preventDefault();
      await run(async () => {
        const { error } = await client.auth.signInWithPassword({ email: byId('login-email').value.trim(), password: byId('login-password').value });
        if (error) throw error;
      });
    });
    els['register-form'].addEventListener('submit', async e => {
      e.preventDefault();
      await run(async () => {
        const redirectTo = `${location.origin}${location.pathname}`;
        const { data, error } = await client.auth.signUp({
          email: byId('register-email').value.trim(), password: byId('register-password').value,
          options: { data: { full_name: byId('register-name').value.trim() }, emailRedirectTo: redirectTo }
        });
        if (error) throw error;
        e.target.reset();
        toast(data.session ? 'Cuenta creada. Un administrador debe activarla.' : 'Revisa tu correo para confirmar la cuenta.');
        switchAuthTab('login');
      });
    });
    els['forgot-password'].addEventListener('click', async () => {
      const email = byId('login-email').value.trim() || prompt('Escribe tu correo:');
      if (!email) return;
      await run(async () => {
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}${location.pathname}` });
        if (error) throw error;
      }, 'Se envió el enlace de recuperación.');
    });
    els['logout-button'].addEventListener('click', async () => { clearProfileDraft(); await client.auth.signOut(); });
    els['main-nav'].addEventListener('click', e => { const b = e.target.closest('[data-section]'); if (b && !b.disabled) navigate(b.dataset.section); });
    els['menu-button'].addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
    els['document-search'].addEventListener('input', renderDocuments);
    els['document-status-filter'].addEventListener('change', renderDocuments);
    els['new-document-form'].addEventListener('submit', createDocument);
    els['add-participant'].addEventListener('click', () => addParticipantRow(els['participants-builder']));
    els['participants-builder'].addEventListener('click', e => { if (e.target.classList.contains('remove-participant')) e.target.closest('.participant-row').remove(); });
    els['flow-add-participant'].addEventListener('click', () => addParticipantRow(els['flow-builder']));
    els['flow-builder'].addEventListener('click', e => { if (e.target.classList.contains('remove-participant')) e.target.closest('.participant-row').remove(); });
    els['save-flow'].addEventListener('click', saveFlow);
    els['profile-form'].addEventListener('submit', updateProfile);
    ['profile-name','profile-department','profile-phone'].forEach(id => byId(id).addEventListener('input', saveProfileDraft));
    els['add-field'].addEventListener('click', addPreparedField);
    els['prepare-save'].addEventListener('click', () => savePreparedFields(false));
    els['prepare-save-submit'].addEventListener('click', () => savePreparedFields(true));
    els['prepare-prev-page'].addEventListener('click', () => { if(state.prepare && state.prepare.page>1){state.prepare.page--;renderPreparePage();} });
    els['prepare-next-page'].addEventListener('click', () => { if(state.prepare && state.prepare.page<state.prepare.pageCount){state.prepare.page++;renderPreparePage();} });
    els['prepare-zoom-in'].addEventListener('click', () => { if(state.prepare){state.prepare.zoom=Math.min(2,state.prepare.zoom+.15);renderPreparePage();} });
    els['prepare-zoom-out'].addEventListener('click', () => { if(state.prepare){state.prepare.zoom=Math.max(.6,state.prepare.zoom-.15);renderPreparePage();} });
    ['selected-field-assignee','selected-field-type','selected-field-label','selected-field-required'].forEach(id => byId(id).addEventListener(id==='selected-field-label'?'input':'change', updateSelectedPreparedField));
    els['delete-field'].addEventListener('click', deletePreparedField);
    els['finish-signing'].addEventListener('click', finishVisualSigning);
    els['next-required-field'].addEventListener('click', nextRequiredField);
    els['clear-signature'].addEventListener('click', clearCanvas);
    els['save-signature'].addEventListener('click', saveSignature);
    els['refresh-users'].addEventListener('click', async () => { await run(async () => { await loadProfiles(); renderAdminUsers(); }, 'Lista actualizada.'); });

    document.addEventListener('click', async e => {
      const open = e.target.closest('[data-open-document]'); if (open) return openDocument(open.dataset.openDocument);
      const dl = e.target.closest('[data-download-path]'); if (dl) return downloadPrivate(dl.dataset.downloadPath, dl.dataset.downloadName);
      const replace = e.target.closest('[data-replace-document]'); if (replace) return replaceDocumentFile(replace.dataset.replaceDocument);
      const flow = e.target.closest('[data-configure-flow]'); if (flow) return configureFlow(flow.dataset.configureFlow);
      const prepare = e.target.closest('[data-prepare-document]'); if (prepare) return openPrepareDocument(prepare.dataset.prepareDocument);
      const submit = e.target.closest('[data-submit-document]'); if (submit) return submitDocument(submit.dataset.submitDocument);
      const approve = e.target.closest('[data-approve-document]'); if (approve) return actOnDocument(approve.dataset.approveDocument, 'approve');
      const reject = e.target.closest('[data-reject-document]'); if (reject) return actOnDocument(reject.dataset.rejectDocument, 'reject');
      const sign = e.target.closest('[data-sign-document]'); if (sign) return signDocument(sign.dataset.signDocument);
      const revoke = e.target.closest('[data-revoke-signature]'); if (revoke) return revokeSignature(revoke.dataset.revokeSignature);
      const saveUser = e.target.closest('[data-save-user]'); if (saveUser) return updateAdminUser(saveUser.dataset.saveUser);
    });

    const canvas = els['signature-canvas'];
    canvas.addEventListener('pointerdown', e => {
      state.signatureDrawing = true; canvas.setPointerCapture(e.pointerId);
      const p = canvasPoint(e); const ctx = canvas.getContext('2d'); ctx.beginPath(); ctx.moveTo(p.x, p.y);
    });
    canvas.addEventListener('pointermove', e => {
      if (!state.signatureDrawing) return;
      const p = canvasPoint(e); const ctx = canvas.getContext('2d'); ctx.lineTo(p.x, p.y); ctx.stroke(); canvas.dataset.hasInk = '1';
    });
    ['pointerup','pointercancel','pointerleave'].forEach(type => canvas.addEventListener(type, () => { state.signatureDrawing = false; }));
    window.addEventListener('resize', () => { if (!byId('section-profile').classList.contains('hidden')) prepareCanvas(); });
    window.addEventListener('beforeunload', e => { if(state.profileDirty){e.preventDefault();e.returnValue='';} });
  }

  async function handleRecoveryEvent(event) {
    if (event !== 'PASSWORD_RECOVERY') return;
    const password = prompt('Escribe tu nueva contraseña (mínimo 10 caracteres):');
    if (!password || password.length < 10) return toast('La contraseña no fue modificada.', true);
    const { error } = await client.auth.updateUser({ password });
    if (error) toast(error.message, true); else toast('Contraseña actualizada.');
  }

  async function init() {
    cacheElements();
    bindEvents();
    addParticipantRow(els['participants-builder'], { participant_role: 'approver', sequence: 1 });
    addParticipantRow(els['participants-builder'], { participant_role: 'signer', sequence: 1 });
    client.auth.onAuthStateChange((event, session) => {
      setTimeout(async () => {
        try { await handleRecoveryEvent(event); if(event==='TOKEN_REFRESHED'||event==='USER_UPDATED'){state.session=session;return;} await handleSession(session); }
        catch (error) { console.error(error); toast(error.message || 'Error de sesión.', true); }
      }, 0);
    });
    window.addEventListener('unhandledrejection', event => {
      const message = event.reason?.message || 'Ocurrió un error inesperado.';
      console.error(event.reason); toast(message, true);
    });
    const { data } = await client.auth.getSession();
    if (data.session) await handleSession(data.session); else showAuth();
  }

  init().catch(error => { console.error(error); toast(error.message || 'No se pudo iniciar la aplicación.', true); });
})();
