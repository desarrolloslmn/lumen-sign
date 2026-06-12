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
    prepare: null, signing: null,
    workflowCandidates: [], wizardStep: 1,
    notifications: [], conversations: [], activeConversationId: null, activeConversationMembers: [],
    chatChannel: null, chatInboxChannel: null, notificationChannel: null, passwordResetEmail: '', passwordResetActive: false
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
      'reset-panel','reset-request-form','reset-confirm-form','reset-email','reset-code','reset-password','reset-password-confirm','reset-back-login','reset-resend','reset-password-toggle','reset-password-confirm-toggle',
      'login-password-toggle','register-password-toggle','sidebar-user','user-status-pill','pending-banner',
      'next-action-card','stats-grid','recent-documents','documents-table','document-search','document-status-filter',
      'new-document-form','wizard-steps','wizard-back','wizard-next','wizard-create','wizard-message','wizard-review',
      'approval-stage','approvers-builder','signers-builder','add-approver','add-signer',
      'tasks-table','profile-onboarding','profile-form','signature-canvas','clear-signature','save-signature','signature-list','signed-history-table',
      'admin-users-table','refresh-users','document-dialog','document-detail','flow-dialog','flow-approval-stage',
      'flow-approvers-builder','flow-signers-builder','flow-add-approver','flow-add-signer','save-flow',
      'menu-button','main-nav','page-title','page-subtitle','toast',
      'message-unread-badge','notification-unread-badge','new-conversation','conversation-list','chat-header','chat-messages','chat-form','chat-input','conversation-dialog','conversation-form','conversation-title','conversation-members','notifications-list','mark-all-notifications',
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
    els['reset-panel'].classList.add('hidden');
    qsa('[data-auth-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.authTab === tab));
    els['login-form'].classList.toggle('hidden', tab !== 'login');
    els['register-form'].classList.toggle('hidden', tab !== 'register');
    document.querySelector('.tabs').classList.remove('hidden');
  }

  function showResetPanel(email = '') {
    qsa('[data-auth-tab]').forEach(btn => btn.classList.remove('active'));
    els['login-form'].classList.add('hidden');
    els['register-form'].classList.add('hidden');
    document.querySelector('.tabs').classList.add('hidden');
    els['reset-panel'].classList.remove('hidden');
    els['reset-request-form'].classList.remove('hidden');
    els['reset-confirm-form'].classList.add('hidden');
    if (email) byId('reset-email').value = email;
  }

  async function handleSession(session, force = false) {
    state.session = session;
    if (!session) {
      state.profile = null; state.loadedUserId = null; state.profiles = []; state.documents = [];
      state.tasks = []; state.signatures = []; state.appliedSignatures = []; state.notifications = []; state.conversations = []; state.activeConversationId = null;
      if (state.chatChannel) { client.removeChannel(state.chatChannel); state.chatChannel = null; }
      if (state.notificationChannel) { client.removeChannel(state.notificationChannel); state.notificationChannel = null; }
      if (state.chatInboxChannel) { client.removeChannel(state.chatInboxChannel); state.chatInboxChannel = null; }
      showAuth(); return;
    }
    const userId = session.user.id;
    if (!force && state.loadedUserId === userId && state.profile) { showApp(); return; }
    if (state.sessionLoadPromise) return state.sessionLoadPromise;
    state.sessionLoadPromise = (async () => {
      await loadProfile(); showApp(); configureAppForProfile();
      await Promise.all([loadProfiles(), loadWorkflowCandidates(), loadSignatures(), loadDocuments(), loadTasks(), loadAppliedSignatures(), loadNotifications(), loadConversations()]);
      renderAll(); subscribeToNotifications(); subscribeToChatInbox(); state.loadedUserId = userId;
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
      const waitingReason = expectedRole !== task.participant_role
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

  function subscribeToNotifications() {
    if (!state.session || state.notificationChannel) return;
    state.notificationChannel = client.channel(`notifications:${state.session.user.id}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'notifications',
        filter: `user_id=eq.${state.session.user.id}`
      }, async () => {
        await loadNotifications();
        renderNotifications();
        updateUnreadBadges();
        toast('Tienes una nueva notificación.');
      })
      .subscribe();
  }


  function subscribeToChatInbox() {
    if (!state.session || state.chatInboxChannel) return;
    state.chatInboxChannel = client.channel(`chat-inbox:${state.session.user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, async payload => {
        if (payload.new?.sender_id === state.session.user.id) return;
        await loadConversations();
        renderConversations();
        if (payload.new?.conversation_id !== state.activeConversationId) toast('Tienes un mensaje nuevo.');
      })
      .subscribe();
  }

  function configureAppForProfile(forceProfileForm = false) {
    const p = state.profile;
    els['sidebar-user'].innerHTML = `<strong>${escapeHtml(p.full_name || p.email)}</strong><br>${escapeHtml(roleLabels[p.role] || p.role)}`;
    els['user-status-pill'].outerHTML = `<span id="user-status-pill" class="pill ${p.status === 'active' ? 'success' : 'warning'}">${escapeHtml(statusLabels[p.status] || p.status)}</span>`;
    els['user-status-pill'] = byId('user-status-pill');
    els['pending-banner'].classList.toggle('hidden', p.status === 'active');
    els['admin-nav'].classList.toggle('hidden', !isAdmin());
    qsa('[data-section="new-document"], [data-section="tasks"], [data-section="messages"], [data-section="notifications"]').forEach(btn => btn.disabled = !isActive());
    fillProfileForm(forceProfileForm);
  }


  function renderAll() {
    renderDashboard();
    renderDocuments();
    renderTasks();
    renderSignatures();
    renderAppliedSignatures();
    renderOnboarding();
    renderNotifications();
    renderConversations();
    updateUnreadBadges();
    if (isAdmin()) renderAdminUsers();
  }

  function renderDashboard() {
    const counts = {
      total: state.documents.length,
      draft: state.documents.filter(document => document.status === 'draft').length,
      pending: state.tasks.filter(task => task.is_actionable).length,
      completed: state.documents.filter(document => document.status === 'completed').length
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
    const recent = state.documents.slice(0, 6);
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
    const notificationCount = state.notifications.filter(item => !item.read_at).length;
    const messageCount = state.conversations.reduce((sum, item) => sum + Number(item.unread_count || 0), 0);
    els['notification-unread-badge'].textContent = String(notificationCount);
    els['notification-unread-badge'].classList.toggle('hidden', notificationCount === 0);
    els['message-unread-badge'].textContent = String(messageCount);
    els['message-unread-badge'].classList.toggle('hidden', messageCount === 0);
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
    if (!isActive() && ['new-document','tasks','documents','dashboard','messages','notifications'].includes(section)) section = 'profile';
    qsa('.page-section').forEach(s => s.classList.add('hidden'));
    byId(`section-${section}`).classList.remove('hidden');
    qsa('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.section === section));
    const titles = {
      dashboard: ['Inicio', 'Lo que requiere tu atención'], documents: ['Documentos', 'Consulta el estado de cada expediente'],
      'new-document': ['Crear documento', 'Asistente paso a paso'], tasks: ['Mis tareas', 'Solo se habilita la acción de tu turno'],
      messages: ['Mensajes', 'Conversaciones directas y grupos de trabajo'], notifications: ['Notificaciones', 'Avisos de tareas y documentos'],
      profile: ['Perfil y firma', 'Identidad y firma registrada'], admin: ['Usuarios', 'Activa cuentas, asigna funciones y audita conversaciones']
    };
    els['page-title'].textContent = titles[section][0];
    els['page-subtitle'].textContent = titles[section][1];
    document.querySelector('.sidebar').classList.remove('open');
    if (section === 'profile') setTimeout(prepareCanvas, 50);
    if (section === 'new-document') setWizardStep(state.wizardStep || 1);
    if (section === 'messages') { loadConversations().then(renderConversations).catch(error => toast(error.message, true)); }
    if (section === 'notifications') { loadNotifications().then(renderNotifications).catch(error => toast(error.message, true)); }
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

  function readOrderedParticipants(approverContainer, signerContainer, workflowMode = 'approval_signature') {
    const read = (container,role) => qsa('.ordered-row',container).map((row,index) => ({ user_id:row.querySelector('.ordered-user').value, participant_role:role, sequence:index+1 })).filter(item => item.user_id);
    const approvers = workflowMode === 'signature_only' ? [] : read(approverContainer,'approver');
    const signers = read(signerContainer,'signer');
    return [...approvers,...signers];
  }

  function workflowMode() {
    return document.querySelector('input[name="workflow-mode"]:checked')?.value || 'approval_signature';
  }

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
    els['wizard-review'].innerHTML = `<div class="review-card"><h4>Documento</h4><p><strong>${escapeHtml(byId('doc-title').value.trim())}</strong></p><p class="muted">${escapeHtml({contract:'Contrato',invoice:'Factura',other:'Otro'}[byId('doc-category').value])}</p><p class="small">${escapeHtml(byId('doc-file').files[0]?.name||'')}</p></div><div class="review-card"><h4>Proceso</h4><p><strong>${mode==='approval_signature'?'Aprobar y después firmar':'Solo firmas'}</strong></p><p class="muted">El orden queda bloqueado al iniciar.</p></div><div class="review-card"><h4>Aprobadores</h4>${people(approvers)}</div><div class="review-card"><h4>Firmantes</h4>${people(signers)}</div>`;
  }

  function resetDocumentWizard() {
    els['new-document-form'].reset();
    els['approvers-builder'].innerHTML=''; els['signers-builder'].innerHTML='';
    document.querySelector('input[name="workflow-mode"][value="approval_signature"]').checked=true;
    setWorkflowMode('approval_signature');
    addOrderedParticipant(els['signers-builder'],'signer');
    setWizardStep(1);
  }

  async function createDocument(event) {
    event.preventDefault();
    if (!isActive()) throw new Error('Tu cuenta no está activa.');
    validateWizardStep(1); validateWizardStep(3);
    const file=byId('doc-file').files[0], attachment=byId('doc-attachment').files[0];
    const participants=readOrderedParticipants(els['approvers-builder'],els['signers-builder'],workflowMode());
    let newDocId=null;
    await run(async()=>{
      const {data:docId,error:createError}=await client.rpc('create_document',{p_title:byId('doc-title').value.trim(),p_description:byId('doc-description').value.trim(),p_category:byId('doc-category').value});
      if(createError)throw createError; newDocId=docId;
      const filePath=`${docId}/v1/${Date.now()}-${safeFilename(file.name)}`,hash=await sha256(file);
      const upload=await client.storage.from('documents').upload(filePath,file,{contentType:file.type||'application/pdf',upsert:false});if(upload.error)throw upload.error;
      const attached=await client.rpc('attach_primary_file',{p_document_id:docId,p_file_path:filePath,p_file_name:file.name,p_file_hash:hash,p_mime_type:file.type||'application/pdf',p_size_bytes:file.size});if(attached.error)throw attached.error;
      if(attachment){const path=`${docId}/attachments/${Date.now()}-${safeFilename(attachment.name)}`,attachmentHash=await sha256(attachment);const up=await client.storage.from('documents').upload(path,attachment,{contentType:attachment.type||'application/octet-stream'});if(up.error)throw up.error;const rec=await client.rpc('add_document_attachment',{p_document_id:docId,p_file_path:path,p_file_name:attachment.name,p_file_hash:attachmentHash,p_mime_type:attachment.type||'application/octet-stream',p_size_bytes:attachment.size});if(rec.error)throw rec.error;}
      const flow=await client.rpc('set_document_participants',{p_document_id:docId,p_items:participants});if(flow.error)throw flow.error;
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
    const approvers=participants.filter(item=>item.participant_role==='approver').sort((a,b)=>a.sequence-b.sequence);
    const signers=participants.filter(item=>item.participant_role==='signer').sort((a,b)=>a.sequence-b.sequence);
    const hasFields=fields.length>0;
    const processSteps=[
      {key:'draft',label:'Preparación'},
      {key:'approval',label:approvers.length?'Aprobación':'Sin aprobación'},
      {key:'signature',label:'Firmas'},
      {key:'completed',label:'Completado'}
    ];
    const rank={draft:0,rejected:0,awaiting_approval:1,awaiting_signature:2,completed:3,cancelled:3};
    const currentRank=rank[doc.status]??0;
    const track=processSteps.map((step,index)=>`<div class="process-step ${index<currentRank?'done':index===currentRank?'current':'blocked'}">${index+1}. ${step.label}</div>`).join('');
    let guidance='';
    if(doc.status==='draft')guidance=hasFields?'Los espacios de firma están listos. Puedes iniciar el proceso.':'El siguiente paso es indicar dónde debe firmar cada persona.';
    else if(doc.status==='awaiting_approval')guidance=myApproval?'Es tu turno de revisar y decidir.':'El documento está esperando a la persona que debe aprobar antes.';
    else if(doc.status==='awaiting_signature')guidance=mySignature?'Es tu turno de revisar y colocar tu firma.':'El documento está esperando a la persona que debe firmar antes.';
    else if(doc.status==='completed')guidance='El proceso terminó. La versión actual contiene las firmas aplicadas.';
    else if(doc.status==='rejected')guidance='El documento fue rechazado. Contratos o un administrador debe corregirlo.';

    const primary=[];
    if(canConfigure&&!hasFields)primary.push(`<button class="primary" data-prepare-document="${doc.id}">Continuar: indicar dónde firman</button>`);
    if(canConfigure&&hasFields)primary.push(`<button class="primary" data-submit-document="${doc.id}">Iniciar proceso</button>`);
    if(myApproval)primary.push(`<button class="primary" data-approve-document="${doc.id}">Aprobar documento</button><button class="danger" data-reject-document="${doc.id}">Rechazar</button>`);
    if(mySignature)primary.push(`<button class="primary" data-sign-document="${doc.id}">Revisar y firmar</button>`);
    if(doc.status==='completed'&&doc.active_file_path)primary.push(`<button class="primary" data-download-path="${escapeHtml(doc.active_file_path)}" data-download-name="${escapeHtml(doc.active_file_name||'documento.pdf')}">Descargar PDF final</button>`);
    const secondary=[
      doc.active_file_path&&doc.status!=='completed'?`<button class="secondary" data-download-path="${escapeHtml(doc.active_file_path)}" data-download-name="${escapeHtml(doc.active_file_name||'documento.pdf')}">Descargar actual</button>`:'',
      canConfigure&&hasFields?`<button class="secondary" data-prepare-document="${doc.id}">Editar espacios de firma</button>`:'',
      canConfigure?`<button class="secondary" data-configure-flow="${doc.id}">Cambiar responsables</button>`:'',
      canReplace?`<button class="secondary" data-replace-document="${doc.id}">Subir nueva versión</button>`:''
    ].join('');
    const participantList=(items,title,letter)=>`<div class="participant-group"><h3>${title}</h3>${items.length?items.map((item,index)=>`<div class="participant-item"><span>${index===0?'1':index+1}</span><div><strong>${escapeHtml(profileName(item.user_id))}</strong><small class="candidate-note">${index===0?'Actúa primero':'Actúa después de la persona anterior'}${item.acted_at?` · ${fmtDate(item.acted_at)}`:''}</small></div>${pill(item.action_status)}</div>`).join(''):'<p class="muted">Esta etapa se omitió.</p>'}</div>`;

    els['document-detail'].innerHTML=`<div class="stack"><div class="document-hero"><div class="document-hero-top"><div><p class="eyebrow dark">${escapeHtml({contract:'Contrato',invoice:'Factura',other:'Otro'}[doc.category]||doc.category)}</p><h2>${escapeHtml(doc.title)}</h2><p class="muted">${escapeHtml(doc.description||'Sin descripción')}</p></div>${pill(doc.status)}</div><div class="process-track">${track}</div><div class="process-guidance">${escapeHtml(guidance)}</div><div class="document-primary-actions">${primary.join('')}${secondary}</div></div><div class="detail-grid"><div class="detail-tile"><strong>Propietario</strong><p>${escapeHtml(profileName(doc.owner_id))}</p></div><div class="detail-tile"><strong>Versión</strong><p>v${doc.current_version} · ${fmtBytes(doc.size_bytes)}</p></div><div class="detail-tile"><strong>Última actualización</strong><p>${fmtDate(doc.updated_at)}</p></div></div><div class="participant-groups">${participantList(approvers,'Aprobaciones','A')}${participantList(signers,'Firmas','F')}</div><details class="technical-details"><summary>Ver versiones, anexos e historial técnico</summary><div class="stack"><div><h3>Versiones</h3>${versions.length?`<div class="table-wrap"><table><thead><tr><th>Versión</th><th>Archivo</th><th>Hash</th><th>Fecha</th><th></th></tr></thead><tbody>${versions.map(version=>`<tr><td>v${version.version_number}</td><td>${escapeHtml(version.file_name)}</td><td><code title="${escapeHtml(version.file_hash)}">${escapeHtml((version.file_hash||'').slice(0,16))}…</code></td><td>${fmtDate(version.created_at)}</td><td><button class="secondary" data-download-path="${escapeHtml(version.file_path)}" data-download-name="${escapeHtml(version.file_name)}">Descargar</button></td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Sin versiones.</p>'}</div><div><h3>Anexos</h3>${attachments.length?attachments.map(item=>`<div class="signature-card"><span>${escapeHtml(item.file_name)} · ${fmtBytes(item.size_bytes)}</span><button class="secondary" data-download-path="${escapeHtml(item.file_path)}" data-download-name="${escapeHtml(item.file_name)}">Descargar</button></div>`).join(''):'<p class="muted">Sin anexos.</p>'}</div><div><h3>Firmas aplicadas</h3>${signatures.length?signatures.map(item=>`<div class="timeline-item"><strong>${escapeHtml(profileName(item.signer_id))}</strong><p>${fmtDate(item.signed_at)}</p><p class="muted small">Hash: ${escapeHtml((item.file_hash||'').slice(0,24))}…</p></div>`).join(''):'<p class="muted">Aún no hay firmas.</p>'}</div><div><h3>Historial</h3><div class="timeline">${events.length?events.map(event=>`<div class="timeline-item"><strong>${escapeHtml(eventLabel(event.action))}</strong><p>${escapeHtml(profileName(event.actor_id))} · ${fmtDate(event.created_at)}</p>${event.metadata?.comment?`<p>${escapeHtml(event.metadata.comment)}</p>`:''}</div>`).join(''):'<p class="muted">Sin eventos.</p>'}</div></div></div></details></div>`;
  }

  function eventLabel(action) {
    return ({document_created:'Documento creado',primary_file_attached:'Archivo principal cargado',attachment_added:'Anexo agregado',flow_updated:'Flujo actualizado',document_submitted:'Documento enviado',document_approved:'Documento aprobado',document_rejected:'Documento rechazado',document_signed:'Documento firmado',document_completed:'Flujo completado',signature_fields_updated:'Espacios de firma preparados'}[action] || action);
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
    state.flowDocumentId=docId;
    const {data,error}=await client.from('document_participants').select('*').eq('document_id',docId).order('sequence');
    if(error)throw error;
    els['flow-approvers-builder'].innerHTML='';els['flow-signers-builder'].innerHTML='';
    (data||[]).filter(item=>item.participant_role==='approver').forEach(item=>addOrderedParticipant(els['flow-approvers-builder'],'approver',item.user_id));
    (data||[]).filter(item=>item.participant_role==='signer').forEach(item=>addOrderedParticipant(els['flow-signers-builder'],'signer',item.user_id));
    if(!qsa('.ordered-row',els['flow-signers-builder']).length)addOrderedParticipant(els['flow-signers-builder'],'signer');
    if(els['document-dialog'].open)els['document-dialog'].close();
    els['flow-dialog'].showModal();
  }

  async function saveFlow() {
    const mode=qsa('.ordered-row',els['flow-approvers-builder']).length?'approval_signature':'signature_only';
    const items=readOrderedParticipants(els['flow-approvers-builder'],els['flow-signers-builder'],mode);
    if(!items.some(item=>item.participant_role==='signer'))throw new Error('Agrega al menos un firmante.');
    await run(async()=>{const {error}=await client.rpc('set_document_participants',{p_document_id:state.flowDocumentId,p_items:items});if(error)throw error;els['flow-dialog'].close();await refreshData();await openDocument(state.flowDocumentId);},'Responsables actualizados.');
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
    if (value) element.classList.add('completed');
    element.innerHTML += value
      ? `<div class="field-value"><img src="${state.signing.signatureUrl}" alt="Firma"></div>`
      : '<button class="sign-field-button" type="button">Aplicar mi firma</button>';
    const button = element.querySelector('button');
    if (button) button.addEventListener('click', () => {
      values[field.id] = 'signature';
      renderSigningPages(false);
      updateSignProgress();
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

  function addPreparedField() {
    const prepare = state.prepare;
    const assignedTo = els['field-assignee'].value;
    if (!prepare || !assignedTo) throw new Error('Selecciona al firmante.');
    const [width, height] = defaultFieldSize();
    const offset = (prepare.fields.filter(field => Number(field.page_number) === prepare.page).length % 8) * 2;
    const field = {
      id: crypto.randomUUID(),
      document_id: prepare.doc.id,
      assigned_to: assignedTo,
      field_type: 'signature',
      page_number: prepare.page,
      x_pct: 8 + offset,
      y_pct: 10 + offset,
      width_pct: width,
      height_pct: height,
      required: true,
      label: els['field-label'].value.trim() || 'Firma',
      placeholder: ''
    };
    prepare.fields.push(field);
    prepare.selectedId = field.id;
    renderPreparePage().then(() => selectPreparedField(field.id));
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

  function updateSignProgress() {
    const signing = state.signing;
    if (!signing) return;
    const complete = signing.mine.filter(field => String(signing.values[field.id] || '').trim()).length;
    els['sign-progress'].textContent = `${complete} de ${signing.mine.length} firmas colocadas`;
  }

  function nextRequiredField() {
    const signing = state.signing;
    if (!signing) return;
    const target = signing.mine.find(field => !String(signing.values[field.id] || '').trim()) || signing.mine[0];
    if (!target) return;
    const element = els['sign-pages'].querySelector(`[data-field-id="${target.id}"]`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function finishVisualSigning() {
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
      const record = await client.rpc('record_document_signature_v2', {
        p_document_id: signing.doc.id,
        p_user_signature_id: signing.signature.id,
        p_file_path: path,
        p_file_name: fileName,
        p_file_hash: hash,
        p_size_bytes: blob.size,
        p_user_agent: navigator.userAgent.slice(0, 500),
        p_values: signing.mine.map(field => ({ id: field.id, value: 'signature' }))
      });
      if (record.error) throw record.error;
      els['sign-dialog'].close();
      state.signing = null;
      await refreshData();
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
    await Promise.all([loadProfiles(), loadWorkflowCandidates(), loadDocuments(), loadTasks(), loadSignatures(), loadAppliedSignatures(), loadNotifications(), loadConversations()]);
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


  async function sendPasswordResetCode(email) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) throw new Error('Escribe tu correo.');
    state.passwordResetEmail = cleanEmail;
    const { error } = await client.auth.resetPasswordForEmail(cleanEmail, {
      redirectTo: `${location.origin}${location.pathname}`
    });
    if (error) throw error;
    els['reset-request-form'].classList.add('hidden');
    els['reset-confirm-form'].classList.remove('hidden');
    toast('Revisa tu correo e introduce el código de recuperación.');
  }

  async function completePasswordReset(event) {
    event.preventDefault();
    const email = state.passwordResetEmail || byId('reset-email').value.trim();
    const token = byId('reset-code').value.trim();
    const password = byId('reset-password').value;
    const confirmation = byId('reset-password-confirm').value;
    if (!email || !token) throw new Error('Escribe el correo y el código recibido.');
    if (password.length < 10) throw new Error('La contraseña debe tener al menos 10 caracteres.');
    if (password !== confirmation) throw new Error('Las contraseñas no coinciden.');
    state.passwordResetActive = true;
    try {
      await run(async () => {
        const verification = await client.auth.verifyOtp({ email, token, type: 'recovery' });
        if (verification.error) throw verification.error;
        const update = await client.auth.updateUser({ password });
        if (update.error) throw update.error;
        await client.auth.signOut();
        state.passwordResetEmail = '';
        els['reset-request-form'].reset();
        els['reset-confirm-form'].reset();
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
    els['forgot-password'].addEventListener('click', () => {
      showResetPanel(byId('login-email').value.trim());
    });
    els['reset-back-login'].addEventListener('click', () => switchAuthTab('login'));
    els['reset-request-form'].addEventListener('submit', async event => {
      event.preventDefault();
      await run(() => sendPasswordResetCode(byId('reset-email').value));
    });
    els['reset-confirm-form'].addEventListener('submit', completePasswordReset);
    els['reset-resend'].addEventListener('click', async () => {
      await run(() => sendPasswordResetCode(state.passwordResetEmail || byId('reset-email').value));
    });
    els['logout-button'].addEventListener('click', async () => { clearProfileDraft(); await client.auth.signOut(); });
    els['main-nav'].addEventListener('click', e => { const b = e.target.closest('[data-section]'); if (b && !b.disabled) navigate(b.dataset.section); });
    els['menu-button'].addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
    els['document-search'].addEventListener('input', renderDocuments);
    els['document-status-filter'].addEventListener('change', renderDocuments);
    els['new-document-form'].addEventListener('submit', createDocument);
    bindPasswordHold(els['login-password-toggle'],byId('login-password'));
    bindPasswordHold(els['register-password-toggle'],byId('register-password'));
    bindPasswordHold(els['reset-password-toggle'],byId('reset-password'));
    bindPasswordHold(els['reset-password-confirm-toggle'],byId('reset-password-confirm'));
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
    ['profile-name','profile-department','profile-phone'].forEach(id => byId(id).addEventListener('input', saveProfileDraft));
    els['add-field'].addEventListener('click', addPreparedField);
    els['prepare-save'].addEventListener('click', () => savePreparedFields(false));
    els['prepare-save-submit'].addEventListener('click', () => savePreparedFields(true));
    els['prepare-prev-page'].addEventListener('click', () => { if(state.prepare && state.prepare.page>1){state.prepare.page--;renderPreparePage();} });
    els['prepare-next-page'].addEventListener('click', () => { if(state.prepare && state.prepare.page<state.prepare.pageCount){state.prepare.page++;renderPreparePage();} });
    els['prepare-zoom-in'].addEventListener('click', () => { if(state.prepare){state.prepare.zoom=Math.min(2,state.prepare.zoom+.15);renderPreparePage();} });
    els['prepare-zoom-out'].addEventListener('click', () => { if(state.prepare){state.prepare.zoom=Math.max(.6,state.prepare.zoom-.15);renderPreparePage();} });
    ['selected-field-assignee','selected-field-label'].forEach(id => byId(id).addEventListener(id==='selected-field-label'?'input':'change', updateSelectedPreparedField));
    els['delete-field'].addEventListener('click', deletePreparedField);
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
    if (event !== 'PASSWORD_RECOVERY') return false;
    await client.auth.signOut();
    showResetPanel();
    toast('Usa el código recibido por correo para crear una contraseña nueva.');
    return true;
  }

  async function init() {
    cacheElements();
    bindEvents();
    resetDocumentWizard();
    client.auth.onAuthStateChange((event, session) => {
      setTimeout(async () => {
        try {
          if (await handleRecoveryEvent(event)) return;
          if (state.passwordResetActive && event === 'SIGNED_IN') { state.session = session; return; }
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
