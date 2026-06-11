(() => {
  'use strict';

  const cfg = window.LUMEN_CONFIG || {};
  const requiredConfig =
    cfg.supabaseUrl &&
    cfg.supabasePublishableKey &&
    !cfg.supabaseUrl.includes('TU-PROYECTO');

  if (!requiredConfig) {
    document.body.innerHTML = `
      <main style="max-width:760px;margin:60px auto;padding:24px;font-family:system-ui">
        <h1>Falta configurar Supabase</h1>
        <p>Edita <code>config.js</code> y coloca la URL y la clave pública de tu proyecto.</p>
        <p>No uses una clave <code>secret</code> ni <code>service_role</code>.</p>
      </main>`;
    return;
  }

  const client = window.supabase.createClient(
    cfg.supabaseUrl,
    cfg.supabasePublishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );

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
    profileDirty: false,
    loadedUserId: null,
    sessionLoadPromise: null
  };

  const els = {};

  const byId = id => document.getElementById(id);
  const qsa = (selector, root = document) => [
    ...root.querySelectorAll(selector)
  ];

  const isAdmin = () =>
    ['superadmin', 'admin'].includes(state.profile?.role);

  const isContracts = () =>
    state.profile?.role === 'contracts';

  const isActive = () =>
    state.profile?.status === 'active';

  const roleLabels = {
    superadmin: 'Superadministrador',
    admin: 'Administrador',
    contracts: 'Contratos',
    approver: 'Aprobador',
    signer: 'Firmante',
    user: 'Usuario',
    auditor: 'Auditor'
  };

  const statusLabels = {
    pending: 'Pendiente',
    active: 'Activo',
    suspended: 'Suspendido',
    draft: 'Borrador',
    awaiting_approval: 'En aprobación',
    awaiting_signature: 'En firma',
    completed: 'Completado',
    rejected: 'Rechazado',
    cancelled: 'Cancelado',
    approved: 'Aprobado',
    signed: 'Firmado'
  };

  const participantRoleLabels = {
    editor: 'Editor',
    approver: 'Aprobador',
    signer: 'Firmante',
    viewer: 'Consulta'
  };

  function cacheElements() {
    [
      'auth-view',
      'app-view',
      'login-form',
      'register-form',
      'forgot-password',
      'logout-button',
      'admin-nav',
      'sidebar-user',
      'user-status-pill',
      'pending-banner',
      'stats-grid',
      'recent-documents',
      'documents-table',
      'document-search',
      'document-status-filter',
      'new-document-form',
      'participants-builder',
      'add-participant',
      'tasks-table',
      'profile-form',
      'signature-canvas',
      'clear-signature',
      'save-signature',
      'signature-list',
      'signed-history-table',
      'admin-users-table',
      'refresh-users',
      'document-dialog',
      'document-detail',
      'flow-dialog',
      'flow-builder',
      'flow-add-participant',
      'save-flow',
      'menu-button',
      'main-nav',
      'page-title',
      'page-subtitle',
      'toast'
    ].forEach(id => {
      els[id] = byId(id);
    });

    byId('max-file-label').textContent = String(MAX_FILE_MB);
  }

  function toast(message, error = false) {
    els.toast.textContent = message;
    els.toast.className = `toast show${error ? ' error' : ''}`;

    clearTimeout(toast.timer);

    toast.timer = setTimeout(() => {
      els.toast.className = 'toast';
    }, 3800);
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[character]));
  }

  function fmtDate(value) {
    if (!value) return '—';

    return new Intl.DateTimeFormat('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value));
  }

  function fmtBytes(bytes) {
    const number = Number(bytes || 0);

    if (!number) return '—';

    if (number < 1024 * 1024) {
      return `${(number / 1024).toFixed(1)} KB`;
    }

    return `${(number / 1024 / 1024).toFixed(1)} MB`;
  }

  function pill(value) {
    const label = statusLabels[value] || value || '—';

    const className = [
      'completed',
      'approved',
      'signed',
      'active'
    ].includes(value)
      ? 'success'
      : [
          'rejected',
          'cancelled',
          'suspended'
        ].includes(value)
        ? 'danger'
        : [
            'pending',
            'awaiting_approval',
            'awaiting_signature'
          ].includes(value)
          ? 'warning'
          : '';

    return `
      <span class="pill ${className}">
        ${escapeHtml(label)}
      </span>
    `;
  }

  function safeFilename(name) {
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 150);
  }

  async function sha256(input) {
    const buffer =
      input instanceof ArrayBuffer
        ? input
        : await input.arrayBuffer();

    const digest = await crypto.subtle.digest('SHA-256', buffer);

    return [...new Uint8Array(digest)]
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  async function run(task, successMessage = '') {
    try {
      setBusy(true);

      const result = await task();

      if (successMessage) {
        toast(successMessage);
      }

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
      if (button.dataset.keepEnabled === 'true') {
        return;
      }

      if (busy) {
        if (!('busyWasDisabled' in button.dataset)) {
          button.dataset.busyWasDisabled =
            button.disabled ? '1' : '0';
        }

        button.disabled = true;
      } else if ('busyWasDisabled' in button.dataset) {
        button.disabled =
          button.dataset.busyWasDisabled === '1';

        delete button.dataset.busyWasDisabled;
      }
    });

    document.body.style.cursor =
      busy ? 'progress' : '';
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
    qsa('[data-auth-tab]').forEach(button => {
      button.classList.toggle(
        'active',
        button.dataset.authTab === tab
      );
    });

    els['login-form'].classList.toggle(
      'hidden',
      tab !== 'login'
    );

    els['register-form'].classList.toggle(
      'hidden',
      tab !== 'register'
    );
  }

  async function handleSession(session, force = false) {
    state.session = session;

    if (!session) {
      state.profile = null;
      state.loadedUserId = null;
      state.profiles = [];
      state.documents = [];
      state.tasks = [];
      state.signatures = [];
      state.appliedSignatures = [];

      showAuth();
      return;
    }

    const userId = session.user.id;

    /*
     * Supabase puede emitir INITIAL_SESSION, SIGNED_IN
     * y TOKEN_REFRESHED casi al mismo tiempo.
     *
     * No recargamos toda la interfaz si ya está abierta
     * para evitar sobrescribir formularios.
     */
    if (
      !force &&
      state.loadedUserId === userId &&
      state.profile
    ) {
      showApp();
      return;
    }

    if (state.sessionLoadPromise) {
      return state.sessionLoadPromise;
    }

    state.sessionLoadPromise = (async () => {
      await loadProfile();

      showApp();
      configureAppForProfile();

      await Promise.all([
        loadProfiles(),
        loadSignatures(),
        loadDocuments(),
        loadTasks(),
        loadAppliedSignatures()
      ]);

      renderAll();

      state.loadedUserId = userId;
    })();

    try {
      await state.sessionLoadPromise;
    } finally {
      state.sessionLoadPromise = null;
    }
  }

  async function loadProfile() {
    const { data, error } = await client
      .from('profiles')
      .select('*')
      .eq('id', state.session.user.id)
      .single();

    if (error) throw error;

    state.profile = data;
  }
async function loadProfiles() {
  const { data, error } = await client
    .from('profiles')
    .select('id,email,full_name,department,role,status,created_at')
    .order('full_name');

  if (error) throw error;

  state.profiles = data || [];

  // Actualiza los selectores que fueron creados antes
  // de que Supabase terminara de cargar los usuarios.
  refreshParticipantUserOptions();
}

function refreshParticipantUserOptions() {
  qsa('.participant-user').forEach(select => {
    const selectedUserId = select.value;

    const activeUsers = state.profiles.filter(
      profile => profile.status === 'active'
    );

    const options = activeUsers
      .map(profile => `
        <option
          value="${profile.id}"
          ${profile.id === selectedUserId ? 'selected' : ''}
        >
          ${escapeHtml(profile.full_name || profile.email)}
          —
          ${escapeHtml(roleLabels[profile.role] || profile.role)}
        </option>
      `)
      .join('');

    select.innerHTML = `
      <option value="">
        ${activeUsers.length ? 'Selecciona' : 'No hay usuarios activos'}
      </option>
      ${options}
    `;

    if (
      selectedUserId &&
      activeUsers.some(profile => profile.id === selectedUserId)
    ) {
      select.value = selectedUserId;
    }
  });
}

  async function loadDocuments() {
    if (!isActive()) {
      state.documents = [];
      return;
    }

    const { data, error } = await client
      .from('documents')
      .select('*')
      .order('updated_at', {
        ascending: false
      });

    if (error) throw error;

    state.documents = data || [];
  }

  async function loadTasks() {
    if (!isActive()) {
      state.tasks = [];
      return;
    }

    const { data, error } = await client
      .from('document_participants')
      .select(`
        id,
        document_id,
        participant_role,
        sequence,
        action_status,
        documents(
          id,
          title,
          status,
          category,
          updated_at
        )
      `)
      .eq('user_id', state.session.user.id)
      .eq('action_status', 'pending')
      .in('participant_role', [
        'approver',
        'signer'
      ])
      .order('sequence');

    if (error) throw error;

    state.tasks = (data || []).filter(
      item => item.documents
    );
  }

  async function loadSignatures() {
    const { data, error } = await client
      .from('user_signatures')
      .select('*')
      .is('revoked_at', null)
      .order('created_at', {
        ascending: false
      });

    if (error) throw error;

    state.signatures = data || [];
  }

  async function loadAppliedSignatures() {
    if (!isActive()) {
      state.appliedSignatures = [];
      return;
    }

    const { data, error } = await client
      .from('document_signatures')
      .select(`
        id,
        document_id,
        file_hash,
        signed_at,
        documents(
          id,
          title,
          status,
          category,
          active_file_name
        )
      `)
      .eq('signer_id', state.session.user.id)
      .order('signed_at', {
        ascending: false
      });

    if (error) throw error;

    state.appliedSignatures = (data || []).filter(
      item => item.documents
    );
  }

  function configureAppForProfile(
    forceProfileForm = false
  ) {
    const profile = state.profile;

    els['sidebar-user'].innerHTML = `
      <strong>
        ${escapeHtml(
          profile.full_name || profile.email
        )}
      </strong>
      <br>
      ${escapeHtml(
        roleLabels[profile.role] || profile.role
      )}
    `;

    els['user-status-pill'].outerHTML = `
      <span
        id="user-status-pill"
        class="pill ${
          profile.status === 'active'
            ? 'success'
            : 'warning'
        }"
      >
        ${escapeHtml(
          statusLabels[profile.status] ||
          profile.status
        )}
      </span>
    `;

    els['user-status-pill'] =
      byId('user-status-pill');

    els['pending-banner'].classList.toggle(
      'hidden',
      profile.status === 'active'
    );

    els['admin-nav'].classList.toggle(
      'hidden',
      !isAdmin()
    );

    qsa(
      '[data-section="new-document"], [data-section="tasks"]'
    ).forEach(button => {
      button.disabled = !isActive();
    });

    fillProfileForm(forceProfileForm);
  }

  function renderAll() {
    renderDashboard();
    renderDocuments();
    renderTasks();
    renderSignatures();
    renderAppliedSignatures();

    if (isAdmin()) {
      renderAdminUsers();
    }
  }

  function renderDashboard() {
    const counts = {
      total: state.documents.length,
      draft: state.documents.filter(
        document => document.status === 'draft'
      ).length,
      pending: state.tasks.length,
      completed: state.documents.filter(
        document => document.status === 'completed'
      ).length
    };

    els['stats-grid'].innerHTML = [
      ['Documentos visibles', counts.total],
      ['Borradores', counts.draft],
      ['Mis pendientes', counts.pending],
      ['Completados', counts.completed]
    ]
      .map(
        ([label, count]) => `
          <article class="stat">
            <span class="muted">
              ${label}
            </span>
            <strong>
              ${count}
            </strong>
          </article>
        `
      )
      .join('');

    const recent = state.documents.slice(0, 6);

    els['recent-documents'].innerHTML =
      recent.length
        ? documentTable(recent, false)
        : '<div class="empty">Aún no hay actividad.</div>';
  }

  function filteredDocuments() {
    const text = (
      els['document-search'].value || ''
    )
      .trim()
      .toLowerCase();

    const status =
      els['document-status-filter'].value;

    return state.documents.filter(document => {
      const searchableText = `
        ${document.title}
        ${document.description || ''}
      `.toLowerCase();

      const matchesText =
        !text || searchableText.includes(text);

      const matchesStatus =
        !status || document.status === status;

      return matchesText && matchesStatus;
    });
  }

  function renderDocuments() {
    const documents = filteredDocuments();

    els['documents-table'].innerHTML =
      documents.length
        ? documentTable(documents, true)
        : `
          <div class="empty">
            No se encontraron documentos.
          </div>
        `;
  }

  function documentTable(
    documents,
    includeCategory = true
  ) {
    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Título</th>
              ${
                includeCategory
                  ? '<th>Tipo</th>'
                  : ''
              }
              <th>Estado</th>
              <th>Versión</th>
              <th>Actualización</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${documents
              .map(document => `
                <tr>
                  <td>
                    <strong>
                      ${escapeHtml(document.title)}
                    </strong>
                    <br>
                    <span class="muted small">
                      ${escapeHtml(
                        document.active_file_name ||
                        'Sin archivo'
                      )}
                    </span>
                  </td>

                  ${
                    includeCategory
                      ? `
                        <td>
                          ${escapeHtml(
                            {
                              contract: 'Contrato',
                              invoice: 'Factura',
                              other: 'Otro'
                            }[document.category] ||
                            document.category
                          )}
                        </td>
                      `
                      : ''
                  }

                  <td>
                    ${pill(document.status)}
                  </td>

                  <td>
                    v${document.current_version}
                  </td>

                  <td>
                    ${fmtDate(document.updated_at)}
                  </td>

                  <td>
                    <button
                      class="secondary"
                      data-open-document="${document.id}"
                    >
                      Ver
                    </button>
                  </td>
                </tr>
              `)
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderTasks() {
    const tasks = state.tasks;

    els['tasks-table'].innerHTML =
      tasks.length
        ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Documento</th>
                  <th>Mi función</th>
                  <th>Secuencia</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                ${tasks
                  .map(task => `
                    <tr>
                      <td>
                        <strong>
                          ${escapeHtml(
                            task.documents.title
                          )}
                        </strong>
                      </td>

                      <td>
                        ${escapeHtml(
                          participantRoleLabels[
                            task.participant_role
                          ]
                        )}
                      </td>

                      <td>
                        ${task.sequence}
                      </td>

                      <td>
                        ${pill(task.documents.status)}
                      </td>

                      <td>
                        <button
                          class="secondary"
                          data-open-document="${task.document_id}"
                        >
                          Abrir
                        </button>
                      </td>
                    </tr>
                  `)
                  .join('')}
              </tbody>
            </table>
          </div>
        `
        : `
          <div class="empty">
            No tienes acciones pendientes.
          </div>
        `;
  }

  function profileDraftKey() {
    return state.session?.user?.id
      ? `lumen-sign:profile-draft:${state.session.user.id}`
      : '';
  }

  function getProfileDraft() {
    const key = profileDraftKey();

    if (!key) return null;

    try {
      const raw = sessionStorage.getItem(key);

      return raw
        ? JSON.parse(raw)
        : null;
    } catch (error) {
      console.error(
        'No se pudo leer el borrador del perfil:',
        error
      );

      return null;
    }
  }

  function saveProfileDraft() {
    const key = profileDraftKey();

    if (!key) return;

    const draft = {
      full_name: byId('profile-name').value,
      department:
        byId('profile-department').value,
      phone: byId('profile-phone').value
    };

    try {
      sessionStorage.setItem(
        key,
        JSON.stringify(draft)
      );

      state.profileDirty = true;
    } catch (error) {
      console.error(
        'No se pudo guardar el borrador del perfil:',
        error
      );
    }
  }

  function clearProfileDraft() {
    const key = profileDraftKey();

    if (key) {
      sessionStorage.removeItem(key);
    }

    state.profileDirty = false;
  }

  function fillProfileForm(force = false) {
    const profile = state.profile;

    const draft =
      force
        ? null
        : getProfileDraft();

    byId('profile-email').value =
      profile.email || '';

    byId('profile-name').value =
      draft?.full_name ??
      profile.full_name ??
      '';

    byId('profile-department').value =
      draft?.department ??
      profile.department ??
      '';

    byId('profile-phone').value =
      draft?.phone ??
      profile.phone ??
      '';

    byId('profile-role').value =
      roleLabels[profile.role] ||
      profile.role;

    byId('profile-status').value =
      statusLabels[profile.status] ||
      profile.status;

    state.profileDirty = Boolean(draft);
  }

  async function renderSignatures() {
    const rows = [];

    for (const signature of state.signatures) {
      const { data } = await client.storage
        .from('signatures')
        .createSignedUrl(
          signature.storage_path,
          120
        );

      rows.push(`
        <div class="signature-card">
          <div>
            ${
              data?.signedUrl
                ? `
                  <img
                    src="${data.signedUrl}"
                    alt="${escapeHtml(
                      signature.label
                    )}"
                  >
                `
                : ''
            }

            <br>

            <strong>
              ${escapeHtml(signature.label)}
            </strong>

            ${
              signature.is_default
                ? `
                  <span class="pill success">
                    Predeterminada
                  </span>
                `
                : ''
            }

            <br>

            <span class="muted small">
              ${fmtDate(signature.created_at)}
            </span>
          </div>

          <button
            class="danger"
            data-revoke-signature="${signature.id}"
          >
            Revocar
          </button>
        </div>
      `);
    }

    els['signature-list'].innerHTML =
      rows.length
        ? `
          <h3>Mis firmas</h3>
          ${rows.join('')}
        `
        : `
          <div class="empty">
            No tienes una firma registrada.
          </div>
        `;
  }

  function renderAppliedSignatures() {
    const rows = state.appliedSignatures;

    els['signed-history-table'].innerHTML =
      rows.length
        ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Documento</th>
                  <th>Estado</th>
                  <th>Fecha de firma</th>
                  <th>Hash</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                ${rows
                  .map(item => `
                    <tr>
                      <td>
                        <strong>
                          ${escapeHtml(
                            item.documents.title
                          )}
                        </strong>
                      </td>

                      <td>
                        ${pill(
                          item.documents.status
                        )}
                      </td>

                      <td>
                        ${fmtDate(item.signed_at)}
                      </td>

                      <td>
                        <code>
                          ${escapeHtml(
                            (
                              item.file_hash || ''
                            ).slice(0, 18)
                          )}…
                        </code>
                      </td>

                      <td>
                        <button
                          class="secondary"
                          data-open-document="${item.document_id}"
                        >
                          Abrir
                        </button>
                      </td>
                    </tr>
                  `)
                  .join('')}
              </tbody>
            </table>
          </div>
        `
        : `
          <div class="empty">
            Todavía no has firmado documentos.
          </div>
        `;
  }

  function renderAdminUsers() {
    const canSetAdmin =
      state.profile.role === 'superadmin';

    const roles = [
      'user',
      'approver',
      'signer',
      'contracts',
      'auditor',
      ...(canSetAdmin
        ? ['admin', 'superadmin']
        : [])
    ];

    els['admin-users-table'].innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Departamento</th>
              <th>Rol</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${state.profiles
              .map(profile => {
                const protectedAccount =
                  profile.id === state.profile.id ||
                  (
                    !canSetAdmin &&
                    [
                      'admin',
                      'superadmin'
                    ].includes(profile.role)
                  );

                const availableRoles =
                  roles.includes(profile.role)
                    ? roles
                    : [
                        profile.role,
                        ...roles
                      ];

                return `
                  <tr>
                    <td>
                      <strong>
                        ${escapeHtml(
                          profile.full_name ||
                          'Sin nombre'
                        )}
                      </strong>

                      <br>

                      <span class="muted small">
                        ${escapeHtml(profile.email)}
                      </span>
                    </td>

                    <td>
                      ${escapeHtml(
                        profile.department || '—'
                      )}
                    </td>

                    <td>
                      <select
                        data-admin-role="${profile.id}"
                        ${
                          protectedAccount
                            ? 'disabled'
                            : ''
                        }
                      >
                        ${availableRoles
                          .map(role => `
                            <option
                              value="${role}"
                              ${
                                profile.role === role
                                  ? 'selected'
                                  : ''
                              }
                            >
                              ${roleLabels[role]}
                            </option>
                          `)
                          .join('')}
                      </select>
                    </td>

                    <td>
                      <select
                        data-admin-status="${profile.id}"
                        ${
                          protectedAccount
                            ? 'disabled'
                            : ''
                        }
                      >
                        <option
                          value="pending"
                          ${
                            profile.status ===
                            'pending'
                              ? 'selected'
                              : ''
                          }
                        >
                          Pendiente
                        </option>

                        <option
                          value="active"
                          ${
                            profile.status ===
                            'active'
                              ? 'selected'
                              : ''
                          }
                        >
                          Activo
                        </option>

                        <option
                          value="suspended"
                          ${
                            profile.status ===
                            'suspended'
                              ? 'selected'
                              : ''
                          }
                        >
                          Suspendido
                        </option>
                      </select>
                    </td>

                    <td>
                      <button
                        class="primary"
                        data-save-user="${profile.id}"
                        ${
                          protectedAccount
                            ? 'disabled'
                            : ''
                        }
                      >
                        Guardar
                      </button>
                    </td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function navigate(section) {
    if (
      !isActive() &&
      [
        'new-document',
        'tasks',
        'documents',
        'dashboard'
      ].includes(section)
    ) {
      section = 'profile';
    }

    qsa('.page-section').forEach(page => {
      page.classList.add('hidden');
    });

    byId(`section-${section}`)
      .classList
      .remove('hidden');

    qsa('.nav-item').forEach(button => {
      button.classList.toggle(
        'active',
        button.dataset.section === section
      );
    });

    const titles = {
      dashboard: [
        'Resumen',
        'Estado general de tus documentos'
      ],
      documents: [
        'Documentos',
        'Expedientes a los que tienes acceso'
      ],
      'new-document': [
        'Nuevo documento',
        'Carga un PDF y define su flujo'
      ],
      tasks: [
        'Mis pendientes',
        'Aprobaciones y firmas asignadas'
      ],
      profile: [
        'Mi perfil y firma',
        'Datos personales y firma registrada'
      ],
      admin: [
        'Administración',
        'Usuarios, estados y permisos'
      ]
    };

    els['page-title'].textContent =
      titles[section][0];

    els['page-subtitle'].textContent =
      titles[section][1];

    document
      .querySelector('.sidebar')
      .classList
      .remove('open');

    if (section === 'profile') {
      setTimeout(prepareCanvas, 50);
    }
  }

  function activeProfilesOptions(selected = '') {
    return state.profiles
      .filter(profile => profile.status === 'active')
      .map(profile => `
        <option
          value="${profile.id}"
          ${
            profile.id === selected
              ? 'selected'
              : ''
          }
        >
          ${escapeHtml(
            profile.full_name ||
            profile.email
          )}
          —
          ${escapeHtml(
            roleLabels[profile.role] ||
            profile.role
          )}
        </option>
      `)
      .join('');
  }

  function addParticipantRow(
    container,
    value = {}
  ) {
    const row = document.createElement('div');

    row.className = 'participant-row';

    row.innerHTML = `
      <label>
        Usuario

        <select
          class="participant-user"
          required
        >
          <option value="">
            Selecciona
          </option>

          ${activeProfilesOptions(
            value.user_id
          )}
        </select>
      </label>

      <label>
        Función

        <select class="participant-role">
          <option
            value="approver"
            ${
              value.participant_role ===
              'approver'
                ? 'selected'
                : ''
            }
          >
            Aprobador
          </option>

          <option
            value="signer"
            ${
              value.participant_role ===
              'signer'
                ? 'selected'
                : ''
            }
          >
            Firmante
          </option>

          <option
            value="editor"
            ${
              value.participant_role ===
              'editor'
                ? 'selected'
                : ''
            }
          >
            Editor
          </option>

          <option
            value="viewer"
            ${
              value.participant_role ===
              'viewer'
                ? 'selected'
                : ''
            }
          >
            Consulta
          </option>
        </select>
      </label>

      <label>
        Secuencia

        <input
          class="participant-sequence"
          type="number"
          min="1"
          max="99"
          value="${Number(
            value.sequence || 1
          )}"
          required
        >
      </label>

      <button
        class="danger remove-participant"
        type="button"
      >
        Quitar
      </button>
    `;

    container.appendChild(row);
  }

  function readParticipantRows(container) {
    return qsa(
      '.participant-row',
      container
    )
      .map(row => ({
        user_id:
          row.querySelector(
            '.participant-user'
          ).value,

        participant_role:
          row.querySelector(
            '.participant-role'
          ).value,

        sequence: Number(
          row.querySelector(
            '.participant-sequence'
          ).value
        )
      }))
      .filter(participant => participant.user_id);
  }

  async function createDocument(event) {
    event.preventDefault();

    if (!isActive()) {
      throw new Error(
        'Tu cuenta no está activa.'
      );
    }

    const file =
      byId('doc-file').files[0];

    const attachment =
      byId('doc-attachment').files[0];

    validateFile(
      file,
      ['application/pdf'],
      true
    );

    if (attachment) {
      validateFile(
        attachment,
        [],
        false
      );
    }

    const participants =
      readParticipantRows(
        els['participants-builder']
      );

    if (
      !participants.some(
        participant =>
          participant.participant_role ===
          'signer'
      )
    ) {
      throw new Error(
        'Agrega al menos un firmante.'
      );
    }

    await run(async () => {
      const {
        data: documentId,
        error: createError
      } = await client.rpc(
        'create_document',
        {
          p_title:
            byId('doc-title')
              .value
              .trim(),

          p_description:
            byId('doc-description')
              .value
              .trim(),

          p_category:
            byId('doc-category').value
        }
      );

      if (createError) {
        throw createError;
      }

      const filePath = `
        ${documentId}/v1/${Date.now()}-${safeFilename(
          file.name
        )}
      `.trim();

      const hash = await sha256(file);

      const {
        error: uploadError
      } = await client.storage
        .from('documents')
        .upload(
          filePath,
          file,
          {
            contentType: file.type,
            upsert: false
          }
        );

      if (uploadError) {
        throw uploadError;
      }

      const {
        error: attachError
      } = await client.rpc(
        'attach_primary_file',
        {
          p_document_id: documentId,
          p_file_path: filePath,
          p_file_name: file.name,
          p_file_hash: hash,
          p_mime_type:
            file.type ||
            'application/pdf',
          p_size_bytes: file.size
        }
      );

      if (attachError) {
        throw attachError;
      }

      if (attachment) {
        const attachmentPath = `
          ${documentId}/attachments/${Date.now()}-${safeFilename(
            attachment.name
          )}
        `.trim();

        const attachmentHash =
          await sha256(attachment);

        const {
          error: attachmentUploadError
        } = await client.storage
          .from('documents')
          .upload(
            attachmentPath,
            attachment,
            {
              contentType:
                attachment.type ||
                'application/octet-stream'
            }
          );

        if (attachmentUploadError) {
          throw attachmentUploadError;
        }

        const {
          error: attachmentRecordError
        } = await client.rpc(
          'add_document_attachment',
          {
            p_document_id: documentId,
            p_file_path: attachmentPath,
            p_file_name: attachment.name,
            p_file_hash: attachmentHash,
            p_mime_type:
              attachment.type ||
              'application/octet-stream',
            p_size_bytes: attachment.size
          }
        );

        if (attachmentRecordError) {
          throw attachmentRecordError;
        }
      }

      const {
        error: flowError
      } = await client.rpc(
        'set_document_participants',
        {
          p_document_id: documentId,
          p_items: participants
        }
      );

      if (flowError) {
        throw flowError;
      }

      if (
        byId('submit-immediately').checked
      ) {
        const {
          error: submitError
        } = await client.rpc(
          'submit_document',
          {
            p_document_id: documentId
          }
        );

        if (submitError) {
          throw submitError;
        }
      }

      event.target.reset();

      els[
        'participants-builder'
      ].innerHTML = '';

      addParticipantRow(
        els['participants-builder'],
        {
          participant_role: 'approver',
          sequence: 1
        }
      );

      addParticipantRow(
        els['participants-builder'],
        {
          participant_role: 'signer',
          sequence: 1
        }
      );

      await refreshData();

      navigate('documents');
    }, 'Documento creado correctamente.');
  }

  function validateFile(
    file,
    mimeTypes = [],
    required = false
  ) {
    if (!file && required) {
      throw new Error(
        'Selecciona un archivo.'
      );
    }

    if (!file) return;

    if (
      file.size >
      MAX_FILE_MB * 1024 * 1024
    ) {
      throw new Error(
        `El archivo excede ${MAX_FILE_MB} MB.`
      );
    }

    if (
      mimeTypes.length &&
      !mimeTypes.includes(file.type) &&
      !file.name
        .toLowerCase()
        .endsWith('.pdf')
    ) {
      throw new Error(
        'El documento principal debe ser PDF.'
      );
    }
  }

  async function openDocument(id) {
    state.activeDocumentId = id;

    await run(async () => {
      const [
        documentResponse,
        participantsResponse,
        versionsResponse,
        attachmentsResponse,
        eventsResponse,
        signaturesResponse
      ] = await Promise.all([
        client
          .from('documents')
          .select('*')
          .eq('id', id)
          .single(),

        client
          .from('document_participants')
          .select('*')
          .eq('document_id', id)
          .order('sequence'),

        client
          .from('document_versions')
          .select('*')
          .eq('document_id', id)
          .order('version_number', {
            ascending: false
          }),

        client
          .from('document_attachments')
          .select('*')
          .eq('document_id', id)
          .order('created_at', {
            ascending: false
          }),

        client
          .from('audit_events')
          .select('*')
          .eq('document_id', id)
          .order('created_at', {
            ascending: false
          }),

        client
          .from('document_signatures')
          .select('*')
          .eq('document_id', id)
          .order('signed_at', {
            ascending: false
          })
      ]);

      [
        documentResponse,
        participantsResponse,
        versionsResponse,
        attachmentsResponse,
        eventsResponse,
        signaturesResponse
      ].forEach(response => {
        if (response.error) {
          throw response.error;
        }
      });

      renderDocumentDetail(
        documentResponse.data,
        participantsResponse.data || [],
        versionsResponse.data || [],
        attachmentsResponse.data || [],
        eventsResponse.data || [],
        signaturesResponse.data || []
      );

      els['document-dialog'].showModal();
    });
  }

  function profileName(id) {
    const profile = state.profiles.find(
      item => item.id === id
    );

    return (
      profile?.full_name ||
      profile?.email ||
      'Usuario'
    );
  }

  function renderDocumentDetail(
    documentRecord,
    participants,
    versions,
    attachments,
    events,
    signatures
  ) {
    const currentUserId =
      state.session.user.id;

    const myApproval =
      participants.find(participant =>
        participant.user_id ===
          currentUserId &&
        participant.participant_role ===
          'approver' &&
        participant.action_status ===
          'pending'
      );

    const mySignature =
      participants.find(participant =>
        participant.user_id ===
          currentUserId &&
        participant.participant_role ===
          'signer' &&
        participant.action_status ===
          'pending'
      );

    const isAssignedEditor =
      participants.some(participant =>
        participant.user_id ===
          currentUserId &&
        participant.participant_role ===
          'editor'
      );

    const canConfigure =
      documentRecord.status === 'draft' &&
      (
        documentRecord.owner_id ===
          currentUserId ||
        isAdmin() ||
        isContracts() ||
        isAssignedEditor
      );

    const canReplace =
      (
        documentRecord.status ===
          'draft' &&
        (
          documentRecord.owner_id ===
            currentUserId ||
          isAdmin() ||
          isContracts() ||
          isAssignedEditor
        )
      ) ||
      (
        documentRecord.status ===
          'rejected' &&
        (
          isAdmin() ||
          isContracts()
        )
      );

    const actions = [
      documentRecord.active_file_path
        ? `
          <button
            class="secondary"
            data-download-path="${escapeHtml(
              documentRecord.active_file_path
            )}"
            data-download-name="${escapeHtml(
              documentRecord.active_file_name ||
              'documento.pdf'
            )}"
          >
            Descargar actual
          </button>
        `
        : '',

      canReplace
        ? `
          <button
            class="secondary"
            data-replace-document="${documentRecord.id}"
          >
            Subir nueva versión
          </button>
        `
        : '',

      canConfigure
        ? `
          <button
            class="secondary"
            data-configure-flow="${documentRecord.id}"
          >
            Configurar flujo
          </button>

          <button
            class="primary"
            data-submit-document="${documentRecord.id}"
          >
            Enviar a flujo
          </button>
        `
        : '',

      myApproval &&
      documentRecord.status ===
        'awaiting_approval'
        ? `
          <button
            class="primary"
            data-approve-document="${documentRecord.id}"
          >
            Aprobar
          </button>

          <button
            class="danger"
            data-reject-document="${documentRecord.id}"
          >
            Rechazar
          </button>
        `
        : '',

      mySignature &&
      documentRecord.status ===
        'awaiting_signature'
        ? `
          <button
            class="primary"
            data-sign-document="${documentRecord.id}"
          >
            Firmar documento
          </button>
        `
        : ''
    ].join('');

    els['document-detail'].innerHTML = `
      <div class="stack">
        <div>
          <h2>
            ${escapeHtml(
              documentRecord.title
            )}
          </h2>

          <div class="button-row">
            ${actions}
          </div>
        </div>

        <div class="detail-grid">
          <div>
            <strong>Estado</strong>
            <p>
              ${pill(documentRecord.status)}
            </p>
          </div>

          <div>
            <strong>Tipo</strong>
            <p>
              ${escapeHtml(
                {
                  contract: 'Contrato',
                  invoice: 'Factura',
                  other: 'Otro'
                }[documentRecord.category] ||
                documentRecord.category
              )}
            </p>
          </div>

          <div>
            <strong>Propietario</strong>
            <p>
              ${escapeHtml(
                profileName(
                  documentRecord.owner_id
                )
              )}
            </p>
          </div>

          <div>
            <strong>Versión actual</strong>
            <p>
              v${documentRecord.current_version}
              ·
              ${fmtBytes(
                documentRecord.size_bytes
              )}
            </p>
          </div>

          <div>
            <strong>Creado</strong>
            <p>
              ${fmtDate(
                documentRecord.created_at
              )}
            </p>
          </div>

          <div>
            <strong>
              Última actualización
            </strong>
            <p>
              ${fmtDate(
                documentRecord.updated_at
              )}
            </p>
          </div>
        </div>

        <div>
          <strong>Descripción</strong>
          <p>
            ${escapeHtml(
              documentRecord.description ||
              'Sin descripción'
            )}
          </p>
        </div>

        <div>
          <h3>Participantes</h3>

          ${
            participants.length
              ? `
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Usuario</th>
                        <th>Función</th>
                        <th>Secuencia</th>
                        <th>Estado</th>
                        <th>Fecha</th>
                      </tr>
                    </thead>

                    <tbody>
                      ${participants
                        .map(participant => `
                          <tr>
                            <td>
                              ${escapeHtml(
                                profileName(
                                  participant.user_id
                                )
                              )}
                            </td>

                            <td>
                              ${escapeHtml(
                                participantRoleLabels[
                                  participant.participant_role
                                ]
                              )}
                            </td>

                            <td>
                              ${participant.sequence}
                            </td>

                            <td>
                              ${pill(
                                participant.action_status
                              )}
                            </td>

                            <td>
                              ${fmtDate(
                                participant.acted_at
                              )}
                            </td>
                          </tr>
                        `)
                        .join('')}
                    </tbody>
                  </table>
                </div>
              `
              : `
                <div class="empty">
                  Sin participantes.
                </div>
              `
          }
        </div>

        <div>
          <h3>Versiones</h3>

          ${
            versions.length
              ? `
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Versión</th>
                        <th>Archivo</th>
                        <th>Hash SHA-256</th>
                        <th>Fecha</th>
                        <th></th>
                      </tr>
                    </thead>

                    <tbody>
                      ${versions
                        .map(version => `
                          <tr>
                            <td>
                              v${version.version_number}
                            </td>

                            <td>
                              ${escapeHtml(
                                version.file_name
                              )}
                            </td>

                            <td>
                              <code
                                title="${escapeHtml(
                                  version.file_hash
                                )}"
                              >
                                ${escapeHtml(
                                  (
                                    version.file_hash ||
                                    ''
                                  ).slice(0, 16)
                                )}…
                              </code>
                            </td>

                            <td>
                              ${fmtDate(
                                version.created_at
                              )}
                            </td>

                            <td>
                              <button
                                class="secondary"
                                data-download-path="${escapeHtml(
                                  version.file_path
                                )}"
                                data-download-name="${escapeHtml(
                                  version.file_name
                                )}"
                              >
                                Descargar
                              </button>
                            </td>
                          </tr>
                        `)
                        .join('')}
                    </tbody>
                  </table>
                </div>
              `
              : `
                <div class="empty">
                  Sin versiones.
                </div>
              `
          }
        </div>

        <div>
          <h3>Anexos</h3>

          ${
            attachments.length
              ? attachments
                  .map(attachment => `
                    <div class="signature-card">
                      <span>
                        ${escapeHtml(
                          attachment.file_name
                        )}
                        ·
                        ${fmtBytes(
                          attachment.size_bytes
                        )}
                      </span>

                      <button
                        class="secondary"
                        data-download-path="${escapeHtml(
                          attachment.file_path
                        )}"
                        data-download-name="${escapeHtml(
                          attachment.file_name
                        )}"
                      >
                        Descargar
                      </button>
                    </div>
                  `)
                  .join('')
              : `
                <p class="muted">
                  Sin anexos.
                </p>
              `
          }
        </div>

        <div>
          <h3>Firmas aplicadas</h3>

          ${
            signatures.length
              ? signatures
                  .map(signature => `
                    <div class="timeline-item">
                      <strong>
                        ${escapeHtml(
                          profileName(
                            signature.signer_id
                          )
                        )}
                      </strong>

                      <p>
                        ${fmtDate(
                          signature.signed_at
                        )}
                      </p>

                      <p class="muted small">
                        Hash:
                        ${escapeHtml(
                          (
                            signature.file_hash ||
                            ''
                          ).slice(0, 24)
                        )}…
                      </p>
                    </div>
                  `)
                  .join('')
              : `
                <p class="muted">
                  Aún no hay firmas.
                </p>
              `
          }
        </div>

        <div>
          <h3>Historial</h3>

          <div class="timeline">
            ${
              events.length
                ? events
                    .map(event => `
                      <div class="timeline-item">
                        <strong>
                          ${escapeHtml(
                            eventLabel(
                              event.action
                            )
                          )}
                        </strong>

                        <p>
                          ${escapeHtml(
                            profileName(
                              event.actor_id
                            )
                          )}
                          ·
                          ${fmtDate(
                            event.created_at
                          )}
                        </p>

                        ${
                          event.metadata?.comment
                            ? `
                              <p>
                                ${escapeHtml(
                                  event.metadata.comment
                                )}
                              </p>
                            `
                            : ''
                        }
                      </div>
                    `)
                    .join('')
                : `
                  <p class="muted">
                    Sin eventos.
                  </p>
                `
            }
          </div>
        </div>
      </div>
    `;
  }

  function eventLabel(action) {
    return {
      document_created:
        'Documento creado',
      primary_file_attached:
        'Archivo principal cargado',
      attachment_added:
        'Anexo agregado',
      flow_updated:
        'Flujo actualizado',
      document_submitted:
        'Documento enviado',
      document_approved:
        'Documento aprobado',
      document_rejected:
        'Documento rechazado',
      document_signed:
        'Documento firmado',
      document_completed:
        'Flujo completado'
    }[action] || action;
  }

  async function replaceDocumentFile(id) {
    const input =
      document.createElement('input');

    input.type = 'file';
    input.accept = 'application/pdf,.pdf';

    input.addEventListener(
      'change',
      async () => {
        const file = input.files?.[0];

        if (!file) return;

        validateFile(
          file,
          ['application/pdf'],
          true
        );

        await run(async () => {
          const documentRecord =
            state.documents.find(
              document => document.id === id
            ) ||
            (
              await client
                .from('documents')
                .select('*')
                .eq('id', id)
                .single()
            ).data;

          const nextVersion =
            Number(
              documentRecord.current_version
            ) + 1;

          const path = `
            ${id}/v${nextVersion}/${Date.now()}-${safeFilename(
              file.name
            )}
          `.trim();

          const hash = await sha256(file);

          const {
            error: uploadError
          } = await client.storage
            .from('documents')
            .upload(
              path,
              file,
              {
                contentType:
                  file.type ||
                  'application/pdf',

                upsert: false
              }
            );

          if (uploadError) {
            throw uploadError;
          }

          const { error } = await client.rpc(
            'attach_primary_file',
            {
              p_document_id: id,
              p_file_path: path,
              p_file_name: file.name,
              p_file_hash: hash,
              p_mime_type:
                file.type ||
                'application/pdf',
              p_size_bytes: file.size
            }
          );

          if (error) throw error;

          if (
            els['document-dialog'].open
          ) {
            els['document-dialog'].close();
          }

          await refreshData();
          await openDocument(id);
        }, 'Nueva versión cargada.');
      },
      {
        once: true
      }
    );

    input.click();
  }

  async function downloadPrivate(path, name) {
    await run(async () => {
      const { data, error } =
        await client.storage
          .from('documents')
          .createSignedUrl(
            path,
            90,
            {
              download: name
            }
          );

      if (error) throw error;

      const link =
        document.createElement('a');

      link.href = data.signedUrl;
      link.download = name;
      link.target = '_blank';
      link.rel = 'noopener';

      link.click();
    });
  }

  async function configureFlow(documentId) {
    state.flowDocumentId = documentId;

    const { data, error } = await client
      .from('document_participants')
      .select('*')
      .eq('document_id', documentId)
      .order('sequence');

    if (error) throw error;

    els['flow-builder'].innerHTML = '';

    (data || []).forEach(participant => {
      addParticipantRow(
        els['flow-builder'],
        participant
      );
    });

    if (!(data || []).length) {
      addParticipantRow(
        els['flow-builder'],
        {
          participant_role: 'signer',
          sequence: 1
        }
      );
    }

    if (els['document-dialog'].open) {
      els['document-dialog'].close();
    }

    els['flow-dialog'].showModal();
  }

  async function saveFlow() {
    const items =
      readParticipantRows(
        els['flow-builder']
      );

    if (
      !items.some(
        participant =>
          participant.participant_role ===
          'signer'
      )
    ) {
      throw new Error(
        'Agrega al menos un firmante.'
      );
    }

    await run(async () => {
      const { error } = await client.rpc(
        'set_document_participants',
        {
          p_document_id:
            state.flowDocumentId,

          p_items: items
        }
      );

      if (error) throw error;

      els['flow-dialog'].close();

      await refreshData();

      await openDocument(
        state.flowDocumentId
      );
    }, 'Flujo actualizado.');
  }

  async function submitDocument(id) {
    await run(async () => {
      const { error } = await client.rpc(
        'submit_document',
        {
          p_document_id: id
        }
      );

      if (error) throw error;

      els['document-dialog'].close();

      await refreshData();
    }, 'Documento enviado al flujo.');
  }

  async function actOnDocument(id, action) {
    const comment =
      prompt(
        action === 'approve'
          ? 'Comentario opcional de aprobación:'
          : 'Motivo del rechazo:'
      ) || '';

    if (
      action === 'reject' &&
      !comment.trim()
    ) {
      throw new Error(
        'Escribe el motivo del rechazo.'
      );
    }

    await run(async () => {
      const { error } = await client.rpc(
        'act_on_document',
        {
          p_document_id: id,
          p_action: action,
          p_comment: comment.trim()
        }
      );

      if (error) throw error;

      els['document-dialog'].close();

      await refreshData();
    },
    action === 'approve'
      ? 'Aprobación registrada.'
      : 'Documento rechazado.'
    );
  }

  async function signDocument(id) {
    const defaultSignature =
      state.signatures.find(
        signature =>
          signature.is_default &&
          !signature.revoked_at
      ) ||
      state.signatures[0];

    if (!defaultSignature) {
      throw new Error(
        'Primero registra una firma en Mi perfil y firma.'
      );
    }

    if (
      !confirm(
        'Se generará una nueva versión PDF con tu firma y evidencia. ¿Continuar?'
      )
    ) {
      return;
    }

    await run(async () => {
      const {
        data: documentRecord,
        error: documentError
      } = await client
        .from('documents')
        .select('*')
        .eq('id', id)
        .single();

      if (documentError) {
        throw documentError;
      }

      if (
        documentRecord.mime_type !==
          'application/pdf' &&
        !documentRecord.active_file_name
          .toLowerCase()
          .endsWith('.pdf')
      ) {
        throw new Error(
          'Solo se pueden firmar archivos PDF.'
        );
      }

      const [
        {
          data: documentUrl,
          error: documentUrlError
        },
        {
          data: signatureUrl,
          error: signatureUrlError
        }
      ] = await Promise.all([
        client.storage
          .from('documents')
          .createSignedUrl(
            documentRecord.active_file_path,
            180
          ),

        client.storage
          .from('signatures')
          .createSignedUrl(
            defaultSignature.storage_path,
            180
          )
      ]);

      if (documentUrlError) {
        throw documentUrlError;
      }

      if (signatureUrlError) {
        throw signatureUrlError;
      }

      const [
        pdfBytes,
        signatureBytes
      ] = await Promise.all([
        fetch(documentUrl.signedUrl)
          .then(response => {
            if (!response.ok) {
              throw new Error(
                'No se pudo leer el PDF.'
              );
            }

            return response.arrayBuffer();
          }),

        fetch(signatureUrl.signedUrl)
          .then(response => {
            if (!response.ok) {
              throw new Error(
                'No se pudo leer la firma.'
              );
            }

            return response.arrayBuffer();
          })
      ]);

      const {
        PDFDocument,
        StandardFonts,
        rgb
      } = window.PDFLib;

      const pdfDocument =
        await PDFDocument.load(pdfBytes);

      const signatureImage =
        await pdfDocument.embedPng(
          signatureBytes
        );

      const font =
        await pdfDocument.embedFont(
          StandardFonts.Helvetica
        );

      const pages =
        pdfDocument.getPages();

      const page =
        pages[pages.length - 1];

      const { width } =
        page.getSize();

      const boxWidth =
        Math.min(250, width * 0.42);

      const boxHeight = 95;

      const x =
        Math.max(
          24,
          width - boxWidth - 28
        );

      const y = 28;

      page.drawRectangle({
        x,
        y,
        width: boxWidth,
        height: boxHeight,
        color: rgb(
          0.97,
          0.98,
          0.99
        ),
        borderColor: rgb(
          0.35,
          0.45,
          0.55
        ),
        borderWidth: 1,
        opacity: 0.94
      });

      const scaled =
        signatureImage.scaleToFit(
          boxWidth - 30,
          42
        );

      page.drawImage(
        signatureImage,
        {
          x: x + 15,
          y: y + 43,
          width: scaled.width,
          height: scaled.height
        }
      );

      page.drawText(
        `Firmado por: ${
          state.profile.full_name ||
          state.profile.email
        }`.slice(0, 72),
        {
          x: x + 10,
          y: y + 26,
          size: 8.2,
          font,
          color: rgb(
            0.08,
            0.18,
            0.28
          )
        }
      );

      page.drawText(
        `Fecha: ${new Date().toLocaleString(
          'es-MX'
        )}`,
        {
          x: x + 10,
          y: y + 14,
          size: 7.4,
          font,
          color: rgb(
            0.18,
            0.28,
            0.38
          )
        }
      );

      page.drawText(
        `Lumen Sign: ${id.slice(0, 18)}`,
        {
          x: x + 10,
          y: y + 4,
          size: 6.8,
          font,
          color: rgb(
            0.3,
            0.38,
            0.46
          )
        }
      );

      const output =
        await pdfDocument.save();

      const blob = new Blob(
        [output],
        {
          type: 'application/pdf'
        }
      );

      const hash =
        await sha256(output.buffer);

      const nextVersion =
        Number(
          documentRecord.current_version
        ) + 1;

      const path = `
        ${id}/signed/v${nextVersion}-${state.session.user.id}-${Date.now()}.pdf
      `.trim();

      const cleanTitle =
        documentRecord.title
          .replace(
            /[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ -]/g,
            ''
          )
          .trim()
          .replace(/\s+/g, '-');

      const fileName =
        `${cleanTitle}-firmado-v${nextVersion}.pdf`;

      const {
        error: uploadError
      } = await client.storage
        .from('documents')
        .upload(
          path,
          blob,
          {
            contentType:
              'application/pdf',

            upsert: false
          }
        );

      if (uploadError) {
        throw uploadError;
      }

      const {
        error: recordError
      } = await client.rpc(
        'record_document_signature',
        {
          p_document_id: id,
          p_user_signature_id:
            defaultSignature.id,
          p_file_path: path,
          p_file_name: fileName,
          p_file_hash: hash,
          p_size_bytes: blob.size,
          p_user_agent:
            navigator.userAgent.slice(
              0,
              500
            )
        }
      );

      if (recordError) {
        throw recordError;
      }

      els['document-dialog'].close();

      await refreshData();
    },
    'Firma registrada y nueva versión creada.'
    );
  }

  function prepareCanvas() {
    const canvas =
      els['signature-canvas'];

    const rect =
      canvas.getBoundingClientRect();

    if (!rect.width) return;

    const ratio =
      Math.max(
        window.devicePixelRatio || 1,
        1
      );

    const nextWidth =
      Math.floor(
        rect.width * ratio
      );

    const nextHeight =
      Math.floor(
        220 * ratio
      );

    /*
     * Modificar width o height borra el canvas.
     * Guardamos temporalmente el dibujo antes
     * de cambiar sus dimensiones.
     */
    const hadInk =
      canvas.dataset.hasInk === '1';

    const snapshot =
      hadInk &&
      canvas.width &&
      canvas.height
        ? canvas.toDataURL(
            'image/png'
          )
        : '';

    const sameSize =
      canvas.width === nextWidth &&
      canvas.height === nextHeight &&
      canvas.dataset.canvasReady === '1';

    if (!sameSize) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      canvas.dataset.canvasReady = '1';
    }

    const context =
      canvas.getContext('2d');

    context.setTransform(
      ratio,
      0,
      0,
      ratio,
      0,
      0
    );

    context.lineWidth = 2.2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#13283d';

    if (!sameSize && snapshot) {
      const image = new Image();

      image.onload = () => {
        context.drawImage(
          image,
          0,
          0,
          rect.width,
          220
        );

        canvas.dataset.hasInk = '1';
      };

      image.src = snapshot;
    }
  }

  function canvasPoint(event) {
    const rect =
      els['signature-canvas']
        .getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function clearCanvas() {
    const canvas =
      els['signature-canvas'];

    canvas
      .getContext('2d')
      .clearRect(
        0,
        0,
        canvas.width,
        canvas.height
      );

    canvas.dataset.hasInk = '';
  }

  async function saveSignature() {
    const canvas =
      els['signature-canvas'];

    if (!canvas.dataset.hasInk) {
      throw new Error(
        'Dibuja tu firma antes de guardarla.'
      );
    }

    const label =
      byId('signature-label')
        .value
        .trim() ||
      'Firma principal';

    await run(async () => {
      const blob =
        await new Promise(resolve => {
          canvas.toBlob(
            resolve,
            'image/png'
          );
        });

      const path = `
        ${state.session.user.id}/${crypto.randomUUID()}.png
      `.trim();

      const {
        error: uploadError
      } = await client.storage
        .from('signatures')
        .upload(
          path,
          blob,
          {
            contentType: 'image/png',
            upsert: false
          }
        );

      if (uploadError) {
        throw uploadError;
      }

      const { error } = await client.rpc(
        'register_signature',
        {
          p_storage_path: path,
          p_label: label
        }
      );

      if (error) throw error;

      clearCanvas();

      await loadSignatures();
      await renderSignatures();
    }, 'Firma guardada.');
  }

  async function revokeSignature(id) {
    if (
      !confirm(
        '¿Revocar esta firma? No se borrarán las firmas ya aplicadas a documentos.'
      )
    ) {
      return;
    }

    await run(async () => {
      const { error } = await client.rpc(
        'revoke_signature',
        {
          p_signature_id: id
        }
      );

      if (error) throw error;

      await loadSignatures();
      await renderSignatures();
    }, 'Firma revocada.');
  }

  async function updateProfile(event) {
    event.preventDefault();

    await run(async () => {
      const { error } = await client.rpc(
        'update_my_profile',
        {
          p_full_name:
            byId('profile-name')
              .value
              .trim(),

          p_department:
            byId('profile-department')
              .value
              .trim(),

          p_phone:
            byId('profile-phone')
              .value
              .trim()
        }
      );

      if (error) throw error;

      clearProfileDraft();

      await loadProfile();

      configureAppForProfile(true);
    }, 'Perfil actualizado.');
  }

  async function updateAdminUser(id) {
    const role =
      document.querySelector(
        `[data-admin-role="${id}"]`
      ).value;

    const status =
      document.querySelector(
        `[data-admin-status="${id}"]`
      ).value;

    await run(async () => {
      const { error } = await client.rpc(
        'admin_update_profile',
        {
          p_user_id: id,
          p_role: role,
          p_status: status
        }
      );

      if (error) throw error;

      await loadProfiles();

      renderAdminUsers();
    }, 'Usuario actualizado.');
  }

  async function refreshData() {
    await Promise.all([
      loadProfiles(),
      loadDocuments(),
      loadTasks(),
      loadSignatures(),
      loadAppliedSignatures()
    ]);

    renderAll();
  }

  function bindEvents() {
    qsa('[data-auth-tab]').forEach(button => {
      button.addEventListener(
        'click',
        () => {
          switchAuthTab(
            button.dataset.authTab
          );
        }
      );
    });

    els['login-form'].addEventListener(
      'submit',
      async event => {
        event.preventDefault();

        await run(async () => {
          const { error } =
            await client.auth
              .signInWithPassword({
                email:
                  byId('login-email')
                    .value
                    .trim(),

                password:
                  byId('login-password')
                    .value
              });

          if (error) throw error;
        });
      }
    );

    els['register-form'].addEventListener(
      'submit',
      async event => {
        event.preventDefault();

        await run(async () => {
          const redirectTo =
            `${location.origin}${location.pathname}`;

          const { data, error } =
            await client.auth.signUp({
              email:
                byId('register-email')
                  .value
                  .trim(),

              password:
                byId('register-password')
                  .value,

              options: {
                data: {
                  full_name:
                    byId('register-name')
                      .value
                      .trim()
                },

                emailRedirectTo:
                  redirectTo
              }
            });

          if (error) throw error;

          event.target.reset();

          toast(
            data.session
              ? 'Cuenta creada. Un administrador debe activarla.'
              : 'Revisa tu correo para confirmar la cuenta.'
          );

          switchAuthTab('login');
        });
      }
    );

    els['forgot-password']
      .addEventListener(
        'click',
        async () => {
          const email =
            byId('login-email')
              .value
              .trim() ||
            prompt(
              'Escribe tu correo:'
            );

          if (!email) return;

          await run(async () => {
            const { error } =
              await client.auth
                .resetPasswordForEmail(
                  email,
                  {
                    redirectTo:
                      `${location.origin}${location.pathname}`
                  }
                );

            if (error) throw error;
          },
          'Se envió el enlace de recuperación.'
          );
        }
      );

    els['logout-button']
      .addEventListener(
        'click',
        async () => {
          clearProfileDraft();

          await client.auth.signOut();
        }
      );

    els['main-nav'].addEventListener(
      'click',
      event => {
        const button =
          event.target.closest(
            '[data-section]'
          );

        if (
          button &&
          !button.disabled
        ) {
          navigate(
            button.dataset.section
          );
        }
      }
    );

    els['menu-button']
      .addEventListener(
        'click',
        () => {
          document
            .querySelector('.sidebar')
            .classList
            .toggle('open');
        }
      );

    els['document-search']
      .addEventListener(
        'input',
        renderDocuments
      );

    els['document-status-filter']
      .addEventListener(
        'change',
        renderDocuments
      );

    els['new-document-form']
      .addEventListener(
        'submit',
        createDocument
      );

    els['add-participant']
      .addEventListener(
        'click',
        () => {
          addParticipantRow(
            els['participants-builder']
          );
        }
      );

    els['participants-builder']
      .addEventListener(
        'click',
        event => {
          if (
            event.target.classList.contains(
              'remove-participant'
            )
          ) {
            event.target
              .closest('.participant-row')
              .remove();
          }
        }
      );

    els['flow-add-participant']
      .addEventListener(
        'click',
        () => {
          addParticipantRow(
            els['flow-builder']
          );
        }
      );

    els['flow-builder']
      .addEventListener(
        'click',
        event => {
          if (
            event.target.classList.contains(
              'remove-participant'
            )
          ) {
            event.target
              .closest('.participant-row')
              .remove();
          }
        }
      );

    els['save-flow']
      .addEventListener(
        'click',
        saveFlow
      );

    els['profile-form']
      .addEventListener(
        'submit',
        updateProfile
      );

    [
      'profile-name',
      'profile-department',
      'profile-phone'
    ].forEach(id => {
      byId(id).addEventListener(
        'input',
        saveProfileDraft
      );
    });

    els['clear-signature']
      .addEventListener(
        'click',
        clearCanvas
      );

    els['save-signature']
      .addEventListener(
        'click',
        saveSignature
      );

    els['refresh-users']
      .addEventListener(
        'click',
        async () => {
          await run(async () => {
            await loadProfiles();
            renderAdminUsers();
          },
          'Lista actualizada.'
          );
        }
      );

    document.addEventListener(
      'click',
      async event => {
        const openButton =
          event.target.closest(
            '[data-open-document]'
          );

        if (openButton) {
          return openDocument(
            openButton.dataset.openDocument
          );
        }

        const downloadButton =
          event.target.closest(
            '[data-download-path]'
          );

        if (downloadButton) {
          return downloadPrivate(
            downloadButton.dataset.downloadPath,
            downloadButton.dataset.downloadName
          );
        }

        const replaceButton =
          event.target.closest(
            '[data-replace-document]'
          );

        if (replaceButton) {
          return replaceDocumentFile(
            replaceButton.dataset.replaceDocument
          );
        }

        const flowButton =
          event.target.closest(
            '[data-configure-flow]'
          );

        if (flowButton) {
          return configureFlow(
            flowButton.dataset.configureFlow
          );
        }

        const submitButton =
          event.target.closest(
            '[data-submit-document]'
          );

        if (submitButton) {
          return submitDocument(
            submitButton.dataset.submitDocument
          );
        }

        const approveButton =
          event.target.closest(
            '[data-approve-document]'
          );

        if (approveButton) {
          return actOnDocument(
            approveButton.dataset.approveDocument,
            'approve'
          );
        }

        const rejectButton =
          event.target.closest(
            '[data-reject-document]'
          );

        if (rejectButton) {
          return actOnDocument(
            rejectButton.dataset.rejectDocument,
            'reject'
          );
        }

        const signButton =
          event.target.closest(
            '[data-sign-document]'
          );

        if (signButton) {
          return signDocument(
            signButton.dataset.signDocument
          );
        }

        const revokeButton =
          event.target.closest(
            '[data-revoke-signature]'
          );

        if (revokeButton) {
          return revokeSignature(
            revokeButton.dataset.revokeSignature
          );
        }

        const saveUserButton =
          event.target.closest(
            '[data-save-user]'
          );

        if (saveUserButton) {
          return updateAdminUser(
            saveUserButton.dataset.saveUser
          );
        }
      }
    );

    const canvas =
      els['signature-canvas'];

    canvas.addEventListener(
      'pointerdown',
      event => {
        state.signatureDrawing = true;

        canvas.setPointerCapture(
          event.pointerId
        );

        const point =
          canvasPoint(event);

        const context =
          canvas.getContext('2d');

        context.beginPath();
        context.moveTo(
          point.x,
          point.y
        );
      }
    );

    canvas.addEventListener(
      'pointermove',
      event => {
        if (!state.signatureDrawing) {
          return;
        }

        const point =
          canvasPoint(event);

        const context =
          canvas.getContext('2d');

        context.lineTo(
          point.x,
          point.y
        );

        context.stroke();

        canvas.dataset.hasInk = '1';
      }
    );

    [
      'pointerup',
      'pointercancel',
      'pointerleave'
    ].forEach(type => {
      canvas.addEventListener(
        type,
        () => {
          state.signatureDrawing = false;
        }
      );
    });

    window.addEventListener(
      'resize',
      () => {
        if (
          !byId('section-profile')
            .classList
            .contains('hidden')
        ) {
          prepareCanvas();
        }
      }
    );

    window.addEventListener(
      'beforeunload',
      event => {
        if (!state.profileDirty) {
          return;
        }

        event.preventDefault();
        event.returnValue = '';
      }
    );
  }

  async function handleRecoveryEvent(event) {
    if (event !== 'PASSWORD_RECOVERY') {
      return;
    }

    const password = prompt(
      'Escribe tu nueva contraseña (mínimo 10 caracteres):'
    );

    if (
      !password ||
      password.length < 10
    ) {
      toast(
        'La contraseña no fue modificada.',
        true
      );

      return;
    }

    const { error } =
      await client.auth.updateUser({
        password
      });

    if (error) {
      toast(error.message, true);
    } else {
      toast(
        'Contraseña actualizada.'
      );
    }
  }

  async function init() {
    cacheElements();
    bindEvents();

    addParticipantRow(
      els['participants-builder'],
      {
        participant_role: 'approver',
        sequence: 1
      }
    );

    addParticipantRow(
      els['participants-builder'],
      {
        participant_role: 'signer',
        sequence: 1
      }
    );

    client.auth.onAuthStateChange(
      (event, session) => {
        setTimeout(async () => {
          try {
            await handleRecoveryEvent(event);

            /*
             * La renovación del token no debe
             * reconstruir la página ni borrar
             * los formularios.
             */
            if (
              event === 'TOKEN_REFRESHED' ||
              event === 'USER_UPDATED'
            ) {
              state.session = session;
              return;
            }

            await handleSession(session);
          } catch (error) {
            console.error(error);

            toast(
              error.message ||
              'Error de sesión.',
              true
            );
          }
        }, 0);
      }
    );

    window.addEventListener(
      'unhandledrejection',
      event => {
        const message =
          event.reason?.message ||
          'Ocurrió un error inesperado.';

        console.error(event.reason);

        toast(message, true);
      }
    );

    const { data } =
      await client.auth.getSession();

    if (data.session) {
      await handleSession(data.session);
    } else {
      showAuth();
    }
  }

  init().catch(error => {
    console.error(error);

    toast(
      error.message ||
      'No se pudo iniciar la aplicación.',
      true
    );
  });
})();
