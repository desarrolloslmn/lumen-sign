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
  const APP_VERSION = '7.3.0-firma-guiada-password-mfa-consentimiento';
  const CONSENT_VERSION = 'LS-2026-06';
  const CONSENT_TEXT = 'Declaro que revisé el documento y acepto firmarlo electrónicamente. Comprendo que mi firma, la fecha, el documento y su hash quedarán registrados como evidencia.';
  const state = {
    session: null,
    profile: null,
    profiles: [],
    documents: [],
    myParticipantRows: [],
    documentHistory: [],
    tasks: [],
    signatures: [],
    appliedSignatures: [],
    activeDocumentId: null,
    flowDocumentId: null,
    signatureDrawing: false,
    profileDirty: false, loadedUserId: null, sessionLoadPromise: null,
    prepare: null, signing: null, preview: null,
    workflowCandidates: [], wizardStep: 1,
    notifications: [], conversations: [], activeConversationId: null, activeConversationMembers: [],
    chatChannel: null, chatInboxChannel: null, notificationChannel: null, workflowChannel: null, membershipChannel: null,
    liveSyncTimer: null, reminderTimer: null, liveRefreshTimer: null, realtimeConnected: false,
    passwordResetEmail: '', passwordResetActive: false,
    emailSystemStatus: null, emailDeliveries: [], templates: [], adminDashboard: null, pendingSignConfirmation: null, selectedTemplateFields: [], forcePasswordChangeActive: false, mfaRequiredActive: false, signReauthActive: false, mfa: { factorId: null, challengeId: null, mode: null, enrollment: null }
  };

  const els = {};
  const byId = (id) => document.getElementById(id);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

  function numberInputValue(id, fallback) {
    const input = byId(id);
    if (!input) return Number(fallback);
    const value = Number(input.value);
    return Number.isFinite(value) ? value : Number(fallback);
  }

  function setInputValue(id, value) {
    const input = byId(id);
    if (input) input.value = String(value);
  }
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
    completed: 'Completado', rejected: 'Rechazado', cancelled: 'Cancelado', paused: 'Pausado', expired: 'Vencido',
    approved: 'Aprobado', signed: 'Firmado', ready: 'Listo', processing: 'Procesando', failed: 'Fallido'
  };
  const participantRoleLabels = { editor: 'Editor', approver: 'Aprobador', signer: 'Firmante', viewer: 'Consulta' };

  function cacheElements() {
    [
      'auth-view','app-view','login-form','register-form','forgot-password','logout-button','admin-nav',
      'reset-panel','reset-request-form','reset-confirm-form','reset-email','reset-sent-note','reset-panel-description','reset-password','reset-password-confirm','reset-back-login','reset-password-toggle','reset-password-confirm-toggle',
      'login-password-toggle','register-password-toggle','sidebar-user','user-status-pill','pending-banner',
      'next-action-card','stats-grid','recent-documents','documents-table','document-search','document-status-filter','history-search','history-action-filter','history-summary','history-table',
      'new-document-form','wizard-steps','wizard-back','wizard-next','wizard-create','wizard-message','wizard-review',
      'approval-stage','approvers-builder','signers-builder','add-approver','add-signer',
      'tasks-table','profile-onboarding','profile-form','signature-canvas','clear-signature','save-signature','signature-list','signed-history-table',
      'admin-users-table','refresh-users','document-dialog','document-detail','flow-dialog','flow-approval-stage',
      'flow-approvers-builder','flow-signers-builder','flow-add-approver','flow-add-signer','save-flow',
      'menu-button','menu-overlay','main-nav','page-title','page-subtitle','toast',
      'task-pending-badge','message-unread-badge','notification-unread-badge','sidebar-reminder','sidebar-reminder-title','sidebar-reminder-text','sidebar-reminder-action','live-status',
      'new-conversation','conversation-list','chat-header','chat-messages','chat-form','chat-input','conversation-dialog','conversation-form','conversation-title','conversation-members','notifications-list','mark-all-notifications',
      'prepare-dialog','prepare-save','prepare-save-submit','field-assignee','field-type','field-label','field-required',
      'selected-field-panel','selected-field-assignee','selected-field-type','selected-field-label','selected-field-required','delete-field',
      'prepare-pages','prepare-page-number','prepare-page-count','prepare-prev-page','prepare-next-page','prepare-zoom-in','prepare-zoom-out','prepare-zoom-label',
      'sign-dialog','sign-pages','finish-signing','sign-progress','next-required-field',
      'preview-dialog','preview-title','preview-pages','preview-page-number','preview-page-count','preview-prev-page','preview-next-page','preview-zoom-in','preview-zoom-out','preview-zoom-label','preview-back-document','preview-download',
      'doc-due-days','doc-first-reminder-hours','doc-repeat-reminder-hours','refresh-email-status','email-system-status','email-delivery-list',
      'document-template','approval-routing','signature-routing','save-template-button','template-dialog','template-form','template-name','template-description','template-list','refresh-templates',
      'admin-dashboard','refresh-admin-dashboard','flow-approval-routing','flow-signature-routing','sign-confirm-dialog','sign-confirm-form','sign-confirm-password','sign-confirm-password-toggle','sign-confirm-mfa-code','sign-confirm-error','sign-confirm-security-note','sign-consent',
      'force-password-dialog','force-password-form','force-current-password','force-new-password','force-confirm-password','force-current-password-toggle','force-new-password-toggle','force-confirm-password-toggle','force-password-logout',
      'mfa-setup-dialog','mfa-setup-form','mfa-qr','mfa-secret','mfa-setup-code','mfa-setup-error','mfa-setup-logout','mfa-verify-dialog','mfa-verify-form','mfa-verify-code','mfa-verify-error','mfa-verify-logout','mfa-verify-retry'
    ].forEach(id => els[id] = byId(id));
    byId('max-file-label').textContent = String(MAX_FILE_MB);
  }

  function toast(message, error = false) {
    els.toast.textContent = message;
    els.toast.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.className = 'toast', 3800);
  }


  function mfaInputId(mode) {
    return mode === 'setup' ? 'mfa-setup-code' : 'mfa-verify-code';
  }

  function mfaErrorId(mode) {
    return mode === 'setup' ? 'mfa-setup-error' : 'mfa-verify-error';
  }

  function ensureMfaErrorElement(mode) {
    const id = mfaErrorId(mode);
    let box = byId(id);
    if (box) {
      els[id] = box;
      return box;
    }

    const formId = mode === 'setup' ? 'mfa-setup-form' : 'mfa-verify-form';
    const input = byId(mfaInputId(mode));
    const form = byId(formId);
    if (!form) return null;

    box = document.createElement('div');
    box.id = id;
    box.className = 'mfa-inline-error hidden';
    box.setAttribute('role', 'alert');
    box.setAttribute('aria-live', 'assertive');

    const label = input?.closest('label');
    if (label) label.insertAdjacentElement('afterend', box);
    else form.prepend(box);
    els[id] = box;
    return box;
  }

  function clearMfaInlineError(mode) {
    const id = mfaErrorId(mode);
    const box = byId(id);
    if (box) {
      box.textContent = '';
      box.classList.add('hidden');
    }
    const input = byId(mfaInputId(mode));
    if (input) {
      input.classList.remove('input-error');
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }

  function showMfaInlineError(mode, message) {
    const id = mfaErrorId(mode);
    const box = ensureMfaErrorElement(mode);
    const input = byId(mfaInputId(mode));
    if (box) {
      box.textContent = message;
      box.classList.remove('hidden');
    }
    if (input) {
      input.value = '';
      input.classList.add('input-error');
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', id);
      setTimeout(() => input.focus(), 60);
    }
  }

  function mfaFriendlyError(error) {
    const raw = String(error?.message || error || '').trim();
    const text = raw.toLowerCase();
    if (
      !raw ||
      error?.status === 400 ||
      text.includes('invalid') ||
      text.includes('expired') ||
      text.includes('challenge') ||
      text.includes('factor') ||
      text.includes('verification') ||
      text.includes('code') ||
      text.includes('otp') ||
      text.includes('totp')
    ) {
      return 'Código incorrecto o vencido. Abre tu app autenticadora y escribe el código actual de 6 dígitos.';
    }
    return raw;
  }


  function ensureSignConfirmSecurityFields() {
    const form = byId('sign-confirm-form');
    if (!form) return;

    const consent = byId('sign-consent')?.closest('label');
    const submit = form.querySelector('button[type="submit"]');

    let mfaLabel = byId('sign-confirm-mfa-label');
    if (!mfaLabel) {
      mfaLabel = document.createElement('label');
      mfaLabel.id = 'sign-confirm-mfa-label';
      mfaLabel.className = 'sign-mfa-label';
      mfaLabel.innerHTML = `Código del autenticador
        <input id="sign-confirm-mfa-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required />
        <span class="hint">Abre tu app autenticadora y escribe el código actual de 6 dígitos.</span>`;
      if (consent) consent.insertAdjacentElement('beforebegin', mfaLabel);
      else form.insertBefore(mfaLabel, submit || null);
    }

    let note = byId('sign-confirm-security-note');
    if (!note) {
      note = document.createElement('div');
      note.id = 'sign-confirm-security-note';
      note.className = 'security-note sign-security-note';
      note.innerHTML = '<strong>Firma reforzada:</strong> se validará contraseña, código MFA y consentimiento antes de registrar la firma.';
      if (consent) consent.insertAdjacentElement('beforebegin', note);
      else form.insertBefore(note, submit || null);
    }

    let box = byId('sign-confirm-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'sign-confirm-error';
      box.className = 'sign-inline-error hidden';
      box.setAttribute('role', 'alert');
      box.setAttribute('aria-live', 'assertive');
      form.insertBefore(box, submit || null);
    }

    els['sign-confirm-mfa-code'] = byId('sign-confirm-mfa-code');
    els['sign-confirm-security-note'] = note;
    els['sign-confirm-error'] = box;
  }

  function clearSignConfirmError() {
    const box = byId('sign-confirm-error');
    if (box) {
      box.textContent = '';
      box.classList.add('hidden');
    }
    ['sign-confirm-password','sign-confirm-mfa-code','sign-consent'].forEach(id => {
      const input = byId(id);
      if (!input) return;
      input.classList.remove('input-error');
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    });
  }

  function showSignConfirmError(target, message) {
    ensureSignConfirmSecurityFields();
    const box = byId('sign-confirm-error');
    const targetId = target === 'password' ? 'sign-confirm-password'
      : target === 'mfa' ? 'sign-confirm-mfa-code'
      : target === 'consent' ? 'sign-consent'
      : '';
    const input = targetId ? byId(targetId) : null;

    if (box) {
      box.textContent = message;
      box.classList.remove('hidden');
    }
    if (input) {
      if (target === 'password' || target === 'mfa') input.value = '';
      input.classList.add('input-error');
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'sign-confirm-error');
      setTimeout(() => input.focus(), 60);
    }
  }

  function resetSignConfirmForm() {
    ensureSignConfirmSecurityFields();
    byId('sign-confirm-form')?.reset();
    clearSignConfirmError();
  }

  async function verifyMfaForSigning(code) {
    const verifiedFactors = await getVerifiedTotpFactors();
    const factor = verifiedFactors[0];
    if (!factor?.id) {
      throw new Error('No hay un autenticador MFA verificado en esta cuenta. Cierra sesión, vuelve a entrar y configura MFA antes de firmar.');
    }

    const challenge = await client.auth.mfa.challenge({ factorId: factor.id });
    if (challenge.error) throw challenge.error;

    const { error } = await client.auth.mfa.verify({
      factorId: factor.id,
      challengeId: challenge.data.id,
      code
    });
    if (error) throw error;

    const { data } = await client.auth.getSession();
    state.session = data.session || state.session;
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
    const cls = ['completed','approved','signed','active','ready'].includes(value) ? 'success'
      : ['rejected','cancelled','suspended','expired','failed'].includes(value) ? 'danger'
      : ['pending','awaiting_approval','awaiting_signature','paused','processing'].includes(value) ? 'warning' : '';
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

  function openMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar || window.matchMedia('(min-width: 901px)').matches) return;
    sidebar.classList.add('open');
    document.body.classList.add('menu-open');
    els['menu-overlay']?.classList.remove('hidden');
    els['menu-button']?.setAttribute('aria-expanded', 'true');
  }

  function closeMobileMenu() {
    document.querySelector('.sidebar')?.classList.remove('open');
    document.body.classList.remove('menu-open');
    els['menu-overlay']?.classList.add('hidden');
    els['menu-button']?.setAttribute('aria-expanded', 'false');
  }

  function toggleMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    if (sidebar?.classList.contains('open')) closeMobileMenu();
    else openMobileMenu();
  }

  function switchAuthTab(tab) {
    els['reset-panel'].classList.add('hidden');
    qsa('[data-auth-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.authTab === tab));
    els['login-form'].classList.toggle('hidden', tab !== 'login');
    if (els['register-form']) els['register-form'].classList.toggle('hidden', tab !== 'register');
    document.querySelector('.tabs')?.classList.remove('hidden');
  }

  function showResetPanel(email = '', mode = 'request') {
    qsa('[data-auth-tab]').forEach(btn => btn.classList.remove('active'));
    els['login-form'].classList.add('hidden');
    if (els['register-form']) els['register-form'].classList.add('hidden');
    document.querySelector('.tabs')?.classList.add('hidden');
    els['reset-panel'].classList.remove('hidden');

    const isConfirm = mode === 'confirm';
    els['reset-request-form'].classList.toggle('hidden', isConfirm);
    els['reset-confirm-form'].classList.toggle('hidden', !isConfirm);
    els['reset-panel-description'].textContent = isConfirm
      ? 'El enlace fue validado. Crea una contraseña nueva para recuperar tu cuenta.'
      : 'Te enviaremos un enlace seguro por correo. Al abrirlo volverás aquí para crear una contraseña nueva.';

    if (els['reset-sent-note']) els['reset-sent-note'].classList.add('hidden');
    if (email) byId('reset-email').value = email;
    if (isConfirm) setTimeout(() => byId('reset-password')?.focus(), 50);
  }

  function recoveryLinkDetected() {
    const value = `${location.search || ''}&${location.hash || ''}`;
    return /(?:^|[?&#])type=recovery(?:&|$)/i.test(value);
  }

  async function loadProtectedAppData() {
    if (!state.session || !state.profile) return;
    await Promise.all([
      loadProfiles(), loadWorkflowCandidates(), loadTemplates(), loadSignatures(), loadDocuments(),
      loadTasks(), loadAppliedSignatures(), loadNotifications(), loadConversations(),
      loadEmailSystemStatus(), loadAdminDashboard()
    ]);
    renderAll();
    startLiveSync();
    state.loadedUserId = state.session.user.id;
  }

  async function handleSession(session, force = false) {
    state.session = session;
    if (!session) {
      state.profile = null; state.loadedUserId = null; state.profiles = []; state.documents = [];
      state.tasks = []; state.signatures = []; state.appliedSignatures = []; state.notifications = []; state.conversations = []; state.activeConversationId = null;
      clearForcePasswordDialog(); clearMfaDialogs(); stopLiveSync();
      showAuth(); return;
    }
    const userId = session.user.id;
    if (!force && state.loadedUserId === userId && state.profile) {
      showApp();
      if (state.profile?.must_change_password) { showForcePasswordDialog(); return; }
      if (!(await enforceMfaForAll())) return;
      return;
    }
    if (state.sessionLoadPromise) return state.sessionLoadPromise;
    state.sessionLoadPromise = (async () => {
      stopLiveSync();
      await loadProfile(); showApp(); configureAppForProfile();
      if (state.profile?.must_change_password) { showForcePasswordDialog(); state.loadedUserId = userId; return; }
      if (!(await enforceMfaForAll())) { state.loadedUserId = userId; return; }
      await loadProtectedAppData();
    })();
    try { await state.sessionLoadPromise; } finally { state.sessionLoadPromise = null; }
  }


  async function loadProfile() {
    const { data, error } = await client.from('profiles').select('*').eq('id', state.session.user.id).single();
    if (error) throw error;
    state.profile = data;
  }

  async function loadProfiles() {
    const { data, error } = await client.from('profiles')
      .select('id,email,full_name,department,role,status,created_at')
      .order('full_name');
    if (error) throw error;
    state.profiles = data || [];
  }

  async function loadWorkflowCandidates() {
    const { data, error } = await client.rpc('list_workflow_candidates');
    if (error) {
      console.warn('No se pudo cargar list_workflow_candidates; se usará la lista básica.', error);
      state.workflowCandidates = state.profiles
        .filter(profile => profile.status === 'active')
        .map(profile => ({ ...profile, has_signature: false }));
    } else {
      state.workflowCandidates = data || [];
    }
    refreshGuidedUserOptions();
  }

  function refreshGuidedUserOptions() {
    qsa('.ordered-user').forEach(select => {
      const role = select.dataset.participantRole;
      const selected = select.value;
      select.innerHTML = candidateOptions(role, selected);
      if (selected) select.value = selected;
    });
  }

  async function loadTemplates() {
    const { data, error } = await client.rpc('list_document_templates');
    if (error) {
      console.warn('No se pudieron cargar las plantillas.', error);
      state.templates = [];
    } else {
      state.templates = data || [];
    }
    renderTemplateOptions();
  }

  async function loadAdminDashboard() {
    if (!isAdmin()) { state.adminDashboard = null; return; }
    const { data, error } = await client.rpc('get_admin_dashboard');
    if (error) throw error;
    state.adminDashboard = data || {};
  }

  function renderTemplateOptions() {
    if (!els['document-template']) return;
    const selected = els['document-template'].value;
    els['document-template'].innerHTML = '<option value="">Crear sin plantilla</option>' + state.templates.map(template => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join('');
    if (state.templates.some(template => template.id === selected)) els['document-template'].value = selected;
  }

  function renderTemplateList() {
    if (!els['template-list']) return;
    if (!state.templates.length) {
      els['template-list'].innerHTML = '<div class="empty">Todavía no hay plantillas guardadas.</div>';
      return;
    }
    els['template-list'].innerHTML = `<div class="template-grid">${state.templates.map(template => `<article class="template-card"><div><strong>${escapeHtml(template.name)}</strong><p class="muted small">${escapeHtml(template.description || 'Sin descripción')}</p><p class="small">${template.workflow_mode === 'signature_only' ? 'Solo firmas' : 'Aprobación y firmas'} · ${template.signature_routing === 'parallel' ? 'Firmas en paralelo' : 'Firmas en orden'}</p></div>${isAdmin() || isContracts() ? `<button class="danger" data-delete-template="${template.id}" type="button">Desactivar</button>` : ''}</article>`).join('')}</div>`;
  }

  function renderAdminDashboard() {
    if (!els['admin-dashboard']) return;
    const data = state.adminDashboard || {};
    const cards = [
      ['Documentos', data.documents_total ?? 0],
      ['En aprobación', data.awaiting_approval ?? 0],
      ['En firma', data.awaiting_signature ?? 0],
      ['Vencidos', data.overdue ?? 0],
      ['Pausados', data.paused ?? 0],
      ['Correos fallidos', data.emails_failed ?? 0],
      ['Usuarios activos', data.active_users ?? 0],
      ['Promedio de cierre', `${data.avg_completion_hours ?? 0} h`]
    ];
    els['admin-dashboard'].innerHTML = cards.map(([label,value]) => `<div class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  }

  async function loadDocuments() {
    if (!isActive()) { state.documents = []; return; }
    const { data, error } = await client.from('documents').select('*').order('updated_at', { ascending: false });
    if (error) throw error;
    state.documents = data || [];
  }

  async function loadMyParticipation() {
    if (!isActive()) { state.myParticipantRows = []; return; }
    const { data, error } = await client.from('document_participants')
      .select('id,document_id,participant_role,action_status,acted_at,sequence')
      .eq('user_id', state.session.user.id)
      .order('sequence', { ascending: true });
    if (error) throw error;
    state.myParticipantRows = data || [];
  }

  async function loadDocumentHistory() {
    if (!isActive()) { state.documentHistory = []; return; }
    const { data, error } = await client.from('audit_events')
      .select('id,document_id,actor_id,action,metadata,created_at,documents(id,title,status,owner_id)')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw error;
    state.documentHistory = (data || []).filter(item => item.documents);
  }

  function myDocumentIds() {
    const ids = new Set();
    state.documents.forEach(document => {
      if (document.owner_id === state.session?.user?.id) ids.add(document.id);
    });
    state.myParticipantRows.forEach(row => ids.add(row.document_id));
    return ids;
  }

  function myDocuments() {
    const ids = myDocumentIds();
    return state.documents.filter(document => ids.has(document.id));
  }

  function myDocumentRoles(documentId) {
    const roles = [];
    const doc = state.documents.find(item => item.id === documentId);
    if (doc?.owner_id === state.session?.user?.id) roles.push('Propietario');
    state.myParticipantRows
      .filter(row => row.document_id === documentId)
      .forEach(row => {
        const label = participantRoleLabels[row.participant_role] || row.participant_role;
        if (!roles.includes(label)) roles.push(label);
      });
    return roles;
  }

  async function loadTasks() {
    if (!isActive()) { state.tasks = []; return; }
    const { data, error } = await client.from('document_participants')
      .select('id,document_id,participant_role,sequence,action_status,documents(id,title,status,category,updated_at)')
      .eq('user_id', state.session.user.id)
      .eq('action_status', 'pending')
      .in('participant_role', ['approver','signer'])
      .order('sequence');
    if (error) throw error;
    const mine = (data || []).filter(item => item.documents);
    const ids = [...new Set(mine.map(item => item.document_id))];
    let allPending = [];
    if (ids.length) {
      const response = await client.from('document_participants')
        .select('document_id,participant_role,sequence,action_status')
        .in('document_id', ids)
        .eq('action_status', 'pending')
        .in('participant_role', ['approver','signer']);
      if (response.error) throw response.error;
      allPending = response.data || [];
    }
    state.tasks = mine.map(task => {
      const expectedRole = task.documents.status === 'awaiting_approval' ? 'approver'
        : task.documents.status === 'awaiting_signature' ? 'signer' : null;
      const stageRows = allPending.filter(row => row.document_id === task.document_id && row.participant_role === expectedRole);
      const minSequence = stageRows.length ? Math.min(...stageRows.map(row => Number(row.sequence))) : null;
      const isActionable = task.participant_role === expectedRole && Number(task.sequence) === minSequence;
      const waitingReason = task.documents.status === 'paused' ? 'El proceso está pausado por el propietario o un administrador.'
        : task.documents.status === 'cancelled' ? 'El proceso fue cancelado.'
        : expectedRole !== task.participant_role
          ? (expectedRole === 'approver' ? 'La aprobación todavía no termina.' : 'La firma todavía no inicia.')
          : !isActionable ? 'Otra persona debe actuar antes que tú.' : '';
      return { ...task, is_actionable: isActionable, waiting_reason: waitingReason };
    });
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


  async function loadNotifications() {
    if (!isActive()) { state.notifications = []; return; }
    const { data, error } = await client.from('notifications')
      .select('*')
      .eq('user_id', state.session.user.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    state.notifications = data || [];
  }

  async function loadConversations() {
    if (!isActive()) { state.conversations = []; return; }
    const { data, error } = await client.rpc('list_conversations');
    if (error) throw error;
    state.conversations = data || [];
  }

  function setLiveStatus(status = 'connected') {
    if (!els['live-status']) return;
    els['live-status'].classList.toggle('disconnected', status === 'disconnected');
    els['live-status'].classList.toggle('syncing', status === 'syncing');
    const label = status === 'disconnected' ? 'Reconectando actualizaciones…'
      : status === 'syncing' ? 'Actualizando…'
      : 'Actualizaciones en vivo';
    const text = els['live-status'].querySelector('span:last-child');
    if (text) text.textContent = label;
  }

  function queueLiveRefresh(reason = 'realtime') {
    clearTimeout(state.liveRefreshTimer);
    state.liveRefreshTimer = setTimeout(() => {
      syncLiveData(reason).catch(error => {
        console.error('No se pudo sincronizar en vivo:', error);
        setLiveStatus('disconnected');
      });
    }, 250);
  }

  async function syncLiveData(reason = 'poll') {
    if (!state.session || !state.profile || !isActive()) return;
    setLiveStatus('syncing');

    const previousActionable = new Set(
      state.tasks.filter(task => task.is_actionable).map(task => task.document_id)
    );
    const previousUnreadMessages = state.conversations.reduce((sum, item) => sum + Number(item.unread_count || 0), 0);
    const previousUnreadNotifications = state.notifications.filter(item => !item.read_at).length;

    await Promise.all([
      loadDocuments(),
      loadTasks(),
      loadNotifications(),
      loadConversations()
    ]);

    renderDashboard();
    renderDocuments();
    renderDocumentHistory();
    renderTasks();
    renderNotifications();
    renderConversations();
    updateUnreadBadges();

    const newActionable = state.tasks.find(task => task.is_actionable && !previousActionable.has(task.document_id));
    const unreadMessages = state.conversations.reduce((sum, item) => sum + Number(item.unread_count || 0), 0);
    const unreadNotifications = state.notifications.filter(item => !item.read_at).length;

    if (reason !== 'initial') {
      if (newActionable) {
        const action = newActionable.participant_role === 'approver' ? 'aprobar' : 'firmar';
        toast(`Nueva tarea: ${newActionable.documents.title}. Es tu turno de ${action}.`);
      } else if (unreadMessages > previousUnreadMessages) {
        toast('Tienes un mensaje nuevo.');
      } else if (unreadNotifications > previousUnreadNotifications) {
        toast('Tienes una nueva notificación.');
      }
    }

    setLiveStatus('connected');
  }

  function subscribeToNotifications() {
    if (!state.session || state.notificationChannel) return;
    state.notificationChannel = client.channel(`notifications:${state.session.user.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'notifications',
        filter: `user_id=eq.${state.session.user.id}`
      }, () => queueLiveRefresh('notification'))
      .subscribe(status => {
        if (status === 'SUBSCRIBED') setLiveStatus('connected');
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setLiveStatus('disconnected');
      });
  }

  function subscribeToChatInbox() {
    if (!state.session || state.chatInboxChannel) return;
    state.chatInboxChannel = client.channel(`chat-inbox:${state.session.user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, payload => {
        if (payload.new?.sender_id === state.session.user.id) return;
        queueLiveRefresh('message');
      })
      .subscribe(status => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setLiveStatus('disconnected');
      });
  }

  function subscribeToWorkflow() {
    if (!state.session || state.workflowChannel) return;
    state.workflowChannel = client.channel(`workflow:${state.session.user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'document_participants' }, () => queueLiveRefresh('workflow'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'documents' }, () => queueLiveRefresh('workflow'))
      .subscribe(status => {
        if (status === 'SUBSCRIBED') setLiveStatus('connected');
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setLiveStatus('disconnected');
      });
  }

  function subscribeToMemberships() {
    if (!state.session || state.membershipChannel) return;
    state.membershipChannel = client.channel(`memberships:${state.session.user.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'conversation_members',
        filter: `user_id=eq.${state.session.user.id}`
      }, () => queueLiveRefresh('message'))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, () => queueLiveRefresh('message'))
      .subscribe(status => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setLiveStatus('disconnected');
      });
  }

  function showPendingReminder() {
    if (!state.session || !isActive() || document.hidden) return;
    const task = state.tasks.find(item => item.is_actionable);
    if (!task) return;
    const action = task.participant_role === 'approver' ? 'aprobar o rechazar' : 'firmar';
    toast(`Recordatorio: “${task.documents.title}” sigue pendiente de ${action}.`);
  }

  function startLiveSync() {
    subscribeToNotifications();
    subscribeToChatInbox();
    subscribeToWorkflow();
    subscribeToMemberships();

    clearInterval(state.liveSyncTimer);
    state.liveSyncTimer = setInterval(() => queueLiveRefresh('poll'), 30000);

    clearInterval(state.reminderTimer);
    state.reminderTimer = setInterval(showPendingReminder, 5 * 60 * 1000);

    setLiveStatus('connected');
  }

  function stopLiveSync() {
    clearTimeout(state.liveRefreshTimer);
    clearInterval(state.liveSyncTimer);
    clearInterval(state.reminderTimer);
    state.liveRefreshTimer = null;
    state.liveSyncTimer = null;
    state.reminderTimer = null;

    ['chatChannel','notificationChannel','chatInboxChannel','workflowChannel','membershipChannel'].forEach(key => {
      if (state[key]) client.removeChannel(state[key]);
      state[key] = null;
    });
    setLiveStatus('disconnected');
  }


  function configureAppForProfile(forceProfileForm = false) {
    const p = state.profile;
    els['sidebar-user'].innerHTML = `<strong>${escapeHtml(p.full_name || p.email)}</strong><br>${escapeHtml(roleLabels[p.role] || p.role)}`;
    els['user-status-pill'].outerHTML = `<span id="user-status-pill" class="pill ${p.status === 'active' ? 'success' : 'warning'}">${escapeHtml(statusLabels[p.status] || p.status)}</span>`;
    els['user-status-pill'] = byId('user-status-pill');
    els['pending-banner'].classList.toggle('hidden', p.status === 'active');
    els['admin-nav'].classList.toggle('hidden', !isAdmin());
    qsa('[data-section="new-document"], [data-section="tasks"], [data-section="messages"], [data-section="notifications"]').forEach(btn => btn.disabled = !isActive());
    if (els['save-template-button']) els['save-template-button'].classList.toggle('hidden', !(isAdmin() || isContracts()));
    fillProfileForm(forceProfileForm);
  }


  async function loadEmailSystemStatus() {
    if (!isAdmin()) { state.emailSystemStatus = null; state.emailDeliveries = []; return; }
    const [statusResponse, deliveriesResponse] = await Promise.all([
      client.rpc('get_email_system_status'),
      client.rpc('list_recent_email_deliveries', { p_limit: 40 })
    ]);
    if (statusResponse.error) {
      console.warn('No se pudo cargar el estado del correo.', statusResponse.error);
      state.emailSystemStatus = null;
    } else state.emailSystemStatus = statusResponse.data || null;
    if (deliveriesResponse.error) {
      console.warn('No se pudo cargar el historial de correo.', deliveriesResponse.error);
      state.emailDeliveries = [];
    } else state.emailDeliveries = deliveriesResponse.data || [];
  }

  function renderEmailSystemStatus() {
    if (!isAdmin() || !els['email-system-status']) return;
    const item = state.emailSystemStatus;
    if (!item) {
      els['email-system-status'].innerHTML = '<div class="empty">Ejecuta la migración 07 y configura Gmail para ver el estado.</div>';
      if (els['email-delivery-list']) els['email-delivery-list'].innerHTML = '';
      return;
    }
    const cards = [
      ['Correos', item.emails_enabled ? 'Activos' : 'Desactivados'],
      ['Pendientes', Number(item.pending || 0)],
      ['Fallidos', Number(item.failed || 0)],
      ['Enviados 24 h', Number(item.sent_24h || 0)]
    ];
    els['email-system-status'].innerHTML = cards.map(([label,value]) => `<article class="email-status-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('');
    if (!els['email-delivery-list']) return;
    const rows = state.emailDeliveries || [];
    els['email-delivery-list'].innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Destinatario</th><th>Asunto</th><th>Estado</th><th>Intentos</th><th>Fecha</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.recipient_email)}</td><td>${escapeHtml(row.subject)}</td><td>${pill(row.status)}</td><td>${Number(row.attempts || 0)}</td><td>${fmtDate(row.sent_at || row.created_at)}</td><td>${row.status === 'failed' ? `<button class="secondary" data-retry-email="${row.id}">Reintentar</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Todavía no hay correos en la cola.</div>';
  }

  function renderAll() {
    renderDashboard();
    renderDocuments();
    renderDocumentHistory();
    renderTasks();
    renderSignatures();
    renderAppliedSignatures();
    renderOnboarding();
    renderNotifications();
    renderConversations();
    updateUnreadBadges();
    if (isAdmin()) { renderAdminUsers(); renderEmailSystemStatus(); renderAdminDashboard(); renderTemplateList(); }
  }

  function renderDashboard() {
    const myDocs = myDocuments();
    const counts = {
      total: myDocs.length,
      draft: myDocs.filter(document => document.status === 'draft').length,
      pending: state.tasks.filter(task => task.is_actionable).length,
      completed: myDocs.filter(document => document.status === 'completed').length
    };
    els['stats-grid'].innerHTML = [
      ['Documentos', counts.total, '▤'], ['Borradores', counts.draft, '○'],
      ['Tareas para mí', counts.pending, '✓'], ['Completados', counts.completed, '✓']
    ].map(([label,count,icon]) => `<article class="stat"><span class="stat-icon">${icon}</span><span class="muted">${label}</span><strong>${count}</strong></article>`).join('');

    const actionable = state.tasks.find(task => task.is_actionable);
    const draft = state.documents.find(document => document.status === 'draft' && document.owner_id === state.session.user.id);
    let next;
    if (!isActive()) {
      next = { title:'Completa tu perfil', text:'Tu correo ya está confirmado. Falta que un administrador active tu cuenta.', label:'Ir a mi perfil', action:'profile', neutral:true };
    } else if (actionable) {
      const actionText = actionable.participant_role === 'approver' ? 'aprobar o rechazar' : 'revisar y firmar';
      next = { title:`Tienes una tarea: ${actionable.documents.title}`, text:`Es tu turno de ${actionText}.`, label:'Abrir tarea', document:actionable.document_id };
    } else if (draft) {
      next = { title:`Continúa el borrador: ${draft.title}`, text:'Indica dónde debe firmar cada persona y después inicia el proceso.', label:'Continuar configuración', document:draft.id, prepare:true };
    } else if (isAdmin() || isContracts() || state.profile.role === 'user') {
      next = { title:'Todo está al día', text:'Puedes crear un documento con el asistente paso a paso.', label:'Crear documento', action:'new-document', neutral:true };
    } else {
      next = { title:'No tienes tareas pendientes', text:'Cuando un documento llegue a tu turno aparecerá aquí.', label:'Ver documentos', action:'documents', neutral:true };
    }
    els['next-action-card'].innerHTML = `<div class="next-action ${next.neutral?'neutral':''}"><div><p class="eyebrow ${next.neutral?'dark':''}">Qué sigue</p><h2>${escapeHtml(next.title)}</h2><p>${escapeHtml(next.text)}</p></div><button class="primary" ${next.document ? `data-${next.prepare?'prepare':'open'}-document="${next.document}"` : `data-go-section="${next.action}"`}>${escapeHtml(next.label)}</button></div>`;
    const recent = myDocs.slice(0, 6);
    els['recent-documents'].innerHTML = recent.length ? documentTable(recent, false) : '<div class="empty">Aún no hay documentos.</div>';
  }

  function renderOnboarding() {
    const profileComplete = Boolean((state.profile.full_name || '').trim() && (state.profile.department || '').trim());
    const needsSignature = state.profile.role === 'signer' && !state.signatures.length;
    let html = '';
    if (!profileComplete) html = `<div class="onboarding-card"><div><h3>1. Completa tu identidad</h3><p>Agrega nombre y departamento para que aparezcan correctamente en los documentos.</p></div><span class="pill warning">Pendiente</span></div>`;
    else if (state.profile.status !== 'active') html = `<div class="onboarding-card"><div><h3>2. Espera la activación</h3><p>Un administrador debe asignarte una función antes de participar.</p></div><span class="pill warning">En revisión</span></div>`;
    else if (needsSignature) html = `<div class="onboarding-card"><div><h3>3. Registra tu firma</h3><p>Tu función es Firmante. Dibuja y guarda una firma para poder completar tareas.</p></div><span class="pill warning">Requerido</span></div>`;
    else html = `<div class="onboarding-card"><div><h3>Tu cuenta está lista</h3><p>Perfil, permisos y firma están configurados.</p></div><span class="pill success">Completo</span></div>`;
    els['profile-onboarding'].innerHTML = html;
  }

  function filteredDocuments() {
    const text = (els['document-search'].value || '').trim().toLowerCase();
    const status = els['document-status-filter'].value;
    return myDocuments().filter(d => (!text || `${d.title} ${d.description || ''}`.toLowerCase().includes(text)) && (!status || d.status === status));
  }

  function renderDocuments() {
    const docs = filteredDocuments();
    els['documents-table'].innerHTML = docs.length ? documentTable(docs, true) : '<div class="empty">No se encontraron documentos.</div>';
  }

  function documentTable(docs, includeCategory = true) {
    return `<div class="table-wrap"><table><thead><tr><th>Título</th>${includeCategory ? '<th>Tipo</th>' : ''}<th>Mi participación</th><th>Estado</th><th>Versión</th><th>Actualización</th><th></th></tr></thead><tbody>
      ${docs.map(d => `<tr>
        <td><strong>${escapeHtml(d.title)}</strong><br><span class="muted small">${escapeHtml(d.active_file_name || 'Sin archivo')}</span></td>
        ${includeCategory ? `<td>${escapeHtml({contract:'Contrato',invoice:'Factura',other:'Otro'}[d.category] || d.category)}</td>` : ''}
        <td>${myDocumentRoles(d.id).map(role => `<span class="pill soft">${escapeHtml(role)}</span>`).join(' ') || '<span class="muted small">Consulta</span>'}</td>
        <td>${pill(d.status)}</td><td>v${d.current_version}</td><td>${fmtDate(d.updated_at)}</td>
        <td><button class="secondary" data-open-document="${d.id}">Ver</button></td>
      </tr>`).join('')}
    </tbody></table></div>`;
  }

  function filteredHistoryEvents() {
    const ids = myDocumentIds();
    const text = (els['history-search']?.value || '').trim().toLowerCase();
    const action = els['history-action-filter']?.value || '';
    return state.documentHistory.filter(event => {
      if (!ids.has(event.document_id)) return false;
      const haystack = `${event.documents?.title || ''} ${eventLabel(event.action)} ${profileName(event.actor_id)} ${event.metadata?.comment || ''}`.toLowerCase();
      return (!text || haystack.includes(text)) && (!action || event.action === action);
    });
  }

  function renderDocumentHistory() {
    if (!els['history-table']) return;
    const docs = myDocuments();
    const events = filteredHistoryEvents();
    const completed = docs.filter(document => document.status === 'completed').length;
    const pending = state.tasks.filter(task => task.is_actionable).length;
    els['history-summary'].innerHTML = `<div class="stats-grid compact"><article class="stat"><span class="stat-icon">▤</span><span class="muted">Mis documentos</span><strong>${docs.length}</strong></article><article class="stat"><span class="stat-icon">✓</span><span class="muted">Completados</span><strong>${completed}</strong></article><article class="stat"><span class="stat-icon">!</span><span class="muted">Tareas activas</span><strong>${pending}</strong></article><article class="stat"><span class="stat-icon">◷</span><span class="muted">Eventos visibles</span><strong>${events.length}</strong></article></div>`;
    els['history-table'].innerHTML = events.length ? `<div class="timeline document-history-list">${events.map(event => `<div class="timeline-item"><strong>${escapeHtml(eventLabel(event.action))}</strong><p><button class="link-button" type="button" data-open-document="${event.document_id}">${escapeHtml(event.documents?.title || 'Documento')}</button> · ${escapeHtml(profileName(event.actor_id))} · ${fmtDate(event.created_at)}</p>${event.metadata?.comment ? `<p>${escapeHtml(event.metadata.comment)}</p>` : ''}</div>`).join('')}</div>` : '<div class="empty">Aún no hay historial visible para tus documentos.</div>';
  }

  function renderTasks() {
    const tasks = [...state.tasks].sort((a,b) => Number(b.is_actionable)-Number(a.is_actionable));
    els['tasks-table'].innerHTML = tasks.length ? tasks.map(task => {
      const label = task.participant_role === 'approver' ? 'Aprobación' : 'Firma';
      const icon = task.participant_role === 'approver' ? '✓' : '✍';
      const buttonLabel = task.is_actionable ? (task.participant_role === 'approver' ? 'Revisar para aprobar' : 'Revisar para firmar') : 'Ver proceso';
      const orderText = task.is_actionable ? 'Es tu turno ahora' : (task.waiting_reason || 'Esperando a la persona anterior');
      return `<article class="task-card ${task.is_actionable?'actionable':''}"><div class="task-badge">${icon}</div><div><h3>${escapeHtml(task.documents.title)}</h3><div class="task-meta"><span class="pill">${label}</span>${pill(task.documents.status)}</div><p class="task-wait">${escapeHtml(orderText)}</p></div><button class="${task.is_actionable?'primary':'secondary'}" data-open-document="${task.document_id}">${buttonLabel}</button></article>`;
    }).join('') : '<div class="panel empty">No tienes tareas pendientes. El sistema te avisará cuando llegue tu turno.</div>';
  }

  function updateUnreadBadges() {
    const taskCount = state.tasks.filter(item => item.is_actionable).length;
    const notificationCount = state.notifications.filter(item => !item.read_at).length;
    const messageCount = state.conversations.reduce((sum, item) => sum + Number(item.unread_count || 0), 0);

    const badgeValues = [
      [els['task-pending-badge'], taskCount],
      [els['notification-unread-badge'], notificationCount],
      [els['message-unread-badge'], messageCount]
    ];
    badgeValues.forEach(([badge, count]) => {
      if (!badge) return;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.toggle('hidden', count === 0);
      badge.closest('.nav-item')?.classList.toggle('has-attention', count > 0);
    });

    const totalAttention = taskCount + notificationCount + messageCount;
    document.title = totalAttention ? `(${totalAttention}) Lumen Sign` : 'Lumen Sign';

    const reminder = els['sidebar-reminder'];
    if (!reminder) return;
    if (!totalAttention) {
      reminder.classList.add('hidden');
      return;
    }

    reminder.classList.remove('hidden');
    if (taskCount) {
      const first = state.tasks.find(item => item.is_actionable);
      els['sidebar-reminder-title'].textContent = `${taskCount} ${taskCount === 1 ? 'tarea requiere' : 'tareas requieren'} tu atención`;
      els['sidebar-reminder-text'].textContent = first
        ? `${first.participant_role === 'approver' ? 'Debes revisar' : 'Debes firmar'}: ${first.documents.title}`
        : 'Abre tu bandeja de tareas para continuar.';
      els['sidebar-reminder-action'].textContent = 'Abrir mis tareas';
      els['sidebar-reminder-action'].dataset.goSection = 'tasks';
    } else if (messageCount) {
      els['sidebar-reminder-title'].textContent = `${messageCount} ${messageCount === 1 ? 'mensaje nuevo' : 'mensajes nuevos'}`;
      els['sidebar-reminder-text'].textContent = 'Tienes conversaciones pendientes de leer.';
      els['sidebar-reminder-action'].textContent = 'Abrir mensajes';
      els['sidebar-reminder-action'].dataset.goSection = 'messages';
    } else {
      els['sidebar-reminder-title'].textContent = `${notificationCount} ${notificationCount === 1 ? 'notificación nueva' : 'notificaciones nuevas'}`;
      els['sidebar-reminder-text'].textContent = 'Revisa los avisos recientes del sistema.';
      els['sidebar-reminder-action'].textContent = 'Abrir notificaciones';
      els['sidebar-reminder-action'].dataset.goSection = 'notifications';
    }
  }

  function notificationIcon(kind) {
    if (kind === 'document_approval') return '✓';
    if (kind === 'document_signature') return '✍';
    if (kind === 'document_rejected') return '!';
    if (kind === 'document_completed') return '✓';
    return '🔔';
  }

  function renderNotifications() {
    const list = state.notifications;
    els['notifications-list'].innerHTML = list.length ? list.map(item => `
      <article class="notification-card ${item.read_at ? '' : 'unread'}">
        <div class="notification-icon">${notificationIcon(item.kind)}</div>
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.body)}</p>
          <time>${fmtDate(item.created_at)}</time>
        </div>
        ${item.document_id ? `<button class="secondary" data-open-notification="${item.id}" data-notification-document="${item.document_id}">Abrir documento</button>` : `<button class="secondary" data-read-notification="${item.id}">${item.read_at ? 'Leída' : 'Marcar leída'}</button>`}
      </article>
    `).join('') : '<div class="panel empty">No tienes notificaciones.</div>';
    updateUnreadBadges();
  }

  function conversationTitle(item) {
    return item.title || (item.conversation_type === 'direct' ? 'Conversación directa' : 'Grupo sin nombre');
  }

  function renderConversations() {
    const list = state.conversations;
    els['conversation-list'].innerHTML = list.length ? list.map(item => `
      <button class="conversation-item ${state.activeConversationId === item.id ? 'active' : ''}" data-open-conversation="${item.id}" type="button">
        <span class="conversation-avatar">${escapeHtml(conversationTitle(item).slice(0,1).toUpperCase())}</span>
        <span class="conversation-copy"><strong>${escapeHtml(conversationTitle(item))}</strong><span>${escapeHtml(item.latest_message || 'Sin mensajes')}</span></span>
        ${Number(item.unread_count || 0) ? `<span class="unread-dot">${Number(item.unread_count)}</span>` : ''}
      </button>
    `).join('') : '<div class="empty">Aún no tienes conversaciones.</div>';
    updateUnreadBadges();
  }

  function renderConversationMembersPicker() {
    const active = state.profiles.filter(profile => profile.status === 'active' && profile.id !== state.session.user.id);
    els['conversation-members'].innerHTML = active.length ? active.map(profile => `
      <label class="member-option">
        <input type="checkbox" value="${profile.id}" />
        <span><strong>${escapeHtml(profile.full_name || profile.email)}</strong><br><small class="muted">${escapeHtml(roleLabels[profile.role] || profile.role)} · ${escapeHtml(profile.department || 'Sin departamento')}</small></span>
      </label>
    `).join('') : '<p class="muted">No hay otros usuarios activos.</p>';
  }

  async function openConversation(id) {
    state.activeConversationId = id;
    if (state.chatChannel) { await client.removeChannel(state.chatChannel); state.chatChannel = null; }
    await run(async () => {
      const [membersRes, messagesRes] = await Promise.all([
        client.rpc('get_conversation_members', { p_conversation_id: id }),
        client.rpc('get_conversation_messages', { p_conversation_id: id, p_limit: 300 })
      ]);
      if (membersRes.error) throw membersRes.error;
      if (messagesRes.error) throw messagesRes.error;
      state.activeConversationMembers = membersRes.data || [];
      const conversation = state.conversations.find(item => item.id === id);
      const isMember = state.activeConversationMembers.some(member => member.id === state.session.user.id);
      els['chat-header'].innerHTML = `<div><h3>${escapeHtml(conversationTitle(conversation || {}))}</h3><p class="muted small">${escapeHtml(state.activeConversationMembers.map(member => member.full_name || member.email).join(', '))}${isAdmin() && !isMember ? ' · Auditoría administrativa de solo lectura' : ''}</p></div>`;
      els['chat-form'].classList.toggle('hidden', !isMember);
      renderChatMessages(messagesRes.data || []);
      if (isMember) await client.rpc('mark_conversation_read', { p_conversation_id: id });
      await loadConversations();
      renderConversations();
    });
    state.chatChannel = client.channel(`conversation:${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `conversation_id=eq.${id}` }, async () => {
        const { data, error } = await client.rpc('get_conversation_messages', { p_conversation_id: id, p_limit: 300 });
        if (!error) {
          renderChatMessages(data || []);
          if (state.activeConversationMembers.some(member => member.id === state.session.user.id)) await client.rpc('mark_conversation_read', { p_conversation_id: id });
          await loadConversations(); renderConversations();
        }
      })
      .subscribe();
  }

  function renderChatMessages(messages) {
    els['chat-messages'].innerHTML = messages.length ? messages.map(message => `
      <div class="message-row ${message.sender_id === state.session.user.id ? 'mine' : ''}">
        <div class="message-bubble">
          <strong>${escapeHtml(message.sender_name)}</strong>
          <p>${escapeHtml(message.body)}</p>
          <time>${fmtDate(message.created_at)}</time>
        </div>
      </div>
    `).join('') : '<div class="empty">Todavía no hay mensajes.</div>';
    els['chat-messages'].scrollTop = els['chat-messages'].scrollHeight;
  }

  async function createConversation(event) {
    event.preventDefault();
    const memberIds = qsa('#conversation-members input:checked').map(input => input.value);
    if (!memberIds.length) throw new Error('Selecciona por lo menos a una persona.');
    const title = byId('conversation-title').value.trim();
    if (memberIds.length > 1 && !title) throw new Error('Escribe un nombre para el grupo.');
    await run(async () => {
      const { data, error } = await client.rpc('create_conversation', { p_title: title, p_member_ids: memberIds, p_document_id: null });
      if (error) throw error;
      els['conversation-dialog'].close();
      els['conversation-form'].reset();
      await loadConversations(); renderConversations();
      await openConversation(data);
    }, 'Conversación creada.');
  }

  async function sendChatMessage(event) {
    event.preventDefault();
    const body = els['chat-input'].value.trim();
    if (!body || !state.activeConversationId) return;
    await run(async () => {
      const { error } = await client.rpc('send_chat_message', { p_conversation_id: state.activeConversationId, p_body: body });
      if (error) throw error;
      els['chat-input'].value = '';
    });
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
    if (!isActive() && ['new-document','tasks','documents','history','dashboard','messages','notifications'].includes(section)) section = 'profile';
    qsa('.page-section').forEach(s => s.classList.add('hidden'));
    byId(`section-${section}`).classList.remove('hidden');
    qsa('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.section === section));
    const titles = {
      dashboard: ['Inicio', 'Lo que requiere tu atención'], documents: ['Mis documentos', 'Expedientes donde participas o que tú creaste'], history: ['Historial', 'Movimientos de tus expedientes'],
      'new-document': ['Crear documento', 'Asistente paso a paso'], tasks: ['Mis tareas', 'Solo se habilita la acción de tu turno'],
      messages: ['Mensajes', 'Conversaciones directas y grupos de trabajo'], notifications: ['Notificaciones', 'Avisos de tareas y documentos'],
      profile: ['Perfil y firma', 'Identidad y firma registrada'], admin: ['Usuarios', 'Activa cuentas, asigna funciones y audita conversaciones']
    };
    els['page-title'].textContent = titles[section][0];
    els['page-subtitle'].textContent = titles[section][1];
    closeMobileMenu();
    if (section === 'profile') setTimeout(prepareCanvas, 50);
    if (section === 'new-document') setWizardStep(state.wizardStep || 1);
    if (section === 'messages') { loadConversations().then(renderConversations).catch(error => toast(error.message, true)); }
    if (section === 'notifications') { loadNotifications().then(renderNotifications).catch(error => toast(error.message, true)); }
    if (section === 'history') renderDocumentHistory();
    if (section === 'admin' && isAdmin()) { Promise.all([loadEmailSystemStatus(), loadAdminDashboard(), loadTemplates()]).then(() => { renderEmailSystemStatus(); renderAdminDashboard(); renderTemplateList(); }).catch(error => toast(error.message, true)); }
  }

  function allowedRolesForParticipant(role) {
    if (role === 'approver') return ['approver','contracts','admin','superadmin'];
    if (role === 'signer') return ['signer','contracts','admin','superadmin'];
    if (role === 'editor') return ['contracts','admin','superadmin'];
    return ['user','approver','signer','contracts','auditor','admin','superadmin'];
  }

  function candidateOptions(role, selected = '') {
    const allowed = allowedRolesForParticipant(role);
    const candidates = state.workflowCandidates.filter(person => person.status === 'active' && allowed.includes(person.role));
    return `<option value="">Selecciona una persona</option>${candidates.map(person => {
      const signatureNote = role === 'signer' ? (person.has_signature ? ' · firma lista' : ' · falta registrar firma') : '';
      return `<option value="${person.id}" ${person.id === selected ? 'selected' : ''}>${escapeHtml(person.full_name || person.email)} — ${escapeHtml(roleLabels[person.role] || person.role)}${signatureNote}</option>`;
    }).join('')}`;
  }

  function addOrderedParticipant(container, role, userId = '') {
    const row = document.createElement('div');
    row.className = 'ordered-row';
    row.dataset.role = role;
    row.innerHTML = `<span class="order-number">1</span><label><span class="small">${role === 'approver' ? 'Aprobador' : 'Firmante'}</span><select class="ordered-user" data-participant-role="${role}" required>${candidateOptions(role,userId)}</select><span class="candidate-note">${role === 'approver' ? 'Debe tener rol Aprobador, Contratos o Administrador.' : 'Debe tener rol Firmante, Contratos o Administrador.'}</span></label><div class="order-actions"><button class="secondary move-up" type="button" title="Subir">↑</button><button class="secondary move-down" type="button" title="Bajar">↓</button><button class="danger remove-ordered" type="button" title="Quitar">×</button></div>`;
    container.appendChild(row);
    renumberOrdered(container);
  }

  function renumberOrdered(container) {
    qsa('.ordered-row', container).forEach((row,index) => {
      row.querySelector('.order-number').textContent = String(index+1);
      row.querySelector('.move-up').disabled = index === 0;
      row.querySelector('.move-down').disabled = index === qsa('.ordered-row',container).length-1;
    });
  }

  function handleOrderedListClick(event, container) {
    const row = event.target.closest('.ordered-row');
    if (!row) return;
    if (event.target.closest('.remove-ordered')) row.remove();
    if (event.target.closest('.move-up') && row.previousElementSibling) container.insertBefore(row,row.previousElementSibling);
    if (event.target.closest('.move-down') && row.nextElementSibling) container.insertBefore(row.nextElementSibling,row);
    renumberOrdered(container);
  }

  function readOrderedParticipants(approverContainer, signerContainer, workflowMode = 'approval_signature', approvalRouting = approvalRoutingMode(), signatureRouting = signatureRoutingMode()) {
    const read = (container, role, routing) => qsa('.ordered-row', container)
      .map((row,index) => ({ user_id: row.querySelector('.ordered-user').value, participant_role: role, sequence: routing === 'parallel' ? 1 : index + 1 }))
      .filter(item => item.user_id);
    const approvers = workflowMode === 'signature_only' ? [] : read(approverContainer, 'approver', approvalRouting);
    const signers = read(signerContainer, 'signer', signatureRouting);
    return [...approvers, ...signers];
  }

  function workflowMode() {
    return document.querySelector('input[name="workflow-mode"]:checked')?.value || 'approval_signature';
  }

  function approvalRoutingMode() { return byId('approval-routing')?.value || 'sequential'; }
  function signatureRoutingMode() { return byId('signature-routing')?.value || 'sequential'; }

  function setWorkflowMode(mode) {
    qsa('.workflow-card').forEach(card => card.classList.toggle('selected', card.querySelector('input').value === mode));
    const signatureOnly = mode === 'signature_only';
    els['approval-stage'].classList.toggle('hidden', signatureOnly);
    if (!signatureOnly && !qsa('.ordered-row',els['approvers-builder']).length) addOrderedParticipant(els['approvers-builder'],'approver');
  }

  function setWizardStep(step) {
    state.wizardStep = Math.max(1,Math.min(4,Number(step)||1));
    qsa('[data-wizard-step]').forEach(panel => panel.classList.toggle('hidden', Number(panel.dataset.wizardStep)!==state.wizardStep));
    qsa('[data-step-indicator]').forEach(item => {
      const value = Number(item.dataset.stepIndicator);
      item.classList.toggle('active',value===state.wizardStep);
      item.classList.toggle('done',value<state.wizardStep);
    });
    els['wizard-back'].classList.toggle('hidden',state.wizardStep===1);
    els['wizard-next'].classList.toggle('hidden',state.wizardStep===4);
    els['wizard-create'].classList.toggle('hidden',state.wizardStep!==4);
    els['wizard-message'].textContent = `Paso ${state.wizardStep} de 4`;
    if (state.wizardStep===4) renderWizardReview();
  }

  function validateWizardStep(step) {
    if (step===1) {
      if (!byId('doc-title').value.trim()) throw new Error('Escribe el título del documento.');
      validateFile(byId('doc-file').files[0],['application/pdf'],true);
      const attachment=byId('doc-attachment').files[0]; if(attachment) validateFile(attachment,[],false);
    }
    if (step===2) {
      const dueDays = numberInputValue('doc-due-days', 10);
      if (!Number.isFinite(dueDays) || dueDays < 1 || dueDays > 365) throw new Error('Los días para completar deben estar entre 1 y 365.');
    }
    if (step===3) {
      const participants=readOrderedParticipants(els['approvers-builder'],els['signers-builder'],workflowMode());
      if (workflowMode()==='approval_signature' && !participants.some(item=>item.participant_role==='approver')) throw new Error('Agrega al menos un aprobador.');
      if (!participants.some(item=>item.participant_role==='signer')) throw new Error('Agrega al menos un firmante.');
      const seen=new Set(); for(const item of participants){const key=`${item.participant_role}:${item.user_id}`;if(seen.has(key))throw new Error('Una persona no puede repetirse dentro de la misma etapa.');seen.add(key);}
      for (const signer of participants.filter(item=>item.participant_role==='signer')) {
        const candidate=state.workflowCandidates.find(person=>person.id===signer.user_id);
        if (candidate && !candidate.has_signature) throw new Error(`${candidate.full_name||candidate.email} todavía no ha registrado una firma.`);
      }
    }
  }

  function renderWizardReview() {
    const mode=workflowMode();
    const participants=readOrderedParticipants(els['approvers-builder'],els['signers-builder'],mode);
    const approvers=participants.filter(item=>item.participant_role==='approver');
    const signers=participants.filter(item=>item.participant_role==='signer');
    const people = items => items.length ? items.map((item,index)=>`<div class="review-person"><span>${index+1}</span><div><strong>${escapeHtml(profileName(item.user_id))}</strong><small class="candidate-note">${escapeHtml(roleLabels[state.profiles.find(p=>p.id===item.user_id)?.role]||'')}</small></div></div>`).join('') : '<p class="muted">Esta etapa se omitirá.</p>';
    const dueDays = numberInputValue('doc-due-days', 10);
    const firstReminder = numberInputValue('doc-first-reminder-hours', 24);
    const repeatReminder = numberInputValue('doc-repeat-reminder-hours', 24);
    els['wizard-review'].innerHTML = `<div class="review-card"><h4>Documento</h4><p><strong>${escapeHtml(byId('doc-title').value.trim())}</strong></p><p class="muted">${escapeHtml({contract:'Contrato',invoice:'Factura',other:'Otro'}[byId('doc-category').value])}</p><p class="small">${escapeHtml(byId('doc-file').files[0]?.name||'')}</p></div><div class="review-card"><h4>Proceso</h4><p><strong>${mode==='approval_signature'?'Aprobar y después firmar':'Solo firmas'}</strong></p><p class="muted">Aprobaciones: ${approvalRoutingMode()==='parallel'?'en paralelo':'en orden'} · Firmas: ${signatureRoutingMode()==='parallel'?'en paralelo':'en orden'}.</p><p class="muted">Fecha límite: ${dueDays} días. Primer recordatorio: ${firstReminder} h; después cada ${repeatReminder} h.</p></div><div class="review-card"><h4>Aprobadores</h4>${people(approvers)}</div><div class="review-card"><h4>Firmantes</h4>${people(signers)}</div>`;
  }

  function applySelectedTemplate() {
    const id = byId('document-template')?.value;
    const template = state.templates.find(item => item.id === id);
    state.selectedTemplateFields = [];
    if (!template) return;

    byId('doc-category').value = template.category || 'other';
    const modeInput = document.querySelector(`input[name="workflow-mode"][value="${template.workflow_mode || 'approval_signature'}"]`);
    if (modeInput) modeInput.checked = true;
    setWorkflowMode(template.workflow_mode || 'approval_signature');
    byId('approval-routing').value = template.approval_routing || 'sequential';
    byId('signature-routing').value = template.signature_routing || 'sequential';
    setInputValue('doc-due-days', template.due_days || 10);
    setInputValue('doc-first-reminder-hours', template.first_reminder_hours || 24);
    setInputValue('doc-repeat-reminder-hours', template.repeat_reminder_hours || 24);

    els['approvers-builder'].innerHTML = '';
    els['signers-builder'].innerHTML = '';
    const participants = Array.isArray(template.participants) ? template.participants : [];
    participants.filter(item => item.participant_role === 'approver').sort((a,b) => Number(a.sequence)-Number(b.sequence)).forEach(item => addOrderedParticipant(els['approvers-builder'], 'approver', item.user_id));
    participants.filter(item => item.participant_role === 'signer').sort((a,b) => Number(a.sequence)-Number(b.sequence)).forEach(item => addOrderedParticipant(els['signers-builder'], 'signer', item.user_id));
    if (template.workflow_mode !== 'signature_only' && !qsa('.ordered-row', els['approvers-builder']).length) addOrderedParticipant(els['approvers-builder'], 'approver');
    if (!qsa('.ordered-row', els['signers-builder']).length) addOrderedParticipant(els['signers-builder'], 'signer');
    state.selectedTemplateFields = Array.isArray(template.fields) ? template.fields : [];
    toast(`Plantilla “${template.name}” aplicada.`);
  }

  async function saveCurrentDocumentAsTemplate(event) {
    event?.preventDefault();
    const prepare = state.prepare;
    if (!prepare) throw new Error('Abre un borrador preparado para guardar una plantilla.');
    const name = byId('template-name').value.trim();
    if (!name) throw new Error('Escribe el nombre de la plantilla.');
    await run(async () => {
      const payload = prepare.fields.map(field => ({
        id: field.id,
        assigned_to: field.assigned_to,
        field_type: 'signature',
        page_number: Number(field.page_number),
        x_pct: Number(Number(field.x_pct).toFixed(4)),
        y_pct: Number(Number(field.y_pct).toFixed(4)),
        width_pct: Number(Number(field.width_pct).toFixed(4)),
        height_pct: Number(Number(field.height_pct).toFixed(4)),
        required: true,
        label: field.label || 'Firma',
        placeholder: ''
      }));
      const savedFields = await client.rpc('save_document_fields', { p_document_id: prepare.doc.id, p_fields: payload });
      if (savedFields.error) throw savedFields.error;
      const { error } = await client.rpc('save_document_as_template', {
        p_document_id: prepare.doc.id,
        p_name: name,
        p_description: byId('template-description').value.trim()
      });
      if (error) throw error;
      els['template-dialog'].close();
      byId('template-form').reset();
      await loadTemplates();
      renderTemplateList();
    }, 'Plantilla guardada.');
  }

  async function deleteTemplate(id) {
    if (!confirm('¿Desactivar esta plantilla? Los documentos existentes no cambiarán.')) return;
    await run(async () => {
      const { error } = await client.rpc('delete_document_template', { p_template_id: id });
      if (error) throw error;
      await loadTemplates();
      renderTemplateList();
    }, 'Plantilla desactivada.');
  }

  function resetDocumentWizard() {
    els['new-document-form'].reset();
    els['approvers-builder'].innerHTML=''; els['signers-builder'].innerHTML='';
    document.querySelector('input[name="workflow-mode"][value="approval_signature"]').checked=true;
    setWorkflowMode('approval_signature');
    addOrderedParticipant(els['signers-builder'],'signer');
    setInputValue('doc-due-days', 10);
    setInputValue('doc-first-reminder-hours', 24);
    setInputValue('doc-repeat-reminder-hours', 24);
    if (byId('approval-routing')) byId('approval-routing').value = 'sequential';
    if (byId('signature-routing')) byId('signature-routing').value = 'sequential';
    if (byId('document-template')) byId('document-template').value = '';
    state.selectedTemplateFields = [];
    setWizardStep(1);
  }

  async function createDocument(event) {
    event.preventDefault();
    if (!isActive()) throw new Error('Tu cuenta no está activa.');
    validateWizardStep(1); validateWizardStep(3);
    const file=byId('doc-file').files[0], attachment=byId('doc-attachment').files[0];
    await validatePdfSignature(file);
    const participants=readOrderedParticipants(els['approvers-builder'],els['signers-builder'],workflowMode());
    let newDocId=null;
    await run(async()=>{
      const {data:docId,error:createError}=await client.rpc('create_document',{p_title:byId('doc-title').value.trim(),p_description:byId('doc-description').value.trim(),p_category:byId('doc-category').value});
      if(createError)throw createError; newDocId=docId;
      const filePath=`${docId}/v1/${Date.now()}-${safeFilename(file.name)}`,hash=await sha256(file);
      const upload=await client.storage.from('documents').upload(filePath,file,{contentType:file.type||'application/pdf',upsert:false});if(upload.error)throw upload.error;
      const attached=await client.rpc('attach_primary_file',{p_document_id:docId,p_file_path:filePath,p_file_name:file.name,p_file_hash:hash,p_mime_type:file.type||'application/pdf',p_size_bytes:file.size});if(attached.error)throw attached.error;
      if(attachment){const path=`${docId}/attachments/${Date.now()}-${safeFilename(attachment.name)}`,attachmentHash=await sha256(attachment);const up=await client.storage.from('documents').upload(path,attachment,{contentType:attachment.type||'application/octet-stream'});if(up.error)throw up.error;const rec=await client.rpc('add_document_attachment',{p_document_id:docId,p_file_path:path,p_file_name:attachment.name,p_file_hash:attachmentHash,p_mime_type:attachment.type||'application/octet-stream',p_size_bytes:attachment.size});if(rec.error)throw rec.error;}
      const routing=await client.rpc('configure_document_workflow',{p_document_id:docId,p_approval_routing:approvalRoutingMode(),p_signature_routing:signatureRoutingMode()});if(routing.error)throw routing.error;
      const flow=await client.rpc('set_document_participants',{p_document_id:docId,p_items:participants});if(flow.error)throw flow.error;
      if (state.selectedTemplateFields.length) {
        const selectedTemplate = state.templates.find(template => template.id === byId('document-template').value);
        const oldSigners = (selectedTemplate?.participants || []).filter(item => item.participant_role === 'signer').sort((a,b) => Number(a.sequence)-Number(b.sequence));
        const newSigners = participants.filter(item => item.participant_role === 'signer').sort((a,b) => Number(a.sequence)-Number(b.sequence));
        const signerMap = new Map(oldSigners.map((item,index) => [item.user_id, newSigners[index]?.user_id || item.user_id]));
        const templateFields = state.selectedTemplateFields.map(field => ({
          ...field,
          id: crypto.randomUUID(),
          assigned_to: signerMap.get(field.assigned_to) || field.assigned_to,
          field_type: 'signature',
          required: true
        }));
        const fieldResult = await client.rpc('save_document_fields', { p_document_id: docId, p_fields: templateFields });
        if (fieldResult.error) throw fieldResult.error;
      }
      const dueDays = numberInputValue('doc-due-days', 10);
      const dueAt = new Date(Date.now() + dueDays * 86400000).toISOString();
      const delivery = await client.rpc('configure_document_delivery', {
        p_document_id: docId,
        p_due_at: dueAt,
        p_first_reminder_hours: numberInputValue('doc-first-reminder-hours', 24),
        p_repeat_reminder_hours: numberInputValue('doc-repeat-reminder-hours', 24)
      });
      if (delivery.error) throw delivery.error;
      resetDocumentWizard(); await refreshData(); navigate('documents');
    },'Borrador creado. Ahora indica dónde debe firmar cada persona.');
    if(newDocId)await openPrepareDocument(newDocId);
  }

  function validateFile(file, mimeTypes = [], required = false) {
    if (!file && required) throw new Error('Selecciona un archivo.');
    if (!file) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`El archivo excede ${MAX_FILE_MB} MB.`);
    if (mimeTypes.length && !mimeTypes.includes(file.type) && !file.name.toLowerCase().endsWith('.pdf')) throw new Error('El documento principal debe ser PDF.');
  }

  async function validatePdfSignature(file) {
    const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    const magic = String.fromCharCode(...header);
    if (magic !== '%PDF-') throw new Error('El archivo seleccionado no contiene una firma PDF válida.');
  }

  async function openDocument(id) {
    state.activeDocumentId = id;
    await run(async () => {
      const [docRes, participantsRes, versionsRes, attachmentsRes, eventsRes, signaturesRes, fieldsRes] = await Promise.all([
        client.from('documents').select('*').eq('id', id).single(),
        client.from('document_participants').select('*').eq('document_id', id).order('sequence'),
        client.from('document_versions').select('*').eq('document_id', id).order('version_number', { ascending: false }),
        client.from('document_attachments').select('*').eq('document_id', id).order('created_at', { ascending: false }),
        client.from('audit_events').select('*').eq('document_id', id).order('created_at', { ascending: false }),
        client.from('document_signatures').select('*').eq('document_id', id).order('signed_at', { ascending: false }),
        client.from('document_fields').select('*').eq('document_id', id)
      ]);
      [docRes, participantsRes, versionsRes, attachmentsRes, eventsRes, signaturesRes, fieldsRes].forEach(r => { if (r.error) throw r.error; });
      renderDocumentDetail(docRes.data, participantsRes.data || [], versionsRes.data || [], attachmentsRes.data || [], eventsRes.data || [], signaturesRes.data || [], fieldsRes.data || []);
      els['document-dialog'].showModal();
    });
  }

  function profileName(id) {
    const p = state.profiles.find(x => x.id === id);
    return p?.full_name || p?.email || 'Usuario';
  }

  function renderDocumentDetail(doc, participants, versions, attachments, events, signatures, fields = []) {
    const me=state.session.user.id;
    const currentRole=doc.status==='awaiting_approval'?'approver':doc.status==='awaiting_signature'?'signer':null;
    const stagePending=participants.filter(item=>item.participant_role===currentRole&&item.action_status==='pending');
    const minSequence=stagePending.length?Math.min(...stagePending.map(item=>Number(item.sequence))):null;
    const myApproval=participants.find(item=>item.user_id===me&&item.participant_role==='approver'&&item.action_status==='pending'&&Number(item.sequence)===minSequence);
    const mySignature=participants.find(item=>item.user_id===me&&item.participant_role==='signer'&&item.action_status==='pending'&&Number(item.sequence)===minSequence);
    const isAssignedEditor=participants.some(item=>item.user_id===me&&item.participant_role==='editor');
    const canConfigure=doc.status==='draft'&&(doc.owner_id===me||isAdmin()||isContracts()||isAssignedEditor);
    const canReplace=(doc.status==='draft'&&(doc.owner_id===me||isAdmin()||isContracts()||isAssignedEditor))||(doc.status==='rejected'&&(isAdmin()||isContracts()));
    const canManage=(doc.owner_id===me||isAdmin()||isContracts());
    const approvers=participants.filter(item=>item.participant_role==='approver').sort((a,b)=>a.sequence-b.sequence);
    const signers=participants.filter(item=>item.participant_role==='signer').sort((a,b)=>a.sequence-b.sequence);
    const hasFields=fields.length>0;
    const processSteps=[
      {key:'draft',label:'Preparación'},
      {key:'approval',label:approvers.length?'Aprobación':'Sin aprobación'},
      {key:'signature',label:'Firmas'},
      {key:'completed',label:'Completado'}
    ];
    const rank={draft:0,rejected:0,awaiting_approval:1,awaiting_signature:2,paused:2,completed:3,cancelled:3,expired:3};
    const currentRank=rank[doc.status]??0;
    const track=processSteps.map((step,index)=>`<div class="process-step ${index<currentRank?'done':index===currentRank?'current':'blocked'}">${index+1}. ${step.label}</div>`).join('');
    let guidance='';
    if(doc.status==='draft')guidance=hasFields?'Los espacios de firma están listos. Puedes iniciar el proceso.':'El siguiente paso es indicar dónde debe firmar cada persona.';
    else if(doc.status==='awaiting_approval')guidance=myApproval?'Es tu turno de revisar y decidir.':'El documento está esperando a la persona que debe aprobar antes.';
    else if(doc.status==='awaiting_signature')guidance=mySignature?'Es tu turno de revisar y colocar tu firma.':'El documento está esperando a la persona que debe firmar antes.';
    else if(doc.status==='completed')guidance='El proceso terminó. La versión actual contiene las firmas aplicadas.';
    else if(doc.status==='rejected')guidance='El documento fue rechazado. Crea una corrección conservando el historial original.';
    else if(doc.status==='paused')guidance='El proceso está pausado. Nadie puede aprobar ni firmar hasta que se reanude.';
    else if(doc.status==='cancelled')guidance='El proceso fue cancelado y quedó cerrado para nuevas acciones.';

    const primary=[];
    if(canConfigure&&!hasFields)primary.push(`<button class="primary" data-prepare-document="${doc.id}">Continuar: indicar dónde firman</button>`);
    if(canConfigure&&hasFields)primary.push(`<button class="primary" data-submit-document="${doc.id}">Iniciar proceso</button>`);
    if(myApproval)primary.push(`<button class="primary" data-preview-document="${doc.id}">1. Revisar PDF</button><button class="primary" data-approve-document="${doc.id}">2. Aprobar documento</button><button class="danger" data-reject-document="${doc.id}">Rechazar</button>`);
    if(mySignature)primary.push(`<button class="primary" data-sign-document="${doc.id}">Revisar y firmar</button>`);
    if(doc.status==='completed'&&doc.active_file_path)primary.push(`<button class="primary" data-download-path="${escapeHtml(doc.active_file_path)}" data-download-name="${escapeHtml(doc.active_file_name||'documento.pdf')}">Descargar PDF final</button>`);
    if(doc.status==='completed'&&doc.certificate_path)primary.push(`<button class="secondary" data-download-path="${escapeHtml(doc.certificate_path)}" data-download-name="certificado-de-finalizacion.pdf">Descargar certificado</button>`);
    if(doc.status==='completed'&&doc.evidence_zip_path)primary.push(`<button class="secondary" data-download-path="${escapeHtml(doc.evidence_zip_path)}" data-download-name="paquete-de-evidencias.zip">Descargar evidencias ZIP</button>`);
    if(doc.status==='completed'&&doc.finalization_status!=='ready')primary.push(`<button class="secondary" data-finalize-evidence="${doc.id}">${doc.finalization_status==='failed'?'Reintentar certificado':'Generar certificado'}</button>`);
    const secondary=[
      doc.active_file_path&&!myApproval&&!mySignature?`<button class="secondary preview-action" data-preview-document="${doc.id}">Vista previa del PDF</button>`:'',
      doc.active_file_path&&doc.status!=='completed'?`<button class="secondary" data-download-path="${escapeHtml(doc.active_file_path)}" data-download-name="${escapeHtml(doc.active_file_name||'documento.pdf')}">Descargar actual</button>`:'',
      canConfigure&&hasFields?`<button class="secondary" data-prepare-document="${doc.id}">Editar espacios de firma</button>`:'',
      canConfigure?`<button class="secondary" data-configure-flow="${doc.id}">Cambiar responsables</button>`:'',
      canReplace?`<button class="secondary" data-replace-document="${doc.id}">Subir nueva versión</button>`:'',
      canManage&&['awaiting_approval','awaiting_signature'].includes(doc.status)?`<button class="secondary" data-pause-document="${doc.id}">Pausar proceso</button>`:'',
      canManage&&doc.status==='paused'?`<button class="primary" data-resume-document="${doc.id}">Reanudar proceso</button>`:'',
      canManage&&!['completed','cancelled'].includes(doc.status)?`<button class="secondary" data-extend-deadline="${doc.id}">Extender fecha límite</button>`:'',
      canManage&&!['completed','cancelled'].includes(doc.status)?`<button class="danger" data-cancel-document="${doc.id}">Cancelar proceso</button>`:'',
      canManage&&['rejected','completed','cancelled'].includes(doc.status)?`<button class="secondary" data-create-correction="${doc.id}">Crear corrección</button>`:'',
      (isAdmin()||isContracts())&&doc.status==='draft'&&hasFields?`<button class="secondary" data-save-document-template="${doc.id}">Guardar como plantilla</button>`:'',
      `<button class="secondary" data-document-chat="${doc.id}">Conversación del expediente</button>`
    ].join('');
    const participantList=(items,title,role)=>{
      const routing = role==='approver' ? doc.approval_routing : doc.signature_routing;
      return `<div class="participant-group"><h3>${title} <small class="muted">${routing==='parallel'?'en paralelo':'en orden'}</small></h3>${items.length?items.map((item,index)=>`<div class="participant-item"><span>${routing==='parallel'?'↔':index+1}</span><div><strong>${escapeHtml(profileName(item.user_id))}</strong><small class="candidate-note">${routing==='parallel'?'Puede actuar en cualquier orden':index===0?'Actúa primero':'Actúa después de la persona anterior'}${item.acted_at?` · ${fmtDate(item.acted_at)}`:''}</small></div>${pill(item.action_status)}${canManage&&item.action_status==='pending'&&['awaiting_approval','awaiting_signature','paused'].includes(doc.status)?`<button class="secondary compact" data-reassign-participant="${item.id}" data-reassign-document="${doc.id}" data-reassign-role="${item.participant_role}">Reasignar</button>`:''}</div>`).join(''):'<p class="muted">Esta etapa se omitió.</p>'}</div>`;
    };

    els['document-detail'].innerHTML=`<div class="stack"><div class="document-hero"><div class="document-hero-top"><div><p class="eyebrow dark">${escapeHtml({contract:'Contrato',invoice:'Factura',other:'Otro'}[doc.category]||doc.category)}</p><h2>${escapeHtml(doc.title)}</h2><p class="muted">${escapeHtml(doc.description||'Sin descripción')}</p></div>${pill(doc.status)}</div><div class="process-track">${track}</div><div class="process-guidance">${escapeHtml(guidance)}</div><div class="document-primary-actions">${primary.join('')}${secondary}</div></div><div class="detail-grid"><div class="detail-tile"><strong>Propietario</strong><p>${escapeHtml(profileName(doc.owner_id))}</p></div><div class="detail-tile"><strong>Versión</strong><p>v${doc.current_version} · ${fmtBytes(doc.size_bytes)}</p></div><div class="detail-tile"><strong>Última actualización</strong><p>${fmtDate(doc.updated_at)}</p></div><div class="detail-tile"><strong>Fecha límite</strong><p>${fmtDate(doc.due_at)}</p></div><div class="detail-tile"><strong>Firmas</strong><p>${doc.signature_routing==='parallel'?'En paralelo':'En orden'}</p></div><div class="detail-tile"><strong>Evidencias</strong><p>${escapeHtml(doc.finalization_status||'pending')}</p></div></div><div class="participant-groups">${participantList(approvers,'Aprobaciones','approver')}${participantList(signers,'Firmas','signer')}</div><details class="technical-details"><summary>Ver versiones, anexos e historial técnico</summary><div class="stack"><div><h3>Versiones</h3>${versions.length?`<div class="table-wrap"><table><thead><tr><th>Versión</th><th>Archivo</th><th>Hash</th><th>Fecha</th><th></th></tr></thead><tbody>${versions.map(version=>`<tr><td>v${version.version_number}</td><td>${escapeHtml(version.file_name)}</td><td><code title="${escapeHtml(version.file_hash)}">${escapeHtml((version.file_hash||'').slice(0,16))}…</code></td><td>${fmtDate(version.created_at)}</td><td><button class="secondary" data-download-path="${escapeHtml(version.file_path)}" data-download-name="${escapeHtml(version.file_name)}">Descargar</button></td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Sin versiones.</p>'}</div><div><h3>Anexos</h3>${attachments.length?attachments.map(item=>`<div class="signature-card"><span>${escapeHtml(item.file_name)} · ${fmtBytes(item.size_bytes)}</span><button class="secondary" data-download-path="${escapeHtml(item.file_path)}" data-download-name="${escapeHtml(item.file_name)}">Descargar</button></div>`).join(''):'<p class="muted">Sin anexos.</p>'}</div><div><h3>Firmas aplicadas</h3>${signatures.length?signatures.map(item=>`<div class="timeline-item"><strong>${escapeHtml(profileName(item.signer_id))}</strong><p>${fmtDate(item.signed_at)}</p><p class="muted small">Hash: ${escapeHtml((item.file_hash||'').slice(0,24))}…</p></div>`).join(''):'<p class="muted">Aún no hay firmas.</p>'}</div><div><h3>Historial</h3><div class="timeline">${events.length?events.map(event=>`<div class="timeline-item"><strong>${escapeHtml(eventLabel(event.action))}</strong><p>${escapeHtml(profileName(event.actor_id))} · ${fmtDate(event.created_at)}</p>${event.metadata?.comment?`<p>${escapeHtml(event.metadata.comment)}</p>`:''}</div>`).join(''):'<p class="muted">Sin eventos.</p>'}</div></div></div></details></div>`;
  }

  function eventLabel(action) {
    return ({document_created:'Documento creado',primary_file_attached:'Archivo principal cargado',attachment_added:'Anexo agregado',flow_updated:'Flujo actualizado',document_submitted:'Documento enviado',document_approved:'Documento aprobado',document_rejected:'Documento rechazado',document_signed:'Documento firmado',document_completed:'Flujo completado',signature_fields_updated:'Espacios de firma preparados',delivery_settings_updated:'Recordatorios configurados',routing_configured:'Orden del proceso configurado',document_paused:'Proceso pausado',document_resumed:'Proceso reanudado',document_cancelled:'Proceso cancelado',deadline_extended:'Fecha límite extendida',participant_reassigned:'Responsable reasignado',correction_draft_created:'Corrección creada',template_created:'Plantilla creada',evidence_package_generated:'Paquete de evidencias generado'}[action] || action);
  }

  async function pauseDocument(id) {
    const reason = prompt('Motivo de la pausa (opcional):') || '';
    await run(async () => {
      const { error } = await client.rpc('pause_document', { p_document_id: id, p_reason: reason });
      if (error) throw error;
      if (els['document-dialog'].open) els['document-dialog'].close();
      await refreshData();
    }, 'Proceso pausado.');
  }

  async function resumeDocument(id) {
    await run(async () => {
      const { error } = await client.rpc('resume_document', { p_document_id: id });
      if (error) throw error;
      if (els['document-dialog'].open) els['document-dialog'].close();
      await refreshData();
    }, 'Proceso reanudado.');
  }

  async function cancelDocument(id) {
    const reason = prompt('Escribe el motivo de cancelación:');
    if (!reason?.trim()) return;
    if (!confirm('La cancelación cerrará el proceso y no podrá deshacerse. ¿Continuar?')) return;
    await run(async () => {
      const { error } = await client.rpc('cancel_document', { p_document_id: id, p_reason: reason.trim() });
      if (error) throw error;
      if (els['document-dialog'].open) els['document-dialog'].close();
      await refreshData();
    }, 'Proceso cancelado.');
  }

  async function extendDeadline(id) {
    const daysText = prompt('¿Cuántos días adicionales deseas agregar?', '5');
    const days = Number(daysText);
    if (!Number.isFinite(days) || days < 1 || days > 365) throw new Error('Escribe un número de días entre 1 y 365.');
    const dueAt = new Date(Date.now() + days * 86400000).toISOString();
    await run(async () => {
      const { error } = await client.rpc('extend_document_deadline', { p_document_id: id, p_due_at: dueAt });
      if (error) throw error;
      if (els['document-dialog'].open) els['document-dialog'].close();
      await refreshData();
    }, 'Fecha límite actualizada.');
  }

  async function reassignParticipant(participantId, documentId, role) {
    const email = prompt(`Correo del nuevo ${role === 'approver' ? 'aprobador' : 'firmante'}:`);
    if (!email?.trim()) return;
    const person = state.profiles.find(profile => profile.email.toLowerCase() === email.trim().toLowerCase() && profile.status === 'active');
    if (!person) throw new Error('No se encontró un usuario activo con ese correo.');
    await run(async () => {
      const { error } = await client.rpc('reassign_pending_participant', {
        p_document_id: documentId,
        p_participant_id: participantId,
        p_new_user_id: person.id
      });
      if (error) throw error;
      if (els['document-dialog'].open) els['document-dialog'].close();
      await refreshData();
      await openDocument(documentId);
    }, 'Responsable reasignado.');
  }

  async function createCorrection(id) {
    const source = state.documents.find(document => document.id === id) || (await client.from('documents').select('*').eq('id', id).single()).data;
    if (!source?.active_file_path) throw new Error('El expediente no tiene un archivo para copiar.');
    const title = prompt('Título de la corrección:', `${source.title} — Corrección`) || '';
    await run(async () => {
      const { data: newId, error } = await client.rpc('create_correction_draft', { p_document_id: id, p_title: title.trim() || null });
      if (error) throw error;
      const signed = await client.storage.from('documents').createSignedUrl(source.active_file_path, 180);
      if (signed.error) throw signed.error;
      const response = await fetch(signed.data.signedUrl);
      if (!response.ok) throw new Error('No se pudo copiar el PDF actual.');
      const blob = await response.blob();
      const hash = await sha256(await blob.arrayBuffer());
      const path = `${newId}/v1/${Date.now()}-${safeFilename(source.active_file_name || 'documento.pdf')}`;
      const upload = await client.storage.from('documents').upload(path, blob, { contentType: 'application/pdf', upsert: false });
      if (upload.error) throw upload.error;
      const attached = await client.rpc('attach_primary_file', {
        p_document_id: newId,
        p_file_path: path,
        p_file_name: source.active_file_name || 'documento.pdf',
        p_file_hash: hash,
        p_mime_type: 'application/pdf',
        p_size_bytes: blob.size
      });
      if (attached.error) throw attached.error;
      if (els['document-dialog'].open) els['document-dialog'].close();
      await refreshData();
      await openPrepareDocument(newId);
    }, 'Borrador de corrección creado.');
  }

  function openSaveTemplateDialog(documentId = null) {
    if (documentId && (!state.prepare || state.prepare.doc.id !== documentId)) {
      openPrepareDocument(documentId).then(() => {
        byId('template-name').value = '';
        byId('template-description').value = '';
        els['template-dialog'].showModal();
      }).catch(error => toast(error.message, true));
      return;
    }
    byId('template-name').value = '';
    byId('template-description').value = '';
    els['template-dialog'].showModal();
  }

  async function openDocumentConversation(documentId) {
    await run(async () => {
      const { data: conversationId, error } = await client.rpc('ensure_document_conversation', { p_document_id: documentId });
      if (error) throw error;
      if (els['document-dialog'].open) els['document-dialog'].close();
      await loadConversations();
      renderConversations();
      navigate('messages');
      await openConversation(conversationId);
    });
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

  async function openDocumentPreview(id) {
    await run(async () => {
      const bundle = await getDocumentBundle(id);
      const pdf = await pdfjsLib.getDocument({ data: bundle.bytes.slice(0) }).promise;
      state.preview = { ...bundle, pdf, page: 1, pageCount: pdf.numPages, zoom: 1.15 };
      els['preview-title'].textContent = bundle.doc.title || 'Documento';
      els['preview-page-count'].textContent = String(pdf.numPages);
      if (els['document-dialog']?.open) els['document-dialog'].close();
      els['preview-dialog'].showModal();
      await renderPreviewPage();
    });
  }

  async function renderPreviewPage() {
    const preview = state.preview;
    if (!preview) return;
    els['preview-page-number'].textContent = String(preview.page);
    els['preview-page-count'].textContent = String(preview.pageCount);
    els['preview-zoom-label'].textContent = `${Math.round(preview.zoom * 100 / 1.15)}%`;
    await renderPdfPage(els['preview-pages'], preview.pdf, preview.page, preview.zoom, [], 'preview');
    els['preview-prev-page'].disabled = preview.page <= 1;
    els['preview-next-page'].disabled = preview.page >= preview.pageCount;
  }

  async function returnFromPreviewToDocument() {
    const documentId = state.preview?.doc?.id || state.activeDocumentId;
    if (els['preview-dialog']?.open) els['preview-dialog'].close();
    state.preview = null;
    if (documentId) await openDocument(documentId);
  }

  async function downloadPreviewDocument() {
    const preview = state.preview;
    if (!preview?.doc?.active_file_path) return;
    await downloadPrivate(preview.doc.active_file_path, preview.doc.active_file_name || 'documento.pdf');
  }

  async function configureFlow(docId) {
    state.flowDocumentId=docId;
    const [participantsResponse, documentResponse] = await Promise.all([
      client.from('document_participants').select('*').eq('document_id',docId).order('sequence'),
      client.from('documents').select('approval_routing,signature_routing').eq('id',docId).single()
    ]);
    if(participantsResponse.error)throw participantsResponse.error;
    if(documentResponse.error)throw documentResponse.error;
    const data = participantsResponse.data;
    byId('flow-approval-routing').value = documentResponse.data.approval_routing || 'sequential';
    byId('flow-signature-routing').value = documentResponse.data.signature_routing || 'sequential';
    els['flow-approvers-builder'].innerHTML='';els['flow-signers-builder'].innerHTML='';
    (data||[]).filter(item=>item.participant_role==='approver').forEach(item=>addOrderedParticipant(els['flow-approvers-builder'],'approver',item.user_id));
    (data||[]).filter(item=>item.participant_role==='signer').forEach(item=>addOrderedParticipant(els['flow-signers-builder'],'signer',item.user_id));
    if(!qsa('.ordered-row',els['flow-signers-builder']).length)addOrderedParticipant(els['flow-signers-builder'],'signer');
    if(els['document-dialog'].open)els['document-dialog'].close();
    els['flow-dialog'].showModal();
  }

  async function saveFlow() {
    const mode=qsa('.ordered-row',els['flow-approvers-builder']).length?'approval_signature':'signature_only';
    const approvalRouting = byId('flow-approval-routing').value;
    const signatureRouting = byId('flow-signature-routing').value;
    const items=readOrderedParticipants(els['flow-approvers-builder'],els['flow-signers-builder'],mode,approvalRouting,signatureRouting);
    if(!items.some(item=>item.participant_role==='signer'))throw new Error('Agrega al menos un firmante.');
    await run(async()=>{
      const routing = await client.rpc('configure_document_workflow',{p_document_id:state.flowDocumentId,p_approval_routing:approvalRouting,p_signature_routing:signatureRouting});
      if(routing.error)throw routing.error;
      const {error}=await client.rpc('set_document_participants',{p_document_id:state.flowDocumentId,p_items:items});
      if(error)throw error;
      els['flow-dialog'].close();await refreshData();await openDocument(state.flowDocumentId);
    },'Responsables actualizados.');
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


  const fieldTypeLabels = { signature: 'Firma' };

  function defaultFieldSize() {
    return [30, 10];
  }

  async function getDocumentBundle(id) {
    const [docRes, partsRes, fieldsRes] = await Promise.all([
      client.from('documents').select('*').eq('id', id).single(),
      client.from('document_participants').select('*').eq('document_id', id).order('sequence'),
      client.from('document_fields').select('*').eq('document_id', id).eq('field_type', 'signature').order('page_number')
    ]);
    [docRes, partsRes, fieldsRes].forEach(response => { if (response.error) throw response.error; });
    const { data: url, error: urlError } = await client.storage.from('documents').createSignedUrl(docRes.data.active_file_path, 300);
    if (urlError) throw urlError;
    const response = await fetch(url.signedUrl);
    if (!response.ok) throw new Error('No se pudo abrir el PDF.');
    return { doc: docRes.data, participants: partsRes.data || [], fields: fieldsRes.data || [], bytes: await response.arrayBuffer() };
  }

  function signerOptions(participants, selected = '') {
    const signers = participants.filter(participant => participant.participant_role === 'signer').sort((a, b) => Number(a.sequence) - Number(b.sequence));
    return signers.map((participant, index) => {
      const order = index === 0 ? 'firma primero' : 'firma después';
      return `<option value="${participant.user_id}" ${participant.user_id === selected ? 'selected' : ''}>${escapeHtml(profileName(participant.user_id))} · ${order}</option>`;
    }).join('');
  }

  async function renderPdfPage(container, pdf, pageNumber, scale, fields, mode) {
    container.innerHTML = '<div class="visual-loading">Renderizando página…</div>';
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.page = String(pageNumber);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    wrapper.style.width = `${canvas.width}px`;
    wrapper.style.height = `${canvas.height}px`;
    wrapper.append(canvas);
    const badge = document.createElement('span');
    badge.className = 'pdf-page-number';
    badge.textContent = `Página ${pageNumber}`;
    wrapper.append(badge);
    container.innerHTML = '';
    container.append(wrapper);
    await page.render({ canvasContext: context, viewport }).promise;
    fields.filter(field => Number(field.page_number) === pageNumber).forEach(field => wrapper.append(createFieldOverlay(field, mode)));
    if (mode === 'prepare') {
      wrapper.classList.add('signature-placement-page');
      wrapper.setAttribute('aria-label', 'Haz clic en el documento para colocar un espacio de firma');
      wrapper.addEventListener('click', placePreparedFieldFromPageClick);
    }
    return wrapper;
  }

  function positionOverlay(element, field) {
    element.style.left = `${field.x_pct}%`;
    element.style.top = `${field.y_pct}%`;
    element.style.width = `${field.width_pct}%`;
    element.style.height = `${field.height_pct}%`;
  }

  function createFieldOverlay(field, mode) {
    const element = document.createElement('div');
    element.className = 'field-overlay';
    element.dataset.fieldId = field.id;
    positionOverlay(element, field);
    element.insertAdjacentHTML('beforeend', '<span class="field-required-mark">*</span>');

    if (mode === 'prepare') {
      element.innerHTML += `<span class="field-caption">Firma: ${escapeHtml(profileName(field.assigned_to))}</span><span class="resize-handle"></span>`;
      element.addEventListener('pointerdown', startFieldPointer);
      element.addEventListener('click', event => { event.stopPropagation(); selectPreparedField(field.id); });
      if (state.prepare?.selectedId === field.id) element.classList.add('selected');
      return element;
    }

    if (field.assigned_to !== state.session.user.id) {
      element.classList.add('other-signer');
      element.innerHTML += '<span class="field-caption">Firma de otra persona</span>';
      return element;
    }

    renderSigningControl(element, field);
    return element;
  }

  function renderSigningControl(element, field) {
    const values = state.signing.values;
    const value = values[field.id] || '';
    const label = field.label || 'Firma obligatoria';
    element.classList.toggle('completed', Boolean(value));
    element.classList.toggle('pending-required', !value);
    element.setAttribute('aria-label', `${label} en página ${field.page_number}`);
    element.innerHTML += value
      ? `<div class="field-value"><img src="${state.signing.signatureUrl}" alt="Firma aplicada"></div>`
      : `<button class="sign-field-button" type="button" aria-label="Aplicar mi firma en ${escapeHtml(label)}">Aplicar mi firma</button>`;
    const button = element.querySelector('button');
    if (button) button.addEventListener('click', () => {
      values[field.id] = 'signature';
      renderSigningPages(false).then(() => {
        updateSignProgress();
        const next = firstMissingSignField();
        if (next) setTimeout(() => jumpToSignField(next.id), 120);
        else toast('Todos los campos obligatorios están completos. Ya puedes finalizar la firma.');
      });
    });
  }

  async function openPrepareDocument(id) {
    await run(async () => {
      const bundle = await getDocumentBundle(id);
      const signers = bundle.participants.filter(participant => participant.participant_role === 'signer');
      if (!signers.length) throw new Error('Configura al menos un firmante.');
      const pdf = await pdfjsLib.getDocument({ data: bundle.bytes.slice(0) }).promise;
      state.prepare = {
        ...bundle,
        pdf,
        page: 1,
        pageCount: pdf.numPages,
        zoom: 1.15,
        selectedId: null,
        fields: bundle.fields.map(field => ({
          ...field,
          field_type: 'signature',
          required: true,
          x_pct: Number(field.x_pct),
          y_pct: Number(field.y_pct),
          width_pct: Number(field.width_pct),
          height_pct: Number(field.height_pct)
        }))
      };
      const options = signerOptions(bundle.participants);
      els['field-assignee'].innerHTML = options;
      els['selected-field-assignee'].innerHTML = options;
      els['prepare-page-count'].textContent = String(pdf.numPages);
      els['prepare-dialog'].showModal();
      await renderPreparePage();
    });
  }

  async function renderPreparePage() {
    const prepare = state.prepare;
    if (!prepare) return;
    els['prepare-page-number'].textContent = String(prepare.page);
    els['prepare-zoom-label'].textContent = `${Math.round(prepare.zoom * 100 / 1.15)}%`;
    await renderPdfPage(els['prepare-pages'], prepare.pdf, prepare.page, prepare.zoom, prepare.fields, 'prepare');
  }

  function selectPreparedField(id) {
    const prepare = state.prepare;
    const field = prepare?.fields.find(item => item.id === id);
    if (!field) return;
    prepare.selectedId = id;
    els['selected-field-panel'].classList.remove('hidden');
    els['selected-field-assignee'].value = field.assigned_to;
    els['selected-field-label'].value = field.label || 'Firma';
    qsa('.field-overlay', els['prepare-pages']).forEach(element => element.classList.toggle('selected', element.dataset.fieldId === id));
  }

  function placePreparedFieldFromPageClick(event) {
    const prepare = state.prepare;
    if (!prepare) return;

    // Los clics sobre un cuadro existente sirven para seleccionarlo, no para crear otro.
    if (event.target.closest('.field-overlay')) return;

    const assignedTo = els['field-assignee'].value;
    if (!assignedTo) {
      toast('Primero selecciona a la persona que firmará.', true);
      els['field-assignee'].focus();
      return;
    }

    const page = event.currentTarget;
    const rect = page.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const [width, height] = defaultFieldSize();
    const clickX = (event.clientX - rect.left) / rect.width * 100;
    const clickY = (event.clientY - rect.top) / rect.height * 100;

    const field = {
      id: crypto.randomUUID(),
      document_id: prepare.doc.id,
      assigned_to: assignedTo,
      field_type: 'signature',
      page_number: prepare.page,
      x_pct: Math.max(0, Math.min(100 - width, clickX - width / 2)),
      y_pct: Math.max(0, Math.min(100 - height, clickY - height / 2)),
      width_pct: width,
      height_pct: height,
      required: true,
      label: els['field-label'].value.trim() || 'Firma',
      placeholder: ''
    };

    prepare.fields.push(field);
    prepare.selectedId = field.id;
    renderPreparePage().then(() => selectPreparedField(field.id));
    toast(`Espacio de firma colocado para ${profileName(assignedTo)}.`);
  }

  function startFieldPointer(event) {
    const prepare = state.prepare;
    if (!prepare) return;
    const element = event.currentTarget;
    const field = prepare.fields.find(item => item.id === element.dataset.fieldId);
    if (!field) return;
    event.preventDefault();
    event.stopPropagation();
    selectPreparedField(field.id);
    element.setPointerCapture(event.pointerId);
    const page = element.parentElement;
    const rect = page.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const original = { x: field.x_pct, y: field.y_pct, w: field.width_pct, h: field.height_pct };
    const resizing = event.target.classList.contains('resize-handle');
    const move = moveEvent => {
      const dx = (moveEvent.clientX - startX) / rect.width * 100;
      const dy = (moveEvent.clientY - startY) / rect.height * 100;
      if (resizing) {
        field.width_pct = Math.max(8, Math.min(100 - original.x, original.w + dx));
        field.height_pct = Math.max(5, Math.min(100 - original.y, original.h + dy));
      } else {
        field.x_pct = Math.max(0, Math.min(100 - original.w, original.x + dx));
        field.y_pct = Math.max(0, Math.min(100 - original.h, original.y + dy));
      }
      positionOverlay(element, field);
    };
    const stop = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', stop);
      element.removeEventListener('pointercancel', stop);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', stop);
    element.addEventListener('pointercancel', stop);
  }

  function updateSelectedPreparedField() {
    const prepare = state.prepare;
    const field = prepare?.fields.find(item => item.id === prepare.selectedId);
    if (!field) return;
    field.assigned_to = els['selected-field-assignee'].value;
    field.field_type = 'signature';
    field.label = els['selected-field-label'].value.trim() || 'Firma';
    field.required = true;
    renderPreparePage().then(() => selectPreparedField(field.id));
  }

  function deletePreparedField() {
    const prepare = state.prepare;
    if (!prepare?.selectedId) return;
    prepare.fields = prepare.fields.filter(field => field.id !== prepare.selectedId);
    prepare.selectedId = null;
    els['selected-field-panel'].classList.add('hidden');
    renderPreparePage();
  }

  async function savePreparedFields(submit = false) {
    const prepare = state.prepare;
    if (!prepare) return;
    const signers = prepare.participants.filter(participant => participant.participant_role === 'signer');
    for (const signer of signers) {
      if (!prepare.fields.some(field => field.assigned_to === signer.user_id)) {
        throw new Error(`Falta indicar dónde firmará ${profileName(signer.user_id)}.`);
      }
    }
    await run(async () => {
      const payload = prepare.fields.map(field => ({
        id: field.id,
        assigned_to: field.assigned_to,
        field_type: 'signature',
        page_number: Number(field.page_number),
        x_pct: Number(field.x_pct.toFixed(4)),
        y_pct: Number(field.y_pct.toFixed(4)),
        width_pct: Number(field.width_pct.toFixed(4)),
        height_pct: Number(field.height_pct.toFixed(4)),
        required: true,
        label: field.label || 'Firma',
        placeholder: ''
      }));
      const { error } = await client.rpc('save_document_fields', { p_document_id: prepare.doc.id, p_fields: payload });
      if (error) throw error;
      if (submit) {
        const response = await client.rpc('submit_document', { p_document_id: prepare.doc.id });
        if (response.error) throw response.error;
      }
      els['prepare-dialog'].close();
      await refreshData();
    }, submit ? 'Posiciones guardadas y proceso iniciado.' : 'Posiciones de firma guardadas.');
  }

  async function openSigningDocument(id) {
    const defaultSignature = state.signatures.find(signature => signature.is_default && !signature.revoked_at) || state.signatures[0];
    if (!defaultSignature) throw new Error('Primero registra una firma en Perfil y firma.');
    await run(async () => {
      const bundle = await getDocumentBundle(id);
      const mine = bundle.fields.filter(field => field.assigned_to === state.session.user.id);
      if (!mine.length) throw new Error('No tienes espacios de firma asignados.');
      const { data: signatureUrl, error: signatureError } = await client.storage.from('signatures').createSignedUrl(defaultSignature.storage_path, 300);
      if (signatureError) throw signatureError;
      const pdf = await pdfjsLib.getDocument({ data: bundle.bytes.slice(0) }).promise;
      const values = {};
      mine.forEach(field => { if (field.value_text) values[field.id] = field.value_text; });
      state.signing = {
        ...bundle,
        pdf,
        fields: bundle.fields.map(field => ({
          ...field,
          field_type: 'signature',
          required: true,
          x_pct: Number(field.x_pct),
          y_pct: Number(field.y_pct),
          width_pct: Number(field.width_pct),
          height_pct: Number(field.height_pct)
        })),
        mine,
        values,
        signature: defaultSignature,
        signatureUrl: signatureUrl.signedUrl
      };
      if (els['document-dialog'].open) els['document-dialog'].close();
      els['sign-dialog'].showModal();
      await renderSigningPages(true);
      updateSignProgress();
      setTimeout(() => {
        const firstPending = firstMissingSignField();
        if (firstPending) jumpToSignField(firstPending.id);
      }, 220);
    });
  }

  async function renderSigningPages(reset = true) {
    const signing = state.signing;
    if (!signing) return;
    const scroll = reset ? 0 : els['sign-pages'].scrollTop;
    els['sign-pages'].innerHTML = '<div class="visual-loading">Preparando vista previa…</div>';
    const fragment = document.createDocumentFragment();
    for (let page = 1; page <= signing.pdf.numPages; page += 1) {
      const holder = document.createElement('div');
      await renderPdfPage(holder, signing.pdf, page, 1.15, signing.fields, 'sign');
      while (holder.firstChild) fragment.append(holder.firstChild);
    }
    els['sign-pages'].innerHTML = '';
    els['sign-pages'].append(fragment);
    if (!reset) els['sign-pages'].scrollTop = scroll;
  }

  function completedSignFields() {
    const signing = state.signing;
    if (!signing) return [];
    return signing.mine.filter(field => String(signing.values[field.id] || '').trim());
  }

  function missingSignFields() {
    const signing = state.signing;
    if (!signing) return [];
    return signing.mine.filter(field => !String(signing.values[field.id] || '').trim());
  }

  function firstMissingSignField() {
    return missingSignFields()[0] || null;
  }

  function ensureSignGuidancePanel() {
    if (!els['sign-dialog'] || byId('sign-guidance-panel')) return byId('sign-guidance-panel');
    const panel = document.createElement('div');
    panel.id = 'sign-guidance-panel';
    panel.className = 'sign-guidance-panel';
    panel.setAttribute('aria-live', 'polite');
    const summary = els['sign-progress']?.closest('.signing-summary');
    if (summary) summary.insertAdjacentElement('afterend', panel);
    else els['sign-dialog'].insertBefore(panel, els['sign-pages'] || null);
    panel.addEventListener('click', event => {
      const button = event.target.closest('[data-sign-jump]');
      if (!button) return;
      jumpToSignField(button.dataset.signJump);
    });
    return panel;
  }

  function renderSignGuidancePanel() {
    const signing = state.signing;
    const panel = ensureSignGuidancePanel();
    if (!signing || !panel) return;
    const total = signing.mine.length;
    const completed = completedSignFields().length;
    const missing = missingSignFields();
    const allDone = missing.length === 0;
    panel.classList.toggle('complete', allDone);
    panel.innerHTML = `
      <div class="sign-guidance-status">
        <span class="sign-guidance-icon">${allDone ? '✓' : '→'}</span>
        <div>
          <strong>${allDone ? 'Campos obligatorios completos' : `Campos pendientes: ${missing.length}`}</strong>
          <p>${allDone ? 'Ya puedes confirmar tu identidad y finalizar la firma.' : 'Usa “Siguiente campo pendiente” o selecciona un campo de la lista.'}</p>
        </div>
        <span class="pill ${allDone ? 'success' : 'warning'}">${completed}/${total}</span>
      </div>
      <div class="sign-field-checklist">
        ${signing.mine.map((field, index) => {
          const done = Boolean(String(signing.values[field.id] || '').trim());
          return `<button type="button" class="sign-field-chip ${done ? 'done' : 'pending'}" data-sign-jump="${field.id}">
            <span>${done ? '✓' : index + 1}</span>
            <strong>${escapeHtml(field.label || 'Firma')}</strong>
            <small>Página ${Number(field.page_number) || 1}</small>
          </button>`;
        }).join('')}
      </div>`;
  }

  function updateSignProgress() {
    const signing = state.signing;
    if (!signing) return;
    const complete = completedSignFields().length;
    const total = signing.mine.length;
    const missing = total - complete;
    const allDone = missing === 0;
    els['sign-progress'].textContent = allDone
      ? `Todos los campos obligatorios completos (${complete}/${total})`
      : `${complete} de ${total} campos obligatorios completos`;
    if (els['finish-signing']) {
      els['finish-signing'].disabled = !allDone;
      els['finish-signing'].title = allDone ? 'Confirmar identidad y finalizar firma' : `Faltan ${missing} campo(s) obligatorio(s).`;
    }
    if (els['next-required-field']) {
      els['next-required-field'].disabled = false;
      els['next-required-field'].textContent = allDone ? 'Revisar campos firmados' : 'Siguiente campo pendiente';
    }
    renderSignGuidancePanel();
  }

  function jumpToSignField(fieldId) {
    if (!fieldId) return;
    const element = els['sign-pages']?.querySelector(`[data-field-id="${fieldId}"]`);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    qsa('.field-overlay.attention', els['sign-pages']).forEach(item => item.classList.remove('attention'));
    element.classList.add('attention');
    setTimeout(() => element.classList.remove('attention'), 1600);
  }

  function nextRequiredField() {
    const signing = state.signing;
    if (!signing) return;
    const target = firstMissingSignField() || signing.mine[0];
    if (!target) return;
    jumpToSignField(target.id);
  }

  async function finishVisualSigning() {
    const signing = state.signing;
    if (!signing) return;
    const missing = missingSignFields();
    if (missing.length) {
      toast(`Completa primero ${missing.length} campo(s) obligatorio(s) antes de finalizar.`, true);
      jumpToSignField(missing[0].id);
      updateSignProgress();
      return;
    }
    resetSignConfirmForm();
    state.pendingSignConfirmation = signing.doc.id;
    els['sign-confirm-dialog'].showModal();
    setTimeout(() => byId('sign-confirm-password').focus(), 80);
  }

  async function finalizeEvidence(documentId, silent = false) {
    try {
      const { data, error } = await client.functions.invoke('finalize-evidence', { body: { documentId } });
      if (error) throw error;
      if (!silent) toast(data?.alreadyReady ? 'Las evidencias ya estaban listas.' : 'Certificado y paquete de evidencias generados.');
      return data;
    } catch (error) {
      console.error('No se pudo generar el paquete de evidencias:', error);
      if (!silent) toast('La firma quedó registrada, pero el certificado no pudo generarse. Un administrador puede reintentarlo.', true);
      return null;
    }
  }

  async function confirmVisualSigning(event) {
    event.preventDefault();
    ensureSignConfirmSecurityFields();
    clearSignConfirmError();

    const password = byId('sign-confirm-password')?.value || '';
    const code = normalizeMfaCode(byId('sign-confirm-mfa-code')?.value);

    if (!password) {
      showSignConfirmError('password', 'Escribe tu contraseña actual para confirmar la firma.');
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      showSignConfirmError('mfa', 'Escribe el código actual de 6 dígitos de tu app autenticadora.');
      return;
    }
    if (!byId('sign-consent')?.checked) {
      showSignConfirmError('consent', 'Debes aceptar el consentimiento de firma electrónica para continuar.');
      return;
    }

    state.signReauthActive = true;
    let identityConfirmed = false;
    try {
      setBusy(true);

      const { data, error } = await client.auth.signInWithPassword({
        email: state.profile.email,
        password
      });
      if (error) {
        showSignConfirmError('password', 'La contraseña no es correcta. Vuelve a escribirla.');
        return;
      }
      state.session = data?.session || state.session;

      try {
        await verifyMfaForSigning(code);
        identityConfirmed = true;
      } catch (mfaError) {
        console.error(mfaError);
        showSignConfirmError('mfa', mfaFriendlyError(mfaError));
        return;
      }
    } catch (error) {
      console.error(error);
      showSignConfirmError('general', error?.message || 'No se pudo confirmar tu identidad. Intenta de nuevo.');
      return;
    } finally {
      setBusy(false);
      if (!identityConfirmed) state.signReauthActive = false;
    }

    els['sign-confirm-dialog'].close();
    try {
      await executeVisualSigning();
    } finally {
      state.signReauthActive = false;
    }
  }

  async function executeVisualSigning() {
    const signing = state.signing;
    if (!signing) return;
    const missing = signing.mine.filter(field => !String(signing.values[field.id] || '').trim());
    if (missing.length) throw new Error(`Falta colocar tu firma en ${missing.length} espacio(s).`);
    await run(async () => {
      const signatureResponse = await fetch(signing.signatureUrl);
      if (!signatureResponse.ok) throw new Error('No se pudo cargar tu firma.');
      const signatureBytes = await signatureResponse.arrayBuffer();
      const { PDFDocument } = PDFLib;
      const pdfDocument = await PDFDocument.load(signing.bytes);
      const signatureImage = await pdfDocument.embedPng(signatureBytes);
      const pages = pdfDocument.getPages();
      for (const field of signing.mine) {
        const page = pages[Number(field.page_number) - 1];
        if (!page) continue;
        const size = page.getSize();
        const x = size.width * field.x_pct / 100;
        const width = size.width * field.width_pct / 100;
        const height = size.height * field.height_pct / 100;
        const y = size.height - (size.height * field.y_pct / 100) - height;
        const scaled = signatureImage.scaleToFit(Math.max(10, width - 6), Math.max(10, height - 6));
        page.drawImage(signatureImage, {
          x: x + (width - scaled.width) / 2,
          y: y + (height - scaled.height) / 2,
          width: scaled.width,
          height: scaled.height
        });
      }
      const output = await pdfDocument.save();
      const blob = new Blob([output], { type: 'application/pdf' });
      const hash = await sha256(output.buffer);
      const nextVersion = Number(signing.doc.current_version) + 1;
      const path = `${signing.doc.id}/signed/v${nextVersion}-${state.session.user.id}-${Date.now()}.pdf`;
      const fileName = `${signing.doc.title.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ -]/g, '').trim().replace(/\s+/g, '-')}-firmado-v${nextVersion}.pdf`;
      const upload = await client.storage.from('documents').upload(path, blob, { contentType: 'application/pdf', upsert: false });
      if (upload.error) throw upload.error;
      const record = await client.rpc('record_document_signature_v3', {
        p_document_id: signing.doc.id,
        p_user_signature_id: signing.signature.id,
        p_file_path: path,
        p_file_name: fileName,
        p_file_hash: hash,
        p_size_bytes: blob.size,
        p_user_agent: navigator.userAgent.slice(0, 500),
        p_values: signing.mine.map(field => ({ id: field.id, value: 'signature' })),
        p_base_version: Number(signing.doc.current_version),
        p_consent_version: CONSENT_VERSION,
        p_consent_text: CONSENT_TEXT
      });
      if (record.error) {
        await client.storage.from('documents').remove([path]).catch(() => {});
        throw record.error;
      }
      const completed = Boolean(record.data?.completed);
      els['sign-dialog'].close();
      state.signing = null;
      state.pendingSignConfirmation = null;
      await refreshData();
      if (completed) await finalizeEvidence(signing.doc.id, false);
    }, 'Tu firma se colocó correctamente.');
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
    await Promise.all([loadProfiles(), loadWorkflowCandidates(), loadTemplates(), loadDocuments(), loadMyParticipation(), loadDocumentHistory(), loadTasks(), loadSignatures(), loadAppliedSignatures(), loadNotifications(), loadConversations(), loadEmailSystemStatus(), loadAdminDashboard()]);
    renderAll();
  }

  function bindPasswordHold(button,input) {
    if(!button||!input)return;
    const show=event=>{event.preventDefault();input.type='text';button.classList.add('revealing');};
    const hide=()=>{input.type='password';button.classList.remove('revealing');};
    button.addEventListener('pointerdown',show);
    ['pointerup','pointercancel','pointerleave','blur'].forEach(type=>button.addEventListener(type,hide));
    button.addEventListener('keydown',event=>{if(event.key===' '||event.key==='Enter')show(event);});
    button.addEventListener('keyup',hide);
    document.addEventListener('pointerup',hide);
  }


  function passwordMeetsSecurityPolicy(password) {
    const value = String(password || '');
    return value.length >= 12
      && /[a-z]/.test(value)
      && /[A-Z]/.test(value)
      && /\d/.test(value)
      && /[^A-Za-z0-9]/.test(value);
  }

  function showForcePasswordDialog() {
    if (!els['force-password-dialog'] || !state.profile?.must_change_password) return;
    state.forcePasswordChangeActive = true;
    document.body.classList.add('password-change-required');
    if (!els['force-password-dialog'].open) {
      els['force-password-dialog'].showModal();
      setTimeout(() => byId('force-current-password')?.focus(), 80);
    }
  }

  function clearForcePasswordDialog() {
    state.forcePasswordChangeActive = false;
    document.body.classList.remove('password-change-required');
    byId('force-password-form')?.reset();
    if (els['force-password-dialog']?.open) els['force-password-dialog'].close();
  }

  function normalizeMfaCode(value) {
    return String(value || '').replace(/\s+/g, '').trim();
  }

  async function getVerifiedTotpFactors() {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) throw error;
    const totp = data?.totp || [];
    const unverified = totp.filter(factor => factor.status !== 'verified');
    for (const factor of unverified) {
      try { await client.auth.mfa.unenroll({ factorId: factor.id }); }
      catch (error) { console.warn('No se pudo eliminar un factor MFA sin verificar.', error); }
    }
    return totp.filter(factor => factor.status === 'verified');
  }

  async function enforceMfaForAll() {
    if (!state.session || state.passwordResetActive) return true;

    const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) throw error;

    if (data?.currentLevel === 'aal2') {
      clearMfaDialogs();
      return true;
    }

    const verifiedFactors = await getVerifiedTotpFactors();
    if (verifiedFactors.length > 0) {
      await startMfaVerification(verifiedFactors[0].id);
    } else {
      await startMfaEnrollment();
    }
    return false;
  }

  async function startMfaEnrollment() {
    const { data, error } = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Lumen Sign'
    });
    if (error) throw error;

    state.mfa = { factorId: data.id, challengeId: null, mode: 'enroll', enrollment: data };
    showMfaSetupDialog(data);
  }

  async function startMfaVerification(factorId) {
    const { data, error } = await client.auth.mfa.challenge({ factorId });
    if (error) throw error;

    state.mfa = { factorId, challengeId: data.id, mode: 'verify', enrollment: null };
    showMfaVerifyDialog();
  }

  function showMfaSetupDialog(enrollment) {
    state.mfaRequiredActive = true;
    document.body.classList.add('mfa-required');
    if (els['mfa-qr']) {
      const qr = enrollment?.totp?.qr_code || '';
      els['mfa-qr'].src = qr;
      els['mfa-qr'].classList.toggle('hidden', !qr);
    }
    if (els['mfa-secret']) els['mfa-secret'].textContent = enrollment?.totp?.secret || 'No disponible';
    ensureMfaErrorElement('setup');
    byId('mfa-setup-form')?.reset();
    clearMfaInlineError('setup');
    if (els['mfa-verify-dialog']?.open) els['mfa-verify-dialog'].close();
    if (!els['mfa-setup-dialog']?.open) els['mfa-setup-dialog']?.showModal();
    setTimeout(() => byId('mfa-setup-code')?.focus(), 120);
  }

  function showMfaVerifyDialog() {
    state.mfaRequiredActive = true;
    document.body.classList.add('mfa-required');
    ensureMfaErrorElement('verify');
    byId('mfa-verify-form')?.reset();
    clearMfaInlineError('verify');
    if (els['mfa-setup-dialog']?.open) els['mfa-setup-dialog'].close();
    if (!els['mfa-verify-dialog']?.open) els['mfa-verify-dialog']?.showModal();
    setTimeout(() => byId('mfa-verify-code')?.focus(), 120);
  }

  function clearMfaDialogs() {
    state.mfaRequiredActive = false;
    state.mfa = { factorId: null, challengeId: null, mode: null, enrollment: null };
    document.body.classList.remove('mfa-required');
    byId('mfa-setup-form')?.reset();
    byId('mfa-verify-form')?.reset();
    clearMfaInlineError('setup');
    clearMfaInlineError('verify');
    if (els['mfa-setup-dialog']?.open) els['mfa-setup-dialog'].close();
    if (els['mfa-verify-dialog']?.open) els['mfa-verify-dialog'].close();
  }

  async function finishMfaAndLoadApp() {
    const { data } = await client.auth.getSession();
    state.session = data.session || state.session;
    clearMfaDialogs();
    await loadProtectedAppData();
    toast('Doble factor verificado. Acceso autorizado.');
  }

  async function completeMfaEnrollment(event) {
    event.preventDefault();
    clearMfaInlineError('setup');

    const code = normalizeMfaCode(byId('mfa-setup-code')?.value);
    if (!/^\d{6}$/.test(code)) {
      showMfaInlineError('setup', 'Escribe el código actual de 6 dígitos de tu app autenticadora.');
      return;
    }
    if (!state.mfa?.factorId) {
      showMfaInlineError('setup', 'No hay un factor MFA en proceso. Cierra sesión e intenta de nuevo.');
      return;
    }

    try {
      setBusy(true);
      const challenge = await client.auth.mfa.challenge({ factorId: state.mfa.factorId });
      if (challenge.error) throw challenge.error;

      const { error } = await client.auth.mfa.verify({
        factorId: state.mfa.factorId,
        challengeId: challenge.data.id,
        code
      });
      if (error) throw error;

      await finishMfaAndLoadApp();
    } catch (error) {
      console.error(error);
      showMfaInlineError('setup', mfaFriendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function completeMfaVerification(event) {
    event.preventDefault();
    clearMfaInlineError('verify');

    const code = normalizeMfaCode(byId('mfa-verify-code')?.value);
    if (!/^\d{6}$/.test(code)) {
      showMfaInlineError('verify', 'Escribe el código actual de 6 dígitos de tu app autenticadora.');
      return;
    }
    if (!state.mfa?.factorId || !state.mfa?.challengeId) {
      showMfaInlineError('verify', 'La verificación MFA no está lista. Presiona Renovar código e intenta de nuevo.');
      return;
    }

    try {
      setBusy(true);
      const { error } = await client.auth.mfa.verify({
        factorId: state.mfa.factorId,
        challengeId: state.mfa.challengeId,
        code
      });
      if (error) throw error;

      await finishMfaAndLoadApp();
    } catch (error) {
      console.error(error);
      showMfaInlineError('verify', mfaFriendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function retryMfaChallenge() {
    clearMfaInlineError('verify');
    if (!state.mfa?.factorId) {
      showMfaInlineError('verify', 'No hay factor MFA seleccionado. Cierra sesión e intenta de nuevo.');
      return;
    }

    try {
      setBusy(true);
      await startMfaVerification(state.mfa.factorId);
      toast('Código renovado. Escribe el código actual de tu app.');
    } catch (error) {
      console.error(error);
      showMfaInlineError('verify', mfaFriendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function logoutFromSecurityGate() {
    clearProfileDraft();
    clearForcePasswordDialog();
    clearMfaDialogs();
    await client.auth.signOut();
  }

  async function markPasswordChanged() {
    const { error } = await client.rpc('mark_password_changed');
    if (!error) return;

    console.warn('No se pudo ejecutar mark_password_changed; se intenta actualización directa del perfil.', error);
    const { error: updateError } = await client.from('profiles')
      .update({
        must_change_password: false,
        password_changed_at: new Date().toISOString(),
        password_policy_version: 'LS-2026-V7.1'
      })
      .eq('id', state.session.user.id);
    if (updateError) throw updateError;
  }

  async function completeForcedPasswordChange(event) {
    event.preventDefault();

    if (!state.session?.user?.email) throw new Error('Tu sesión no está lista. Cierra sesión e ingresa otra vez.');

    const currentPassword = byId('force-current-password').value;
    const newPassword = byId('force-new-password').value;
    const confirmation = byId('force-confirm-password').value;

    if (!currentPassword) throw new Error('Escribe tu contraseña temporal actual.');
    if (!passwordMeetsSecurityPolicy(newPassword)) {
      throw new Error('La contraseña nueva debe tener mínimo 12 caracteres, mayúscula, minúscula, número y símbolo.');
    }
    if (newPassword !== confirmation) throw new Error('La confirmación no coincide con la contraseña nueva.');
    if (newPassword === currentPassword) throw new Error('La contraseña nueva no puede ser igual a la temporal.');

    await run(async () => {
      const { error: reauthError } = await client.auth.signInWithPassword({
        email: state.session.user.email,
        password: currentPassword
      });
      if (reauthError) throw new Error('La contraseña temporal actual no es correcta.');

      const { error: updateError } = await client.auth.updateUser({
        password: newPassword,
        current_password: currentPassword
      });
      if (updateError) throw updateError;

      await markPasswordChanged();
      await loadProfile();
      configureAppForProfile(true);
      clearForcePasswordDialog();
      if (await enforceMfaForAll()) await loadProtectedAppData();
    }, 'Contraseña actualizada. Configura o verifica tu doble factor para continuar.');
  }


  async function sendPasswordResetLink(email) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) throw new Error('Escribe tu correo.');

    state.passwordResetEmail = cleanEmail;

    const { error } = await client.auth.resetPasswordForEmail(cleanEmail, {
      redirectTo: `${location.origin}${location.pathname}`
    });

    if (error) throw error;

    if (els['reset-sent-note']) els['reset-sent-note'].classList.remove('hidden');
    toast('Enlace enviado. Revisa tu correo y abre el botón para cambiar la contraseña.');
  }

  async function completePasswordReset(event) {
    event.preventDefault();

    const password = byId('reset-password').value;
    const confirmation = byId('reset-password-confirm').value;

    if (password.length < 10) {
      throw new Error('La contraseña debe tener al menos 10 caracteres.');
    }

    if (password !== confirmation) {
      throw new Error('Las contraseñas no coinciden.');
    }

    const { data: sessionData } = await client.auth.getSession();
    if (!sessionData.session) {
      throw new Error('El enlace de recuperación venció o no es válido. Solicita uno nuevo.');
    }

    state.passwordResetActive = true;

    try {
      await run(async () => {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;

        byId('reset-confirm-form').reset();
        state.passwordResetEmail = '';
        state.passwordResetActive = false;

        await client.auth.signOut();

        history.replaceState({}, document.title, `${location.origin}${location.pathname}`);
        switchAuthTab('login');
      }, 'Contraseña actualizada. Inicia sesión con la nueva contraseña.');
    } finally {
      state.passwordResetActive = false;
    }
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
    if (els['register-form']) {
      els['register-form'].addEventListener('submit', e => {
        e.preventDefault();
        toast('El registro público está desactivado. Solicita el alta a un superadministrador.');
        switchAuthTab('login');
      });
    }
    els['forgot-password'].addEventListener('click', () => {
      showResetPanel(byId('login-email').value.trim());
    });
    els['reset-back-login'].addEventListener('click', () => switchAuthTab('login'));
    els['reset-request-form'].addEventListener('submit', async event => {
      event.preventDefault();
      await run(() => sendPasswordResetLink(byId('reset-email').value));
    });
    els['reset-confirm-form'].addEventListener('submit', completePasswordReset);
    els['force-password-form']?.addEventListener('submit', completeForcedPasswordChange);
    els['force-password-dialog']?.addEventListener('cancel', event => { if (state.profile?.must_change_password) event.preventDefault(); });
    els['force-password-logout']?.addEventListener('click', logoutFromSecurityGate);
    els['mfa-setup-form']?.addEventListener('submit', completeMfaEnrollment);
    els['mfa-setup-dialog']?.addEventListener('cancel', event => event.preventDefault());
    els['mfa-setup-logout']?.addEventListener('click', logoutFromSecurityGate);
    els['mfa-setup-code']?.addEventListener('input', () => clearMfaInlineError('setup'));
    els['mfa-verify-form']?.addEventListener('submit', completeMfaVerification);
    els['mfa-verify-dialog']?.addEventListener('cancel', event => event.preventDefault());
    els['mfa-verify-logout']?.addEventListener('click', logoutFromSecurityGate);
    els['mfa-verify-retry']?.addEventListener('click', retryMfaChallenge);
    els['mfa-verify-code']?.addEventListener('input', () => clearMfaInlineError('verify'));
    els['logout-button'].addEventListener('click', async () => { clearProfileDraft(); clearMfaDialogs(); await client.auth.signOut(); });
    els['main-nav'].addEventListener('click', e => { const b = e.target.closest('[data-section]'); if (b && !b.disabled) navigate(b.dataset.section); });
    els['menu-button'].setAttribute('aria-expanded', 'false');
    els['menu-button'].addEventListener('click', toggleMobileMenu);
    els['menu-overlay']?.addEventListener('click', closeMobileMenu);
    window.addEventListener('keydown', event => { if (event.key === 'Escape') closeMobileMenu(); });
    window.addEventListener('resize', () => { if (window.matchMedia('(min-width: 901px)').matches) closeMobileMenu(); });
    els['document-search'].addEventListener('input', renderDocuments);
    els['document-status-filter'].addEventListener('change', renderDocuments);
    els['history-search']?.addEventListener('input', renderDocumentHistory);
    els['history-action-filter']?.addEventListener('change', renderDocumentHistory);
    els['new-document-form'].addEventListener('submit', createDocument);
    bindPasswordHold(els['login-password-toggle'],byId('login-password'));
    bindPasswordHold(els['register-password-toggle'],byId('register-password'));
    bindPasswordHold(els['reset-password-toggle'],byId('reset-password'));
    bindPasswordHold(els['force-current-password-toggle'],byId('force-current-password'));
    bindPasswordHold(els['force-new-password-toggle'],byId('force-new-password'));
    bindPasswordHold(els['force-confirm-password-toggle'],byId('force-confirm-password'));
    bindPasswordHold(els['reset-password-confirm-toggle'],byId('reset-password-confirm'));
    bindPasswordHold(els['sign-confirm-password-toggle'],byId('sign-confirm-password'));
    els['wizard-next'].addEventListener('click',()=>{try{validateWizardStep(state.wizardStep);setWizardStep(state.wizardStep+1);}catch(error){toast(error.message,true);}});
    els['wizard-back'].addEventListener('click',()=>setWizardStep(state.wizardStep-1));
    qsa('input[name="workflow-mode"]').forEach(input=>input.addEventListener('change',()=>setWorkflowMode(input.value)));
    els['add-approver'].addEventListener('click',()=>addOrderedParticipant(els['approvers-builder'],'approver'));
    els['add-signer'].addEventListener('click',()=>addOrderedParticipant(els['signers-builder'],'signer'));
    els['approvers-builder'].addEventListener('click',event=>handleOrderedListClick(event,els['approvers-builder']));
    els['signers-builder'].addEventListener('click',event=>handleOrderedListClick(event,els['signers-builder']));
    els['flow-add-approver'].addEventListener('click',()=>{els['flow-approval-stage'].classList.remove('hidden');addOrderedParticipant(els['flow-approvers-builder'],'approver');});
    els['flow-add-signer'].addEventListener('click',()=>addOrderedParticipant(els['flow-signers-builder'],'signer'));
    els['flow-approvers-builder'].addEventListener('click',event=>handleOrderedListClick(event,els['flow-approvers-builder']));
    els['flow-signers-builder'].addEventListener('click',event=>handleOrderedListClick(event,els['flow-signers-builder']));
    els['save-flow'].addEventListener('click', saveFlow);
    els['profile-form'].addEventListener('submit', updateProfile);
    ensureSignConfirmSecurityFields();
    els['sign-confirm-form'].addEventListener('submit', confirmVisualSigning);
    els['sign-confirm-password']?.addEventListener('input', clearSignConfirmError);
    els['sign-confirm-mfa-code']?.addEventListener('input', clearSignConfirmError);
    els['sign-consent']?.addEventListener('change', clearSignConfirmError);
    els['template-form'].addEventListener('submit', saveCurrentDocumentAsTemplate);
    els['document-template'].addEventListener('change', applySelectedTemplate);
    els['save-template-button'].addEventListener('click', () => openSaveTemplateDialog());
    ['profile-name','profile-department','profile-phone'].forEach(id => byId(id).addEventListener('input', saveProfileDraft));
    els['prepare-save'].addEventListener('click', () => savePreparedFields(false));
    els['prepare-save-submit'].addEventListener('click', () => savePreparedFields(true));
    els['prepare-prev-page'].addEventListener('click', () => { if(state.prepare && state.prepare.page>1){state.prepare.page--;renderPreparePage();} });
    els['prepare-next-page'].addEventListener('click', () => { if(state.prepare && state.prepare.page<state.prepare.pageCount){state.prepare.page++;renderPreparePage();} });
    els['prepare-zoom-in'].addEventListener('click', () => { if(state.prepare){state.prepare.zoom=Math.min(2,state.prepare.zoom+.15);renderPreparePage();} });
    els['prepare-zoom-out'].addEventListener('click', () => { if(state.prepare){state.prepare.zoom=Math.max(.6,state.prepare.zoom-.15);renderPreparePage();} });
    ['selected-field-assignee','selected-field-label'].forEach(id => byId(id).addEventListener(id==='selected-field-label'?'input':'change', updateSelectedPreparedField));
    els['delete-field'].addEventListener('click', deletePreparedField);
    els['preview-prev-page'].addEventListener('click', () => { if (state.preview && state.preview.page > 1) { state.preview.page -= 1; renderPreviewPage(); } });
    els['preview-next-page'].addEventListener('click', () => { if (state.preview && state.preview.page < state.preview.pageCount) { state.preview.page += 1; renderPreviewPage(); } });
    els['preview-zoom-in'].addEventListener('click', () => { if (state.preview) { state.preview.zoom = Math.min(2.2, state.preview.zoom + 0.15); renderPreviewPage(); } });
    els['preview-zoom-out'].addEventListener('click', () => { if (state.preview) { state.preview.zoom = Math.max(0.55, state.preview.zoom - 0.15); renderPreviewPage(); } });
    els['preview-back-document'].addEventListener('click', returnFromPreviewToDocument);
    els['preview-download'].addEventListener('click', downloadPreviewDocument);
    els['finish-signing'].addEventListener('click', finishVisualSigning);
    els['next-required-field'].addEventListener('click', nextRequiredField);
    els['clear-signature'].addEventListener('click', clearCanvas);
    els['save-signature'].addEventListener('click', saveSignature);
    els['new-conversation'].addEventListener('click', () => { renderConversationMembersPicker(); els['conversation-dialog'].showModal(); });
    els['conversation-form'].addEventListener('submit', createConversation);
    els['chat-form'].addEventListener('submit', sendChatMessage);
    els['mark-all-notifications'].addEventListener('click', async () => {
      await run(async () => {
        const { error } = await client.rpc('mark_all_notifications_read');
        if (error) throw error;
        await loadNotifications(); renderNotifications();
      }, 'Notificaciones marcadas como leídas.');
    });
    els['refresh-users'].addEventListener('click', async () => { await run(async () => { await loadProfiles(); renderAdminUsers(); }, 'Lista actualizada.'); });
    if (els['refresh-email-status']) els['refresh-email-status'].addEventListener('click', async () => { await run(async () => { await loadEmailSystemStatus(); renderEmailSystemStatus(); }, 'Estado de correo actualizado.'); });
    if (els['refresh-admin-dashboard']) els['refresh-admin-dashboard'].addEventListener('click', async () => { await run(async () => { await loadAdminDashboard(); renderAdminDashboard(); }, 'Indicadores actualizados.'); });
    if (els['refresh-templates']) els['refresh-templates'].addEventListener('click', async () => { await run(async () => { await loadTemplates(); renderTemplateList(); }, 'Plantillas actualizadas.'); });

    document.addEventListener('click', async e => {
      const conversation = e.target.closest('[data-open-conversation]'); if (conversation) return openConversation(conversation.dataset.openConversation);
      const openNotification = e.target.closest('[data-open-notification]'); if (openNotification) {
        await client.rpc('mark_notification_read', { p_notification_id: Number(openNotification.dataset.openNotification) });
        await loadNotifications(); renderNotifications();
        return openDocument(openNotification.dataset.notificationDocument);
      }
      const readNotification = e.target.closest('[data-read-notification]'); if (readNotification) {
        await client.rpc('mark_notification_read', { p_notification_id: Number(readNotification.dataset.readNotification) });
        await loadNotifications(); return renderNotifications();
      }
      const go = e.target.closest('[data-go-section]'); if (go) return navigate(go.dataset.goSection);
      const open = e.target.closest('[data-open-document]'); if (open) return openDocument(open.dataset.openDocument);
      const documentChat = e.target.closest('[data-document-chat]'); if (documentChat) return openDocumentConversation(documentChat.dataset.documentChat);
      const retryEmail = e.target.closest('[data-retry-email]'); if (retryEmail) { await run(async () => { const { error } = await client.rpc('admin_retry_email', { p_outbox_id: Number(retryEmail.dataset.retryEmail) }); if (error) throw error; await loadEmailSystemStatus(); renderEmailSystemStatus(); }, 'Correo colocado nuevamente en la cola.'); return; }
      const preview = e.target.closest('[data-preview-document]'); if (preview) return openDocumentPreview(preview.dataset.previewDocument);
      const dl = e.target.closest('[data-download-path]'); if (dl) return downloadPrivate(dl.dataset.downloadPath, dl.dataset.downloadName);
      const replace = e.target.closest('[data-replace-document]'); if (replace) return replaceDocumentFile(replace.dataset.replaceDocument);
      const flow = e.target.closest('[data-configure-flow]'); if (flow) return configureFlow(flow.dataset.configureFlow);
      const prepare = e.target.closest('[data-prepare-document]'); if (prepare) return openPrepareDocument(prepare.dataset.prepareDocument);
      const submit = e.target.closest('[data-submit-document]'); if (submit) return submitDocument(submit.dataset.submitDocument);
      const approve = e.target.closest('[data-approve-document]'); if (approve) return actOnDocument(approve.dataset.approveDocument, 'approve');
      const reject = e.target.closest('[data-reject-document]'); if (reject) return actOnDocument(reject.dataset.rejectDocument, 'reject');
      const sign = e.target.closest('[data-sign-document]'); if (sign) return signDocument(sign.dataset.signDocument);
      const finalize = e.target.closest('[data-finalize-evidence]'); if (finalize) { await finalizeEvidence(finalize.dataset.finalizeEvidence, false); await refreshData(); return openDocument(finalize.dataset.finalizeEvidence); }
      const pause = e.target.closest('[data-pause-document]'); if (pause) return pauseDocument(pause.dataset.pauseDocument);
      const resume = e.target.closest('[data-resume-document]'); if (resume) return resumeDocument(resume.dataset.resumeDocument);
      const cancel = e.target.closest('[data-cancel-document]'); if (cancel) return cancelDocument(cancel.dataset.cancelDocument);
      const extend = e.target.closest('[data-extend-deadline]'); if (extend) return extendDeadline(extend.dataset.extendDeadline);
      const correction = e.target.closest('[data-create-correction]'); if (correction) return createCorrection(correction.dataset.createCorrection);
      const reassign = e.target.closest('[data-reassign-participant]'); if (reassign) return reassignParticipant(reassign.dataset.reassignParticipant, reassign.dataset.reassignDocument, reassign.dataset.reassignRole);
      const saveTemplate = e.target.closest('[data-save-document-template]'); if (saveTemplate) return openSaveTemplateDialog(saveTemplate.dataset.saveDocumentTemplate);
      const deleteTemplateButton = e.target.closest('[data-delete-template]'); if (deleteTemplateButton) return deleteTemplate(deleteTemplateButton.dataset.deleteTemplate);
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
    els['preview-dialog'].addEventListener('close', () => { state.preview = null; els['preview-pages'].innerHTML = ''; });
    window.addEventListener('resize', () => { if (!byId('section-profile').classList.contains('hidden')) prepareCanvas(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.session) queueLiveRefresh('visibility'); });
    window.addEventListener('online', () => { setLiveStatus('syncing'); queueLiveRefresh('online'); });
    window.addEventListener('offline', () => setLiveStatus('disconnected'));
    window.addEventListener('beforeunload', e => { if(state.profileDirty){e.preventDefault();e.returnValue='';} });
  }

  async function handleRecoveryEvent(event, session) {
    const isRecovery = event === 'PASSWORD_RECOVERY' || (state.passwordResetActive && event === 'SIGNED_IN');
    if (!isRecovery) return false;

    state.passwordResetActive = true;
    state.session = session;
    showAuth();
    showResetPanel('', 'confirm');
    toast('Enlace validado. Crea tu contraseña nueva.');
    return true;
  }

  async function init() {
    cacheElements();
    bindEvents();
    resetDocumentWizard();
    state.passwordResetActive = recoveryLinkDetected();
    client.auth.onAuthStateChange((event, session) => {
      setTimeout(async () => {
        try {
          if (await handleRecoveryEvent(event, session)) return;
          if (state.passwordResetActive && event === 'SIGNED_IN') { state.session = session; return; }
          if (state.signReauthActive && (event === 'SIGNED_IN' || event === 'MFA_CHALLENGE_VERIFIED')) { state.session = session; return; }
          if(event==='TOKEN_REFRESHED'||event==='USER_UPDATED'){state.session=session;return;}
          await handleSession(session);
        }
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
