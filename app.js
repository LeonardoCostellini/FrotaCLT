/* ================================================
   FrotaCTL — Sistema de Gestão de Frotas
   app.js
   Backend: ApiHandler.ashx (ASP.NET) com fallback localStorage
   A identidade visual (nome, logotipo, cor) é configurável em
   Sistema > Personalização — ver BRANDING() / applyBranding() abaixo.
   ================================================ */
'use strict';

// ── CONFIG ──────────────────────────────────────
const DB_KEY  = 'frotactl_db_v1';
const API_URL = 'ApiHandler.ashx';

// ⚠️ MODO DE TESTE — pula a tela de login automaticamente ao carregar a página,
// entrando com o primeiro usuário Administrador Geral (ou o primeiro usuário
// ativo) que existir. NÃO afeta a segurança da API (ApiHandler.ashx) — só a
// tela de login do front-end.
// Deixe como "false" antes de entregar/publicar o sistema para qualquer empresa.
const SKIP_LOGIN_FOR_TESTING = true;

// Identidade visual padrão (usada até que alguém salve algo diferente em
// Sistema > Personalização). Nenhum destes valores é obrigatório: o sistema
// funciona normalmente com os padrões abaixo.
const DEFAULT_BRANDING = {
  appName:      'FrotaCTL',
  appSubtitle:  'Gestão de Frotas',
  logoDataUrl:  '',   // data:image/...;base64,... (upload feito na tela de Personalização)
  primaryColor: '#0055FF',
  reportFooter: '', // se vazio, usa o nome do sistema
  textOnAccent: 'auto', // 'auto' | 'light' | 'dark' — cor do texto sobre botões/itens com a Cor Principal
  sidebarBg:    '#00143D', // cor de fundo de toda a barra lateral (independente da Cor Principal)
  sidebarText:  '#FFFFFF', // cor das letras/ícones da barra lateral
};

// Retorna a configuração de identidade visual atual, sempre com todos os
// campos preenchidos (mescla o que foi salvo com os padrões de fábrica).
function BRANDING() {
  return { ...DEFAULT_BRANDING, ...(dbFull.branding || {}) };
}

// ── STATE ────────────────────────────────────────
// dbFull = fonte de verdade COMPLETA (todas as empresas) — é o que vai para o servidor.
// db     = "visão" filtrada pela empresa do usuário logado — é o que o restante do app lê/edita.
//          É reconstruída por rebuildView() sempre que muda o usuário logado ou a empresa ativa.
let dbFull = {
  companies:        [], // { id, name, cnpj, active, createdAt } — entidade global, não é filtrada por empresa
  vehicles:         [],
  drivers:          [],
  assignments:      [],
  fuel:             [],
  maintenance:      [],
  oil:              [],
  briefcases:       [],
  briefcaseReturns: [],  // { id, briefcaseId, briefcaseName, driverId, driverName, date, checklist:[{id,name,returned}], missing, createdAt }
  inspections:      [],  // { id, vehicleId, vehiclePlate, vehicleModel, driverId, driverName, type, datetime, km, fuelLevel, checks:{pneus,lataria,...}, obs, createdAt }
  schedules:        [],  // { id, vehicleId, vehiclePlate, vehicleModel, driverId, driverName, dateStart, dateEnd, obs, status, createdAt }
  trips:            [],  // { id, number, client, os, obra, originCity, originState, destCity, destState, departureDate, expectedReturnDate,
                          //   vehicleId, vehiclePlate, driverId, driverName, technicians, notes, status,
                          //   equipment:[{id,name,qty,serial,notes}],
                          //   expenses:[{id,date,category,description,amount,paymentMethod,installments,installmentDueDate,notes}],
                          //   lodging:[{id,hotel,city,checkin,checkout,amount,invoiceNumber,notes}],
                          //   checklist:{items,observations,photos,signature,driverName,date},
                          //   approval:{status, technician:{comment,signature,date}, financial:{comment,date}, final:{comment,date}},
                          //   createdAt }
  users:            [],  // { id, name, username, passwordHash, role:'admin_geral'|'admin'|'gestor'|'operador', active, createdAt, empresaId } — empresaId null apenas para admin_geral
  auditLog:         [],  // { id, userId, userName, userRole, action, entity, entityId, entityLabel, oldData, newData, timestamp, empresaId }
  fines:            [],  // { id, vehicleId, vehiclePlate, driverId, driverName, date, type, amount, points, paymentStatus, notes, createdAt }
  briefcaseTerms: [], // { id, driverId, driverName, briefcaseId, briefcaseName, signature, date } — termo de responsabilidade semanal
  briefcaseConferences: [], // { id, driverId, driverName, briefcaseId, briefcaseName, date, checklist:[{id,name,present}], notes, createdAt } — conferência periódica de itens (sem desligamento)
  tempItems: [], // { id, driverId, driverName, item, toolId, price, checkoutDate, expectedReturnDate, returnedDate, notes, status:'em_posse'|'devolvido', createdAt }
  tools: [], // { id, name, price, category, notes, createdAt } — catálogo de ferramentas públicas de uso comum da empresa
  notificationSettingsByEmpresa: {}, // { [empresaId]: { managerPhone, enabled, daysBefore, kmBefore } } — aviso de troca de óleo por SMS/WhatsApp, configurado por empresa
  oilNotifications: [], // { id, oilId, vehicleId, vehiclePlate, reason:'km'|'data'|'vencida', message, phone, sentAt, status:'enviado'|'erro', error }
  maintenanceNotifications: [], // { id, scheduleId, vehicleId, vehiclePlate, reason:'km'|'data'|'vencida', message, phone, sentAt, status:'enviado'|'erro', error } — aviso de manutenção programada por SMS/WhatsApp
  scheduledMaintenance: [], // { id, vehicleId, vehiclePlate, type, description, dueDate, dueKm, priority:'baixa'|'media'|'alta', notes, status:'pendente'|'concluida', createdAt, completedAt, maintenanceId }
  roleDefaults: {}, // { [role]: { [moduleKey]: {view, edit} } } — permissões padrão de cada perfil, editáveis em Usuários > Perfis Padrão
  branding: null, // { appName, appSubtitle, logoDataUrl, primaryColor, reportFooter } — ver DEFAULT_BRANDING/BRANDING() acima. null = usa os padrões de fábrica.
};

// "Visão" usada por 100% do restante do app (renderização, buscas por id, dropdowns).
// Inicialmente aponta para o mesmo objeto de dbFull; após login/carregar dados vira um recorte por empresa.
let db = dbFull;

let charts = { costs: null, fuel: null };
let currentUser = null;

// Empresa que o Administrador Geral está visualizando no momento (null = "Todas as empresas").
// Para os demais papéis, a empresa é sempre a do próprio usuário (currentUser.empresaId).
let activeCompanyId = null;

// Chaves de entidades que são isoladas por empresa (empresaId). "companies" e "users" ficam de fora
// dessa lista genérica porque têm tratamento próprio em rebuildView().
const EMPRESA_SCOPED_KEYS = [
  'vehicles', 'drivers', 'assignments', 'fuel', 'maintenance', 'oil',
  'briefcases', 'briefcaseReturns', 'inspections', 'schedules', 'trips',
  'fines', 'briefcaseTerms', 'briefcaseConferences', 'tempItems', 'tools', 'oilNotifications', 'maintenanceNotifications', 'auditLog',
  'scheduledMaintenance',
];

// Retorna a empresa "ativa" para o usuário logado.
// - admin_geral: a empresa escolhida no seletor do topo, ou null para "Todas as empresas".
// - demais papéis: sempre a própria empresa (nunca null).
function currentEmpresaId() {
  if (!currentUser) return null;
  if (currentUser.role === 'admin_geral') return activeCompanyId;
  return currentUser.empresaId || null;
}

// Reconstrói `db` a partir de `dbFull`, filtrando cada entidade pela empresa ativa.
// Precisa ser chamada sempre que: currentUser mudar (login), activeCompanyId mudar (troca de empresa)
// ou dbFull for recarregado/salvo. IMPORTANTE: o filtro mantém as MESMAS referências de objeto,
// então edições feitas em campos aninhados (ex.: t.expenses.push(...)) continuam válidas em dbFull.
function rebuildView() {
  const eid = currentEmpresaId();
  if (!currentUser || eid === null) {
    // Sem usuário, ou admin_geral vendo "Todas as empresas": visão = dado completo.
    db = dbFull;
    return;
  }
  const scoped = { ...dbFull };
  EMPRESA_SCOPED_KEYS.forEach(k => {
    if (Array.isArray(dbFull[k])) scoped[k] = dbFull[k].filter(r => r.empresaId === eid);
  });
  scoped.users = (dbFull.users || []).filter(u => u.empresaId === eid);
  db = scoped;
}

// Garante que uma empresa padrão exista e que todo registro legado (sem empresaId) seja
// associado a ela. Roda uma única vez, na primeira carga após esta atualização multiempresa.
function migrateToMultiEmpresa() {
  if (!Array.isArray(dbFull.companies)) dbFull.companies = [];
  if (dbFull.companies.length > 0) return; // migração já feita anteriormente

  const defaultId = 'empresa-padrao';
  dbFull.companies.push({ id: defaultId, name: 'Empresa Padrão', cnpj: '', active: true, createdAt: new Date().toISOString() });

  EMPRESA_SCOPED_KEYS.forEach(k => {
    if (Array.isArray(dbFull[k])) dbFull[k].forEach(r => { if (!r.empresaId) r.empresaId = defaultId; });
  });

  (dbFull.users || []).forEach(u => {
    if (!u.empresaId) {
      if (u.role === 'admin') { u.role = 'admin_geral'; u.empresaId = null; } // promove o admin original a Administrador Geral
      else u.empresaId = defaultId;
    }
  });

  // Configuração de notificações de troca de óleo era global; agora é por empresa.
  if (!dbFull.notificationSettingsByEmpresa) dbFull.notificationSettingsByEmpresa = {};
  if (dbFull.notificationSettings) {
    dbFull.notificationSettingsByEmpresa[defaultId] = dbFull.notificationSettings;
    delete dbFull.notificationSettings;
  }
}

// ── STORAGE PROVIDER ────────────────────────────
// Camada de abstração: troque apenas este bloco para migrar para SQL Server.
const StorageProvider = {
  _serverAvailable: null,

  async save(data) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Erro desconhecido');
      try { localStorage.setItem(DB_KEY, JSON.stringify(data)); } catch(_) {}
      this._serverAvailable = true;
      updateConnStatus(true);
      return true;
    } catch (e) {
      this._serverAvailable = false;
      updateConnStatus(false);
      try { localStorage.setItem(DB_KEY, JSON.stringify(data)); } catch(_) {}
      return false;
    }
  },

  async load() {
    try {
      const res = await fetch(API_URL + '?action=load', { method: 'GET' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Erro');
      this._serverAvailable = true;
      updateConnStatus(true);
      try { localStorage.setItem(DB_KEY, JSON.stringify(json.data)); } catch(_) {}
      return json.data;
    } catch (e) {
      this._serverAvailable = false;
      updateConnStatus(false);
      try { const raw = localStorage.getItem(DB_KEY); return raw ? JSON.parse(raw) : null; } catch(_) { return null; }
    }
  },
};

function updateConnStatus(online) {
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (!dot || !label) return;
  dot.className   = 'conn-dot ' + (online ? 'online' : 'offline');
  label.textContent = online ? 'Servidor conectado' : 'Modo offline';
}

// ── TIME RESTRICTION ─────────────────────────────



function saveDB() {
  rebuildView(); // garante que qualquer mutação recente já esteja refletida na visão antes de salvar
  StorageProvider.save(dbFull).then(ok => {
    if (!ok) showToast('⚠️ Salvo localmente (servidor indisponível)', 'warning');
  });
}
async function loadDB() {
  const data = await StorageProvider.load();
  if (data) dbFull = { ...dbFull, ...data };
  migrateToMultiEmpresa();
  db = dbFull; // antes do login não há filtro; rebuildView() roda de novo após autenticar
}

// ── HELPERS ──────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ── SCROLL HELPER (fix: scroll está no .main-content, não no window) ──
function scrollMainContent(top = 0) {
  const mc = document.querySelector('.main-content');
  if (mc) mc.scrollTo({ top, behavior: 'smooth' });
  else window.scrollTo({ top, behavior: 'smooth' });
}

// ── MODAL DE CONFIRMAÇÃO (substitui confirm() nativo) ──
function confirmDialog(msg, onConfirm) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
  ov.innerHTML = `<div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:28px 28px 22px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
    <div style="font-size:1rem;font-weight:600;color:var(--text-primary);margin-bottom:10px;">Confirmar ação</div>
    <div style="font-size:0.88rem;color:var(--text-secondary);margin-bottom:22px;line-height:1.5;">${msg}</div>
    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button id="_conf_cancel" style="padding:8px 18px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);border-radius:var(--radius-sm);cursor:pointer;font-size:0.85rem;">Cancelar</button>
      <button id="_conf_ok" style="padding:8px 18px;border:none;background:#EF4444;color:#fff;border-radius:var(--radius-sm);cursor:pointer;font-size:0.85rem;font-weight:600;">Confirmar</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#_conf_cancel').onclick = () => document.body.removeChild(ov);
  ov.querySelector('#_conf_ok').onclick    = () => { document.body.removeChild(ov); onConfirm(); };
  ov.addEventListener('click', e => { if (e.target === ov) document.body.removeChild(ov); });
}

// ── BACKUP & RESTAURAÇÃO ──
function exportBackup() {
  const json = JSON.stringify(db, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `frotactl_backup_${new Date().toISOString().substring(0,10)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  showToast('Backup exportado com sucesso!', 'success');
}

function importBackup(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.vehicles || !data.drivers) throw new Error('Arquivo inválido');
      confirmDialog('Importar backup de ' + new Date(file.lastModified).toLocaleDateString('pt-BR') + '?<br><br><strong>Atenção:</strong> os dados atuais serão substituídos.', () => {
        db = { ...db, ...data };
        saveDB();
        populateAllSelects();
        renderVehicleList(); renderDriverList(); renderAssignmentList();
        renderFuelList(); renderMaintenanceList(); renderScheduledMaintenanceList(); renderOilList();
        renderBriefcaseList(); renderBriefcaseReturnList();
        renderInspectionList(); renderScheduleList();
        renderDashboard();
        showToast('Backup restaurado com sucesso!', 'success');
      });
    } catch(err) {
      showToast('Arquivo de backup inválido!', 'error');
    }
    input.value = '';
  };
  reader.readAsText(file);
}

function fmtDate(str) {
  if (!str) return '—';
  const [y, m, d] = str.split('-');
  return `${d}/${m}/${y}`;
}

function toISODate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtCurrency(v, decimals) {
  decimals = decimals === undefined ? 2 : decimals;
  return 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// ── Máscara de moeda para inputs (digita só números, formata sozinho: 10000 -> 100,00) ──
function maskCurrencyInput(el) {
  let digits = el.value.replace(/\D/g, '');
  if (!digits) { el.value = ''; return; }
  digits = digits.replace(/^0+(?=\d)/, '');
  while (digits.length < 3) digits = '0' + digits;
  const cents = digits.slice(-2);
  let intPart = digits.slice(0, -2).replace(/^0+(?=\d)/, '');
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  el.value = intPart + ',' + cents;
}

function maskCPFInput(el) {
  let digits = el.value.replace(/\D/g, '').slice(0, 11);
  let out = digits;
  if (digits.length > 9)      out = digits.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, '$1.$2.$3-$4');
  else if (digits.length > 6) out = digits.replace(/(\d{3})(\d{3})(\d{1,3})/, '$1.$2.$3');
  else if (digits.length > 3) out = digits.replace(/(\d{3})(\d{1,3})/, '$1.$2');
  el.value = out;
}

function parseCurrencyInput(id) {
  const el = document.getElementById(id);
  if (!el || !el.value) return 0;
  const raw = el.value.replace(/\./g, '').replace(',', '.');
  return parseFloat(raw) || 0;
}

function setCurrencyInput(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const n = Number(value) || 0;
  el.value = n ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// ── MÁSCARA DE KM (evita que "168.450" digitado num campo type=number vire
//    168,45 — o navegador trata "." como separador decimal, não de milhar) ──
function maskKmInput(el) {
  let digits = el.value.replace(/\D/g, '');
  digits = digits.replace(/^0+(?=\d)/, '');
  el.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function parseKmInput(id) {
  const el = document.getElementById(id);
  if (!el || !el.value) return 0;
  return parseInt(el.value.replace(/\D/g, ''), 10) || 0;
}

function setKmInput(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const n = Math.round(Number(value) || 0);
  el.value = n ? n.toLocaleString('pt-BR') : '';
}

function emptyState(icon, title, sub) {
  return `<div class="empty-state"><div class="icon">${icon}</div><div class="title">${title}</div><div class="sub">${sub}</div></div>`;
}

function filterByDate(arr, field, fromId, toId) {
  const from = document.getElementById(fromId)?.value || '';
  const to   = document.getElementById(toId)?.value   || '';
  return arr.filter(r => {
    const d = (r[field] || '').substring(0, 10);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
}

// ════════════════════════════════════════════════
// FILTER BAR — helpers do componente de filtros moderno
// ════════════════════════════════════════════════
const FILTER_BAR_MAP = {
  a:   { fields: ['a-search', 'a-status-filter'],                          render: 'renderAssignmentList' },
  f:   { fields: ['f-search', 'f-type-filter', 'f-date-from', 'f-date-to'], render: 'renderFuelList' },
  m:   { fields: ['m-search', 'm-type-filter', 'm-date-from', 'm-date-to'], render: 'renderMaintenanceList' },
  o:   { fields: ['o-search', 'o-date-from', 'o-date-to'],                 render: 'renderOilList' },
  br:  { fields: ['br-search', 'br-date-from', 'br-date-to'],              render: 'renderBriefcaseReturnList' },
  sch: { fields: ['sch-search', 'sch-status-filter'],                      render: 'renderScheduleList' },
};

function toggleSearchClear(input) {
  const box = input.closest('.filter-search-box');
  if (box) box.classList.toggle('has-value', !!input.value);
}

function clearSearchField(id, renderFn) {
  const input = document.getElementById(id);
  if (!input) return;
  input.value = '';
  toggleSearchClear(input);
  if (typeof renderFn === 'function') renderFn();
}

function clearToolbarFilters(prefix) {
  const cfg = FILTER_BAR_MAP[prefix];
  if (!cfg) return;
  cfg.fields.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = '';
    if (el.classList.contains('filter-input')) toggleSearchClear(el);
  });
  const fn = window[cfg.render];
  if (typeof fn === 'function') fn();
}

function updateFilterBarState(prefix, activeCount) {
  const countEl  = document.getElementById(prefix + '-filter-count');
  const clearBtn = document.getElementById(prefix + '-filter-clear');
  if (countEl)  { countEl.textContent = String(activeCount); countEl.hidden = activeCount === 0; }
  if (clearBtn) { clearBtn.hidden = activeCount === 0; }
}

function cnhStatus(expiry) {
  if (!expiry) return 'ok';
  const d = new Date(expiry + 'T00:00:00');
  const days = (d - new Date()) / 86400000;
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring';
  return 'ok';
}

// ── TOAST ────────────────────────────────────────
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ── MODAL ────────────────────────────────────────
function openModal(title, body) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// ── NAVIGATION ───────────────────────────────────
function switchPage(pageId, btn) {
  if (!hasPermission(pageId, 'view')) {
    showToast('Você não tem permissão para acessar esta tela.', 'error');
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById(pageId + '-page');
  pageEl.classList.add('active');
  pageEl.classList.toggle('view-only-page', !hasPermission(pageId, 'edit'));
  if (btn) btn.classList.add('active');
  const titles = {
    dashboard:'Dashboard', vehicles:'Veículos', drivers:'Motoristas',
    assignments:'Atribuições', fuel:'Abastecimentos', maintenance:'Manutenções',
    oil:'Troca de Óleo', reports:'Relatórios', briefcases:'Maletas',
    'briefcase-return':'Devolução Final da Maleta', inspection:'Vistoria do Veículo',
    schedule:'Agenda de Reservas',
    alerts:'Central de Alertas',
    'adv-reports':'Análise Avançada', backup:'Backup & Restauração',
    trips:'Viagens', users:'Usuários', audit:'Auditoria', fines:'Multas',
    'weekly-terms':'Termo da Maleta', 'temp-items':'Ferramentas de Uso Comum',
    companies:'Empresas', personalizacao:'Personalização', inspection:'Vistoria do Veículo',
  };
  document.getElementById('topbar-title').textContent = titles[pageId] || pageId;
  if (pageId === 'dashboard')   renderDashboard();
  if (pageId === 'alerts')      renderAlertsPage();
  if (pageId === 'adv-reports') renderAdvancedReports();
  if (pageId === 'trips') { closeTripDetail(); populateTripSelects(); renderTripList(); }
  if (pageId === 'companies') renderCompanyList();
  if (pageId === 'users') {
    populateUserFormEmpresaAndRole(); renderUserList(); renderRoleDefaultsMatrix();
    const submitBtn = document.getElementById('u-submit-btn');
    if (submitBtn && !submitBtn.dataset.editId) {
      document.getElementById('u-password').placeholder = 'Senha *';
      document.getElementById('u-password').required = true;
    }
  }
  if (pageId === 'audit') { populateAuditSelects(); renderAuditLog(); }
  if (pageId === 'fines') renderFineList();
  if (pageId === 'inspection') { populateVehicleSelects(); populateDriverSelects(); renderInspectionList(); }
  if (pageId === 'personalizacao') loadBrandingForm();
  if (pageId === 'weekly-terms') renderWeeklyTermsPage();
  if (pageId === 'temp-items') initToolsPage();
}

// ── SELECTS ──────────────────────────────────────
function populateVehicleSelects() {
  ['a-vehicle','f-vehicle','m-vehicle','sm-vehicle','o-vehicle','r-vehicle'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    const cur = el.value;
    el.innerHTML = '<option value="">Selecione...</option>';
    db.vehicles.forEach(v => {
      const ico = v.type === 'moto' ? '🏍️' : '🚗';
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = `${ico} ${v.plate} — ${v.brand} ${v.model}`;
      el.appendChild(o);
    });
    if (cur) el.value = cur;
  });
}

function populateDriverSelects() {
  ['a-driver','f-driver','m-driver','o-driver','r-driver'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    const cur = el.value;
    el.innerHTML = '<option value="">Todos</option>';
    if (id !== 'r-driver') el.options[0].textContent = 'Selecione...';
    db.drivers.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      el.appendChild(o);
    });
    if (cur) el.value = cur;
  });
}

function populateBriefcaseSelects() {
  const bcDriverSel = document.getElementById('bc-assigned-driver');
  if (bcDriverSel) {
    const cur = bcDriverSel.value;
    bcDriverSel.innerHTML = '<option value="">Nenhum (maleta compartilhada)</option>' + db.drivers.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
    if (cur) bcDriverSel.value = cur;
  }
}

function populateAllSelects() {
  populateVehicleSelects();
  populateDriverSelects();
  populateBriefcaseSelects();
  populateNewModuleSelects();
  populateTripSelects();
  populateFineSelects();
  populateTempItemSelects();
}

function populateNewModuleSelects() {
  // Briefcase return selects
  const brBriefcase = document.getElementById('br-briefcase');
  if (brBriefcase) {
    const cur = brBriefcase.value;
    brBriefcase.innerHTML = '<option value="">Selecione...</option>';
    db.briefcases.forEach(b => {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = `🧰 ${b.code ? b.code + ' — ' : ''}${b.name}`;
      brBriefcase.appendChild(o);
    });
    if (cur) brBriefcase.value = cur;
  }
  const brDriver = document.getElementById('br-driver');
  if (brDriver) {
    const cur = brDriver.value;
    brDriver.innerHTML = '<option value="">Selecione...</option>';
    db.drivers.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      brDriver.appendChild(o);
    });
    if (cur) brDriver.value = cur;
  }

  // Inspection selects
  ['ins-vehicle'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    const cur = el.value;
    el.innerHTML = '<option value="">Selecione...</option>';
    db.vehicles.forEach(v => {
      const ico = v.type === 'moto' ? '🏍️' : '🚗';
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = `${ico} ${v.plate} — ${v.brand} ${v.model}`;
      el.appendChild(o);
    });
    if (cur) el.value = cur;
  });
  const insDriver = document.getElementById('ins-driver');
  if (insDriver) {
    const cur = insDriver.value;
    insDriver.innerHTML = '<option value="">Selecione...</option>';
    db.drivers.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      insDriver.appendChild(o);
    });
    if (cur) insDriver.value = cur;
  }

  // Schedule selects
  const schVehicle = document.getElementById('sch-vehicle');
  if (schVehicle) {
    const cur = schVehicle.value;
    schVehicle.innerHTML = '<option value="">Selecione...</option>';
    db.vehicles.forEach(v => {
      const ico = v.type === 'moto' ? '🏍️' : '🚗';
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = `${ico} ${v.plate} — ${v.brand} ${v.model}`;
      schVehicle.appendChild(o);
    });
    if (cur) schVehicle.value = cur;
  }
  const schDriver = document.getElementById('sch-driver');
  if (schDriver) {
    const cur = schDriver.value;
    schDriver.innerHTML = '<option value="">Selecione...</option>';
    db.drivers.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      schDriver.appendChild(o);
    });
    if (cur) schDriver.value = cur;
  }
}


// ── VEHICLE TYPE TOGGLE ───────────────────────────
function selectVehicleType(type, btn) {
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('v-type').value = type;
}

// ════════════════════════════════════════════════
// VEHICLE CRUD
// ════════════════════════════════════════════════
function submitVehicle(e) {
  e.preventDefault();
  const btn    = document.getElementById('v-submit-btn');
  const editId = btn.dataset.editId;
  const plate  = document.getElementById('v-plate').value.toUpperCase().trim();

  if (!editId && db.vehicles.some(v => v.plate === plate)) {
    showToast('Placa já cadastrada!', 'error'); return;
  }
  const oldRecord = editId ? db.vehicles.find(v => v.id === editId) : null;

  const record = {
    id: editId || uid(),
    type:        document.getElementById('v-type').value,
    plate, brand:        document.getElementById('v-brand').value.trim(),
    model:       document.getElementById('v-model').value.trim(),
    year:        parseInt(document.getElementById('v-year').value),
    color:       document.getElementById('v-color').value.trim(),
    fuelType:    document.getElementById('v-fuel-type').value,
    km:          parseKmInput('v-km'),
    lastMaint:   document.getElementById('v-last-maint').value || null,
    lastOil:     document.getElementById('v-last-oil').value   || null,
    oilKm:       parseKmInput('v-oil-km'),
    oilInterval: parseFloat(document.getElementById('v-oil-interval').value) || 5000,
    empresaId: editId ? (oldRecord?.empresaId ?? currentEmpresaId()) : currentEmpresaId(),
    createdAt: editId ? (db.vehicles.find(v => v.id === editId)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
  };

  if (editId) {
    dbFull.vehicles = dbFull.vehicles.map(v => v.id === editId ? record : v);
    logAudit('update', 'vehicle', record.id, record.plate, oldRecord, record);
    showToast('Veículo atualizado!', 'success');
    delete btn.dataset.editId; btn.textContent = 'Cadastrar Veículo';
    document.getElementById('v-form-title').textContent = 'Novo Veículo';
  } else {
    dbFull.vehicles.push(record);
    logAudit('create', 'vehicle', record.id, record.plate, null, record);
    showToast('Veículo cadastrado!', 'success');

    // Se o cadastro já veio com uma última troca de óleo informada, gera o
    // registro correspondente em db.oil (histórico real de óleo do veículo).
    // Sem isso, a Central de Alertas e as demais checagens (badge "⚠ ÓLEO",
    // aviso ao criar atribuição, etc.) nunca enxergam esse veículo, pois toda
    // essa lógica é baseada exclusivamente nos registros de db.oil — mesmo
    // que a troca informada já esteja vencida. O alerta gerado aqui só sai
    // da Central quando uma nova troca de óleo for registrada de fato na
    // aba "Óleo" (o que cria um registro mais recente e atualiza nextKm/nextDate).
    if (record.lastOil) {
      dbFull.oil.push({
        id: uid(),
        vehicleId: record.id, vehiclePlate: record.plate, vehicleModel: `${record.brand} ${record.model}`,
        driverId: null, driverName: 'Cadastro do veículo',
        date: record.lastOil,
        km: record.oilKm, cost: 0,
        oilType: '', viscosity: '', brand: '',
        interval: record.oilInterval, nextKm: record.oilKm + record.oilInterval,
        intervalMonths: 6, nextDate: addMonths(record.lastOil, 6),
        obs: 'Registro gerado automaticamente a partir dos dados informados no cadastro do veículo.',
        empresaId: record.empresaId,
        createdAt: new Date().toISOString(),
      });
    }
  }

  saveDB(); resetVehicleForm(); renderVehicleList(); populateAllSelects();
}

function resetVehicleForm() {
  document.getElementById('vehicle-form').reset();
  document.getElementById('v-type').value = 'car';
  document.querySelectorAll('.type-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  document.getElementById('v-oil-interval').value = '5000';
  const btn = document.getElementById('v-submit-btn');
  delete btn.dataset.editId; btn.textContent = 'Cadastrar Veículo';
  document.getElementById('v-form-title').textContent = 'Novo Veículo';
}

function editVehicle(id) {
  const v = db.vehicles.find(v => v.id === id); if (!v) return;
  switchPage('vehicles', document.querySelector('[data-page="vehicles"]'));
  selectVehicleType(v.type, document.querySelector(`.type-btn[data-type="${v.type}"]`));
  ['plate','brand','model','year','color'].forEach(f => document.getElementById('v-'+f).value = v[f] || '');
  document.getElementById('v-fuel-type').value    = v.fuelType || '';
  setKmInput('v-km', v.km);
  document.getElementById('v-last-maint').value   = v.lastMaint || '';
  document.getElementById('v-last-oil').value     = v.lastOil   || '';
  setKmInput('v-oil-km', v.oilKm || 0);
  document.getElementById('v-oil-interval').value = v.oilInterval || 5000;
  const btn = document.getElementById('v-submit-btn');
  btn.dataset.editId = id; btn.textContent = 'Salvar Alterações';
  document.getElementById('v-form-title').textContent = 'Editar Veículo';
  scrollMainContent(0);
}

function deleteVehicle(id) {
  const target = db.vehicles.find(v => v.id === id);
  confirmDialog('Excluir este veículo? Esta ação não pode ser desfeita.', () => {
    dbFull.vehicles = dbFull.vehicles.filter(v => v.id !== id);
    logAudit('delete', 'vehicle', id, target?.plate, target, null);
    saveDB(); renderVehicleList(); populateAllSelects();
    showToast('Veículo excluído.', 'success');
  });
}

function renderVehicleList() {
  const el = document.getElementById('vehicle-list');
  if (!db.vehicles.length) { el.innerHTML = emptyState('🚗','Nenhum veículo cadastrado','Preencha o formulário acima'); return; }
  el.innerHTML = '<div class="panel"><div class="record-list">' + db.vehicles.map(v => {
    const ico  = v.type === 'moto' ? '🏍️' : '🚗';
    const badge = v.type === 'moto' ? '<span class="badge badge-green">MOTO</span>' : '<span class="badge badge-blue">CARRO</span>';
    // Oil alert check (KM ou data de vencimento, o que vencer primeiro)
    const oilAlert = getOilAlertStatus(v.id)
      ? '<span class="badge badge-orange">⚠ ÓLEO</span>' : '';
    return `<div class="record-item">
      <div class="record-stripe stripe-blue"></div>
      <div class="record-body">
        <div class="record-title-row">${badge}${oilAlert}<span class="record-name">${ico} ${v.plate} — ${v.brand} ${v.model} ${v.year}</span></div>
        <div class="record-meta">
          <span><strong>Cor:</strong> ${v.color || '—'}</span>
          <span><strong>Combustível:</strong> ${v.fuelType || '—'}</span>
          <span><strong>KM Atual:</strong> ${v.km.toLocaleString('pt-BR')} km</span>
          <span><strong>Últ. Manutenção:</strong> ${v.lastMaint ? fmtDate(v.lastMaint) : '—'}</span>
          <span><strong>Últ. Troca Óleo:</strong> ${v.lastOil ? fmtDate(v.lastOil) : '—'}</span>
          <span><strong>Intervalo Óleo:</strong> ${(v.oilInterval || 5000).toLocaleString('pt-BR')} km</span>
        </div>
      </div>
      <div class="record-actions">
        <button class="btn btn-ghost btn-sm" onclick="printVehicleCard('${v.id}')">🖨 Ficha</button>
        <button class="btn btn-edit btn-sm" onclick="editVehicle('${v.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteVehicle('${v.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('') + '</div></div>';
}

// ════════════════════════════════════════════════
// DRIVER CRUD
// ════════════════════════════════════════════════
function submitDriver(e) {
  e.preventDefault();
  const btn    = document.getElementById('d-submit-btn');
  const editId = btn.dataset.editId;
  const oldRecord = editId ? db.drivers.find(d => d.id === editId) : null;
  const record = {
    id: editId || uid(),
    name:      document.getElementById('d-name').value.trim(),
    function:  document.getElementById('d-function').value.trim(),
    cpf:       document.getElementById('d-cpf').value.trim(),
    cnh:       document.getElementById('d-cnh').value.trim(),
    cnhCat:    document.getElementById('d-cnh-cat').value,
    cnhExpiry: document.getElementById('d-cnh-expiry').value || null,
    phone:     document.getElementById('d-phone').value.trim(),
    address:   document.getElementById('d-address').value.trim(),
    empresaId: editId ? (oldRecord?.empresaId ?? currentEmpresaId()) : currentEmpresaId(),
    createdAt: editId ? (db.drivers.find(d => d.id === editId)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
  };
  if (editId) {
    dbFull.drivers = dbFull.drivers.map(d => d.id === editId ? record : d);
    logAudit('update', 'driver', record.id, record.name, oldRecord, record);
    showToast('Motorista atualizado!', 'success');
    delete btn.dataset.editId; btn.textContent = 'Cadastrar Motorista';
    document.getElementById('d-form-title').textContent = 'Novo Motorista';
  } else {
    dbFull.drivers.push(record);
    logAudit('create', 'driver', record.id, record.name, null, record);
    showToast('Motorista cadastrado!', 'success');
  }
  saveDB(); resetDriverForm(); renderDriverList(); populateDriverSelects(); populateBriefcaseSelects();
}

function resetDriverForm() {
  document.getElementById('driver-form').reset();
  const btn = document.getElementById('d-submit-btn');
  delete btn.dataset.editId; btn.textContent = 'Cadastrar Motorista';
}

function editDriver(id) {
  const d = db.drivers.find(d => d.id === id); if (!d) return;
  switchPage('drivers', document.querySelector('[data-page="drivers"]'));
  document.getElementById('d-name').value       = d.name;
  document.getElementById('d-function').value   = d.function || '';
  document.getElementById('d-cpf').value        = d.cpf;
  document.getElementById('d-cnh').value        = d.cnh;
  document.getElementById('d-cnh-cat').value    = d.cnhCat || 'B';
  document.getElementById('d-cnh-expiry').value = d.cnhExpiry || '';
  document.getElementById('d-phone').value      = d.phone || '';
  document.getElementById('d-address').value    = d.address || '';
  const btn = document.getElementById('d-submit-btn');
  btn.dataset.editId = id; btn.textContent = 'Salvar Alterações';
  scrollMainContent(0);
}

function deleteDriver(id) {
  const target = db.drivers.find(d => d.id === id);
  confirmDialog('Excluir este motorista?', () => {
    dbFull.drivers = dbFull.drivers.filter(d => d.id !== id);
    logAudit('delete', 'driver', id, target?.name, target, null);
    saveDB(); renderDriverList(); populateDriverSelects(); populateBriefcaseSelects();
    showToast('Motorista excluído.', 'success');
  });
}

function renderDriverList() {
  const el = document.getElementById('driver-list');
  if (!db.drivers.length) { el.innerHTML = emptyState('👤','Nenhum motorista cadastrado','Preencha o formulário acima'); return; }
  el.innerHTML = '<div class="panel"><div class="record-list">' + db.drivers.map(d => {
    const st = cnhStatus(d.cnhExpiry);
    const cnhBadge = st === 'expired'  ? '<span class="badge badge-red">CNH VENCIDA</span>'
                   : st === 'expiring' ? '<span class="badge badge-orange">CNH VENCE EM BREVE</span>'
                   : d.cnhExpiry       ? '<span class="badge badge-green">CNH VÁLIDA</span>' : '';
    return `<div class="record-item">
      <div class="record-stripe stripe-green"></div>
      <div class="record-body">
        <div class="record-title-row">
          <span class="badge badge-purple">MOTORISTA</span>${cnhBadge}
          <span class="record-name">${d.name}</span>
        </div>
        <div class="record-meta">
          <span><strong>Função:</strong> ${d.function || '—'}</span>
          <span><strong>CPF:</strong> ${d.cpf}</span>
          <span><strong>CNH:</strong> ${d.cnh} — Cat. ${d.cnhCat || 'B'}</span>
          <span><strong>Validade CNH:</strong> ${d.cnhExpiry ? fmtDate(d.cnhExpiry) : '—'}</span>
          <span><strong>Telefone:</strong> ${d.phone || '—'}</span>
          <span><strong>Endereço:</strong> ${d.address || '—'}</span>
        </div>
      </div>
      <div class="record-actions">
        <button class="btn btn-ghost btn-sm" onclick="printDriverCard('${d.id}')">🖨 Ficha</button>
        <button class="btn btn-edit btn-sm" onclick="editDriver('${d.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteDriver('${d.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('') + '</div></div>';
}

// ════════════════════════════════════════════════
// ASSIGNMENT CRUD
// ════════════════════════════════════════════════
// ── TERMO DE RESPONSABILIDADE DA MALETA (válido por 6 meses, ou quando solicitado pelo administrador) ──
let bfSigCtx = null, bfSigDrawing = false, bfSigHasStroke = false;
let pendingTermDriverId = null;
const BRIEFCASE_TERM_VALIDITY_MONTHS = 6;

function getLastBriefcaseTerm(driverId) {
  const terms = (db.briefcaseTerms || []).filter(t => t.driverId === driverId);
  if (!terms.length) return null;
  return terms.reduce((latest, t) => (!latest || new Date(t.date) > new Date(latest.date)) ? t : latest, null);
}

function getBriefcaseTermDueDate(lastTermDate) {
  const due = new Date(lastTermDate);
  due.setMonth(due.getMonth() + BRIEFCASE_TERM_VALIDITY_MONTHS);
  return due;
}

// Retorna o status do termo do técnico: se precisa assinar agora, e por quê.
function getBriefcaseTermStatus(driverId) {
  const bc = db.briefcases.find(b => b.assignedDriverId === driverId);
  const lastTerm = getLastBriefcaseTerm(driverId);
  if (!lastTerm) {
    return { needed: true, reason: 'Primeira assinatura — necessária no cadastro da maleta', dueDate: null };
  }
  if (bc && bc.forceResignRequestedAt && new Date(bc.forceResignRequestedAt) > new Date(lastTerm.date)) {
    return { needed: true, reason: `Nova assinatura solicitada pelo administrador em ${fmtDate(toISODate(new Date(bc.forceResignRequestedAt)))}`, dueDate: null };
  }
  const due = getBriefcaseTermDueDate(lastTerm.date);
  if (due <= new Date()) {
    return { needed: true, reason: `Validade de ${BRIEFCASE_TERM_VALIDITY_MONTHS} meses vencida em ${fmtDate(toISODate(due))}`, dueDate: due };
  }
  return { needed: false, dueDate: due };
}

// Mantido por compatibilidade com chamadas antigas — agora reflete a regra de 6 meses / solicitação do admin.
function hasSignedThisWeek(driverId) {
  return !getBriefcaseTermStatus(driverId).needed;
}

// ── CONFERÊNCIA PERIÓDICA DA MALETA (recomendada a cada 6 meses, feita por qualquer técnico de confiança) ──
const CONFERENCE_INTERVAL_MONTHS = 6;

function getLastBriefcaseConference(driverId) {
  const items = (db.briefcaseConferences || []).filter(c => c.driverId === driverId);
  if (!items.length) return null;
  return items.reduce((latest, c) => (!latest || new Date(c.date) > new Date(latest.date)) ? c : latest, null);
}

function getBriefcaseConferenceDueDate(lastConferenceDate) {
  const due = new Date(lastConferenceDate);
  due.setMonth(due.getMonth() + CONFERENCE_INTERVAL_MONTHS);
  return due;
}

// Retorna o status da próxima conferência do técnico: se está pendente, e a data prevista.
function getBriefcaseConferenceStatus(driverId) {
  const last = getLastBriefcaseConference(driverId);
  if (!last) {
    return { needed: true, reason: 'Nenhuma conferência registrada ainda', dueDate: null };
  }
  const due = getBriefcaseConferenceDueDate(last.date);
  if (due <= new Date()) {
    return { needed: true, reason: `Conferência de ${CONFERENCE_INTERVAL_MONTHS} em ${CONFERENCE_INTERVAL_MONTHS} meses vencida em ${fmtDate(toISODate(due))}`, dueDate: due };
  }
  return { needed: false, dueDate: due };
}

// O técnico só pode assinar o termo DEPOIS que o gestor conferir fisicamente a maleta —
// exceto na primeiríssima vez que a maleta é vinculada a ele, já que o PDF de conferência
// gerado no cadastro da maleta já cumpre esse papel.
function canSignBriefcaseTermNow(driverId) {
  const isFirstTime = !getLastBriefcaseTerm(driverId);
  if (isFirstTime) return true;
  return !getBriefcaseConferenceStatus(driverId).needed;
}

function requestBriefcaseSignature(driverId) {
  if (!canManageBriefcaseTerms()) { showToast('Apenas o Gestor ou o Administrador Geral podem solicitar nova assinatura.', 'error'); return; }
  const bc = db.briefcases.find(b => b.assignedDriverId === driverId);
  if (!bc) { showToast('Este técnico não possui maleta atribuída.', 'error'); return; }
  bc.forceResignRequestedAt = new Date().toISOString();
  logAudit('update', 'briefcase', bc.id, bc.name, null, { forceResignRequestedAt: bc.forceResignRequestedAt });
  saveDB();
  renderWeeklyTermsPage();
  showToast(`Nova assinatura solicitada para ${db.drivers.find(d=>d.id===driverId)?.name || 'o técnico'}.`, 'success');
}

function requestAllBriefcaseSignatures() {
  if (!canManageBriefcaseTerms()) { showToast('Apenas o Gestor ou o Administrador Geral podem solicitar renovação.', 'error'); return; }
  const driversWithBriefcase = db.drivers.filter(d => db.briefcases.some(b => b.assignedDriverId === d.id));
  if (!driversWithBriefcase.length) { showToast('Nenhum técnico com maleta atribuída.', 'error'); return; }
  confirmDialog(`Solicitar nova assinatura de todos os ${driversWithBriefcase.length} técnico(s) com maleta atribuída?`, () => {
    const now = new Date().toISOString();
    driversWithBriefcase.forEach(d => {
      const bc = db.briefcases.find(b => b.assignedDriverId === d.id);
      if (bc) bc.forceResignRequestedAt = now;
    });
    saveDB();
    renderWeeklyTermsPage();
    showToast('Solicitação de renovação enviada para todos os técnicos.', 'success');
  });
}

function printBriefcaseTerm(termId) {
  const t = (db.briefcaseTerms || []).find(x => x.id === termId); if (!t) return;
  const dueDate = getBriefcaseTermDueDate(t.date);

  const win = window.open('', '_blank', 'width=900,height=700');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Termo de Responsabilidade — ${t.driverName}</title>
  <style>
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:400 700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-ext-400-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:400; font-display:swap; src:url('fonts/ibm-plex-sans-latin-400-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-ext-700-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-700-normal.woff2') format('woff2'); }
    @font-face { font-family:'Plus Jakarta Sans'; font-style:normal; font-weight:800; font-display:swap; src:url('fonts/plus-jakarta-sans-latin-ext-800-normal.woff2') format('woff2'); }
    @font-face { font-family:'Plus Jakarta Sans'; font-style:normal; font-weight:800; font-display:swap; src:url('fonts/plus-jakarta-sans-latin-800-normal.woff2') format('woff2'); }
    body { font-family: 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif; margin: 0; padding: 32px; color: #1e293b; font-size: 13px; }
    h1 { font-family:'Plus Jakarta Sans', 'Segoe UI', Arial, sans-serif; font-weight:800; font-size: 19px; margin: 0 0 4px; }
    .sub { color: #64748b; font-size: 12px; margin-bottom: 24px; }
    .field-row { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
    .field-box { min-width: 180px; }
    .field-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 2px; }
    .field-value { font-size: 14px; font-weight: 700; }
    h2 { font-size: 14px; margin: 24px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; }
    th { color: #64748b; font-weight: 600; text-transform: uppercase; font-size: 10px; }
    .statement { font-size: 12px; line-height: 1.6; color: #334155; margin: 16px 0; text-align: justify; }
    .sig-box { margin-top: 32px; text-align: center; }
    .sig-box img { max-width: 260px; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px; background: #fff; }
    .sig-line { border-top: 1px solid #1e293b; width: 260px; margin: 4px auto 0; padding-top: 4px; font-size: 11px; color: #64748b; }
    .footer { margin-top: 32px; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  </style></head><body>
  <h1>Termo de Responsabilidade — Maleta de Ferramentas</h1>
  <div class="sub">${BRANDING().appName} — ${BRANDING().appSubtitle}</div>
  <div class="field-row">
    <div class="field-box"><div class="field-label">Técnico</div><div class="field-value">${t.driverName}</div></div>
    <div class="field-box"><div class="field-label">Maleta</div><div class="field-value">${t.briefcaseName || '—'}</div></div>
    <div class="field-box"><div class="field-label">Assinado em</div><div class="field-value">${new Date(t.date).toLocaleString('pt-BR')}</div></div>
    <div class="field-box"><div class="field-label">Válido até</div><div class="field-value">${fmtDate(toISODate(dueDate))}</div></div>
  </div>
  <p class="statement">Eu, <strong>${t.driverName}</strong>, declaro estar de posse da maleta de ferramentas acima identificada e de todos os itens listados abaixo, assumindo a responsabilidade pela guarda, conservação e devolução dos mesmos em condições adequadas de uso, conforme as normas internas da empresa. Este termo tem validade de ${BRIEFCASE_TERM_VALIDITY_MONTHS} meses a partir da data de assinatura, podendo ser renovado antecipadamente a qualquer momento por solicitação do administrador.</p>
  <h2>Ferramentas e Itens sob Responsabilidade</h2>
  ${t.tools && t.tools.length ? `<table><thead><tr><th>#</th><th>Item</th></tr></thead><tbody>
    ${t.tools.map((tool, i) => `<tr><td>${i+1}</td><td>${tool.name}</td></tr>`).join('')}
  </tbody></table>` : '<p style="color:#94a3b8;font-size:12px">Nenhuma ferramenta cadastrada nesta maleta no momento da assinatura.</p>'}
  <div class="sig-box">
    <img src="${t.signature}" alt="Assinatura">
    <div class="sig-line">${t.driverName}</div>
  </div>
  <div class="footer">${BRANDING().reportFooter || BRANDING().appName} — Termo de Responsabilidade · Gerado em ${new Date().toLocaleString('pt-BR')}</div>
  <script>window.onload = () => window.print();</script>
  </body></html>`);
  win.document.close();
}

// PDF de conferência com todos os itens da maleta, gerado no cadastro (primeira vez) ou sob demanda,
// com linha de assinatura em branco para conferência física (técnico + responsável).
function printBriefcaseChecklist(briefcaseId) {
  const b = db.briefcases.find(x => x.id === briefcaseId); if (!b) return;

  const win = window.open('', '_blank', 'width=900,height=700');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Termo de Conferência — ${b.name}</title>
  <style>
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:400 700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-ext-400-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:400; font-display:swap; src:url('fonts/ibm-plex-sans-latin-400-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-ext-700-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-700-normal.woff2') format('woff2'); }
    @font-face { font-family:'Plus Jakarta Sans'; font-style:normal; font-weight:800; font-display:swap; src:url('fonts/plus-jakarta-sans-latin-ext-800-normal.woff2') format('woff2'); }
    @font-face { font-family:'Plus Jakarta Sans'; font-style:normal; font-weight:800; font-display:swap; src:url('fonts/plus-jakarta-sans-latin-800-normal.woff2') format('woff2'); }
    body { font-family: 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif; margin: 0; padding: 32px; color: #1e293b; font-size: 13px; }
    h1 { font-family:'Plus Jakarta Sans', 'Segoe UI', Arial, sans-serif; font-weight:800; font-size: 19px; margin: 0 0 4px; }
    .sub { color: #64748b; font-size: 12px; margin-bottom: 24px; }
    .field-row { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
    .field-box { min-width: 180px; }
    .field-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 2px; }
    .field-value { font-size: 14px; font-weight: 700; }
    h2 { font-size: 14px; margin: 24px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; }
    th { color: #64748b; font-weight: 600; text-transform: uppercase; font-size: 10px; }
    td.chk { width: 60px; text-align: center; }
    .chk-box { display:inline-block; width:14px; height:14px; border:1.4px solid #1e293b; border-radius:3px; }
    .statement { font-size: 12px; line-height: 1.6; color: #334155; margin: 16px 0; text-align: justify; }
    .sig-row { display:flex; gap: 40px; margin-top: 48px; }
    .sig-box { flex:1; text-align: center; }
    .sig-line { border-top: 1px solid #1e293b; margin-top: 40px; padding-top: 6px; font-size: 11px; color: #64748b; }
    .footer { margin-top: 32px; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  </style></head><body>
  <h1>Termo de Conferência — Itens da Maleta</h1>
  <div class="sub">${BRANDING().appName} — ${BRANDING().appSubtitle}</div>
  <div class="field-row">
    <div class="field-box"><div class="field-label">Maleta</div><div class="field-value">${b.code ? b.code + ' — ' : ''}${b.name}</div></div>
    <div class="field-box"><div class="field-label">Responsável</div><div class="field-value">${b.assignedDriverName || 'Compartilhada (sem responsável fixo)'}</div></div>
    <div class="field-box"><div class="field-label">Data da Conferência</div><div class="field-value">${new Date().toLocaleDateString('pt-BR')}</div></div>
  </div>
  <p class="statement">O presente documento relaciona todos os itens cadastrados na maleta acima identificada, para fins de conferência física e assinatura de responsabilidade${b.assignedDriverName ? ` por ${b.assignedDriverName}` : ''}. Cada item deve ser fisicamente checado no ato da assinatura.</p>
  <h2>Itens Cadastrados (${(b.tools||[]).length})</h2>
  ${b.tools && b.tools.length ? `<table><thead><tr><th>#</th><th>Item</th><th class="chk">Conferido</th></tr></thead><tbody>
    ${b.tools.map((tool, i) => `<tr><td>${i+1}</td><td>${tool.name}</td><td class="chk"><span class="chk-box"></span></td></tr>`).join('')}
  </tbody></table>` : '<p style="color:#94a3b8;font-size:12px">Nenhuma ferramenta cadastrada nesta maleta.</p>'}
  <div class="sig-row">
    <div class="sig-box"><div class="sig-line">Técnico Responsável</div></div>
    <div class="sig-box"><div class="sig-line">Gerente / Administrador</div></div>
  </div>
  <div class="footer">${BRANDING().reportFooter || BRANDING().appName} — Termo de Conferência · Gerado em ${new Date().toLocaleString('pt-BR')}</div>
  <script>window.onload = () => window.print();</script>
  </body></html>`);
  win.document.close();
}

// Abas da página "Termo da Maleta": Status dos Técnicos / Histórico de Conferências / Histórico de Termos Assinados
function switchWeeklyTermsTab(tab, btn) {
  document.querySelectorAll('#weekly-terms-tab-nav .tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#weekly-terms-page .tab-content').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const content = document.getElementById('weekly-terms-tab-content-' + tab);
  if (content) content.classList.add('active');
}

function renderWeeklyTermsPage() {
  const el = document.getElementById('weekly-terms-list'); if (!el) return;
  const canManage = canManageBriefcaseTerms();
  const requestAllBtn = document.getElementById('btn-request-all-terms');
  if (requestAllBtn) requestAllBtn.style.display = canManage ? '' : 'none';
  const driversWithBriefcase = db.drivers.filter(d => db.briefcases.some(b => b.assignedDriverId === d.id));
  if (!driversWithBriefcase.length) {
    el.innerHTML = emptyState('🧰', 'Nenhum técnico com maleta atribuída', 'Defina o responsável de cada maleta no cadastro de Maletas');
  } else {
    el.innerHTML = `<div class="panel"><div class="panel-header"><span class="panel-title">Status do Termo (validade de ${BRIEFCASE_TERM_VALIDITY_MONTHS} meses)</span></div>
      <div class="panel-body" style="padding:0">
      ${driversWithBriefcase.map(d => {
        const status = getBriefcaseTermStatus(d.id);
        const confStatus = getBriefcaseConferenceStatus(d.id);
        const isFirstTime = !getLastBriefcaseTerm(d.id);
        const bc = db.briefcases.find(b => b.assignedDriverId === d.id);
        const toolsList = (bc?.tools || []).map(t => t.name).join(', ');
        return `<div class="record-item">
          <div class="record-stripe" style="background:${status.needed ? 'var(--danger)' : 'var(--success)'}"></div>
          <div class="record-body">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
              <strong>${d.name}</strong>
              <span class="badge ${status.needed ? 'badge-red' : 'badge-green'}">Termo: ${status.needed ? 'Pendente' : `Em dia até ${fmtDate(toISODate(status.dueDate))}`}</span>
              ${isFirstTime
                ? `<span class="badge badge-blue">Conferência: Dispensada (primeira vez)</span>`
                : `<span class="badge ${confStatus.needed ? 'badge-red' : 'badge-green'}">Conferência: ${confStatus.needed ? 'Pendente' : `Próxima em ${fmtDate(toISODate(confStatus.dueDate))}`}</span>`}
            </div>
            <div class="record-meta">
              <span><strong>Maleta:</strong> 🧰 ${bc?.code ? bc.code + ' — ' : ''}${bc?.name || '—'}</span>
              <span><strong>Ferramentas (${(bc?.tools||[]).length}):</strong> ${toolsList || 'Nenhuma cadastrada'}</span>
              ${status.needed ? `<span style="grid-column:1/-1"><strong>Motivo (termo):</strong> ${status.reason}</span>` : ''}
              ${(!isFirstTime && confStatus.needed) ? `<span style="grid-column:1/-1"><strong>Motivo (conferência):</strong> ${confStatus.reason}</span>` : ''}
              ${isFirstTime ? `<span style="grid-column:1/-1;color:var(--text-muted);"><strong>Obs:</strong> Primeira vinculação da maleta — a conferência do cadastro já cobre este requisito, basta assinar o termo.</span>` : ''}
            </div>
          </div>
          <div class="record-actions">
            ${status.needed
              ? (canSignBriefcaseTermNow(d.id)
                  ? `<button class="btn btn-primary btn-sm" onclick="openWeeklyTermModal('${d.id}')">Assinar Termo</button>`
                  : `<span style="font-size:0.78rem;color:var(--text-muted);max-width:220px;">⚠ Confira a maleta antes de liberar a assinatura do termo</span>`)
              : (canManage ? `<button class="btn btn-ghost btn-sm" onclick="requestBriefcaseSignature('${d.id}')">Solicitar Nova Assinatura</button>` : '')}
            ${isFirstTime ? '' : `<button class="btn btn-edit btn-sm" onclick="openBriefcaseConferenceModal('${d.id}')">🔍 Conferir Maleta</button>`}
          </div>
        </div>`;
      }).join('')}
      </div></div>`;
  }
  renderWeeklyTermHistory();
  renderBriefcaseConferenceHistory();
}

function renderWeeklyTermHistory() {
  const el = document.getElementById('weekly-terms-history'); if (!el) return;
  const canManage = canManageBriefcaseTerms();
  const terms = [...(db.briefcaseTerms || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!terms.length) { el.innerHTML = emptyState('📜', 'Nenhum termo assinado ainda', ''); return; }
  el.innerHTML = `<div class="panel"><div class="panel-header"><span class="panel-title">Histórico de Termos Assinados (${terms.length})</span></div>
    <div class="panel-body" style="padding:0"><div style="overflow-x:auto;"><table class="data-table">
      <thead><tr><th>Técnico</th><th>Maleta</th><th>Assinado em</th><th>Válido até</th><th>Assinatura</th><th></th></tr></thead>
      <tbody>${terms.map(t => `<tr>
        <td>${t.driverName}</td><td>${t.briefcaseName || '—'}</td>
        <td>${new Date(t.date).toLocaleString('pt-BR')}</td>
        <td>${fmtDate(toISODate(getBriefcaseTermDueDate(t.date)))}</td>
        <td><img src="${t.signature}" style="width:80px;background:#fff;border-radius:4px;border:1px solid var(--border);"></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" onclick="printBriefcaseTerm('${t.id}')">📄 PDF</button>
          ${canManage ? `<button class="btn btn-danger btn-sm" onclick="deleteBriefcaseTerm('${t.id}')">Excluir</button>` : ''}
        </td>
      </tr>`).join('')}</tbody>
    </table></div></div></div>`;
}

// Exclui um termo já assinado — restrito ao Gestor e ao Administrador Geral, pois volta
// o técnico ao status "pendente" (reabre a necessidade de nova assinatura/conferência).
function deleteBriefcaseTerm(termId) {
  if (!canManageBriefcaseTerms()) { showToast('Apenas o Gestor ou o Administrador Geral podem excluir um termo assinado.', 'error'); return; }
  const term = (db.briefcaseTerms || []).find(t => t.id === termId);
  if (!term) return;
  confirmDialog(`Excluir o termo assinado de ${term.driverName}? O técnico voltará a constar como pendente.`, () => {
    dbFull.briefcaseTerms = (dbFull.briefcaseTerms || []).filter(t => t.id !== termId);
    logAudit('delete', 'briefcase-term', term.id, term.driverName, term, null);
    saveDB();
    showToast('Termo assinado excluído.', 'success');
    renderWeeklyTermsPage();
  });
}

function openBriefcaseConferenceModal(driverId) {
  const driver = db.drivers.find(d => d.id === driverId);
  const bc     = db.briefcases.find(b => b.assignedDriverId === driverId);
  if (!bc) { showToast('Este técnico não possui maleta atribuída.', 'error'); return; }
  const tools = bc.tools || [];
  const canManage = canManageBriefcaseTerms();
  const checklistHtml = tools.length
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;">` +
      tools.map(t => `<label style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;font-size:0.84rem;">
        <input type="checkbox" class="bconf-item" data-tool-id="${t.id}" data-tool-name="${t.name.replace(/"/g,'&quot;')}" checked style="width:16px;height:16px;accent-color:var(--success);">
        ${t.name}
      </label>`).join('') + `</div>`
    : `<span style="color:var(--text-muted);font-size:0.82rem;">Esta maleta não possui ferramentas cadastradas.</span>`;

  openModal('Conferência de Maleta', `
    <p style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:12px;">
      Técnico: <strong>${driver?.name || '—'}</strong> — Maleta: <strong>${bc.code ? bc.code + ' — ' : ''}${bc.name}</strong><br>
      Desmarque os itens que não foram encontrados na conferência.
    </p>
    <div class="field" style="margin-bottom:12px;"><label>Quem está realizando a conferência</label>
      ${canManage
        ? `<select id="bconf-conferent">
             <option value="">Gestor/Administrador</option>
             <option value="${driverId}">${driver?.name || 'Técnico'} (o próprio técnico, dono da maleta)</option>
           </select>
           <span style="font-size:0.74rem;color:var(--text-muted);">Por padrão quem confere é o Gestor; selecione o próprio técnico apenas se ele estiver fazendo a autoconferência.</span>`
        : `<select id="bconf-conferent" disabled>
             <option value="" selected>Gestor/Administrador</option>
           </select>
           <span style="font-size:0.74rem;color:var(--text-muted);">Somente o Gestor ou o Administrador Geral podem escolher quem confere.</span>`}
    </div>
    <div class="field" style="margin-bottom:12px;"><label>Data da Conferência</label><input type="date" id="bconf-date" value="${new Date().toISOString().substring(0,10)}"></div>
    <div id="bconf-checklist">${checklistHtml}</div>
    <div class="field" style="margin-top:14px;"><label>Observações</label><textarea id="bconf-notes" placeholder="Detalhes sobre itens faltando, estado de conservação, etc..."></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="saveBriefcaseConference('${driverId}','${bc.id}')">Registrar Conferência</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
    </div>`);
}

function saveBriefcaseConference(driverId, briefcaseId) {
  const driver = db.drivers.find(d => d.id === driverId);
  const bc     = db.briefcases.find(b => b.id === briefcaseId);
  const checklist = [];
  document.querySelectorAll('#bconf-checklist .bconf-item').forEach(chk => {
    checklist.push({ id: chk.dataset.toolId, name: chk.dataset.toolName, present: chk.checked });
  });
  const conferentId = document.getElementById('bconf-conferent').value || null;
  const conferentDriver = conferentId ? db.drivers.find(d => d.id === conferentId) : null;
  const record = {
    id: uid(), driverId, driverName: driver?.name || '',
    briefcaseId, briefcaseName: bc ? `${bc.code ? bc.code + ' — ' : ''}${bc.name}` : null,
    date: document.getElementById('bconf-date').value || new Date().toISOString().substring(0,10),
    checklist,
    conferenteId: conferentId,
    conferenteName: conferentDriver ? conferentDriver.name : 'Gestor/Administrador',
    notes: document.getElementById('bconf-notes').value.trim(),
    createdAt: new Date().toISOString(),
  };
  const missing = checklist.filter(c => !c.present);
  if (missing.length) {
    // Se algum item ficou faltando, a conferência só é gravada depois que o técnico
    // assinar reconhecendo a ausência — uma assinatura única cobrindo todos os itens
    // faltantes desta conferência (não uma por item).
    closeModal();
    openMissingItemsSignatureModal(record, driver);
    return;
  }
  finalizeBriefcaseConference(record);
}

// Grava de fato o registro de conferência (chamado direto quando não há item faltando,
// ou após a assinatura do técnico quando há).
function finalizeBriefcaseConference(record) {
  db.briefcaseConferences = db.briefcaseConferences || [];
  record.empresaId = currentEmpresaId();
  dbFull.briefcaseConferences.push(record);
  logAudit('briefcase-conference', 'briefcase-conference', record.id, record.driverName, null, { date: record.date, conferente: record.conferenteName });
  saveDB();
  const missing = (record.checklist || []).filter(c => !c.present).length;
  showToast(missing ? `Conferência registrada — ${missing} item(ns) faltando!` : 'Conferência registrada — tudo certo!', missing ? 'error' : 'success');
  renderWeeklyTermsPage();
}

// ── ASSINATURA DO TÉCNICO PARA ITENS FALTANDO NA CONFERÊNCIA ──
// Uma única assinatura cobre todos os itens que ficaram faltando naquela conferência.
let missSigCtx = null, missSigDrawing = false, missSigHasStroke = false;
let pendingMissingItemsConference = null;

function openMissingItemsSignatureModal(record, driver) {
  pendingMissingItemsConference = record;
  const missingNames = (record.checklist || []).filter(c => !c.present).map(c => c.name);
  document.getElementById('miss-sig-driver-name').innerHTML =
    `Técnico: <strong>${driver?.name || record.driverName}</strong><br>Os itens abaixo não foram encontrados nesta conferência. Ao assinar, o técnico reconhece a ausência destes itens e assume o compromisso de resolver a pendência.`;
  document.getElementById('miss-sig-items').innerHTML = missingNames.length
    ? missingNames.map(n => `<span class="missing-item-chip">${n}</span>`).join('')
    : '';
  document.getElementById('missing-signature-modal-overlay').classList.add('open');
  requestAnimationFrame(initMissingSignatureCanvas);
}
function closeMissingItemsSignatureModal() {
  document.getElementById('missing-signature-modal-overlay').classList.remove('open');
  pendingMissingItemsConference = null;
}
function initMissingSignatureCanvas() {
  const canvas = document.getElementById('missing-signature-canvas');
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  missSigCtx = canvas.getContext('2d');
  missSigCtx.scale(ratio, ratio);
  missSigCtx.lineWidth = 2.2; missSigCtx.lineCap = 'round'; missSigCtx.strokeStyle = '#0A0E1A';
  missSigHasStroke = false;

  const getPos = (e) => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
  const start = (e) => { e.preventDefault(); missSigDrawing = true; missSigHasStroke = true; const p = getPos(e); missSigCtx.beginPath(); missSigCtx.moveTo(p.x, p.y); };
  const move  = (e) => { if (!missSigDrawing) return; e.preventDefault(); const p = getPos(e); missSigCtx.lineTo(p.x, p.y); missSigCtx.stroke(); };
  const end   = () => { missSigDrawing = false; };

  canvas.onmousedown = start; canvas.onmousemove = move; canvas.onmouseup = end; canvas.onmouseleave = end;
  canvas.ontouchstart = start; canvas.ontouchmove = move; canvas.ontouchend = end;
}
function clearMissingSignature() {
  const canvas = document.getElementById('missing-signature-canvas');
  const ratio = window.devicePixelRatio || 1;
  missSigCtx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
  missSigHasStroke = false;
}
function confirmMissingItemsSignature() {
  if (!missSigHasStroke) { showToast('É necessário colher a assinatura do técnico para os itens faltando.', 'error'); return; }
  const record = pendingMissingItemsConference;
  if (!record) return;
  const canvas = document.getElementById('missing-signature-canvas');
  record.missingSignature = {
    signature: canvas.toDataURL('image/png'),
    signedAt: new Date().toISOString(),
    signedBy: record.driverName,
  };
  closeMissingItemsSignatureModal();
  finalizeBriefcaseConference(record);
}

function renderBriefcaseConferenceHistory() {
  const el = document.getElementById('briefcase-conference-history');
  if (!el) return;
  const canManage = canManageBriefcaseTerms();
  const items = [...(db.briefcaseConferences || [])].sort((a,b) => new Date(b.date) - new Date(a.date));
  if (!items.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="panel"><div class="panel-header"><span class="panel-title">Histórico de Conferências (${items.length})</span></div>
    <div class="record-list">${items.map(c => {
      const total   = c.checklist ? c.checklist.length : 0;
      const present = c.checklist ? c.checklist.filter(t => t.present).length : 0;
      const missing = c.checklist ? c.checklist.filter(t => !t.present) : [];
      const resolved = c.checklist ? c.checklist.filter(t => t.present && t.resolvedReason) : [];
      const allOk   = total > 0 && present === total;
      const missingHtml = missing.length ? `
        <div style="grid-column:1/-1;">
          <strong style="color:var(--danger)">Faltando:</strong>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
            ${missing.map(t => `
              <span class="missing-item-chip">
                ${t.name}
                ${canManage ? `
                <button type="button" class="btn-inline-link" title="Marcar como comprado novamente" onclick="resolveMissingItem('conference','${c.id}','${t.id}','Comprado novamente')">🛒</button>
                <button type="button" class="btn-inline-link" title="Marcar como encontrado" onclick="resolveMissingItem('conference','${c.id}','${t.id}','Item encontrado')">🔍</button>
                ` : ''}
              </span>`).join('')}
          </div>
        </div>` : '';
      const missingSigHtml = c.missingSignature ? `
        <div style="grid-column:1/-1;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px;">
          <span style="font-size:0.78rem;color:var(--text-muted);"><strong>Assinatura do técnico (itens faltando):</strong></span>
          <img src="${c.missingSignature.signature}" style="width:70px;background:#fff;border-radius:4px;border:1px solid var(--border);">
          <span style="font-size:0.72rem;color:var(--text-muted);">${new Date(c.missingSignature.signedAt).toLocaleString('pt-BR')}</span>
        </div>` : '';
      const resolvedHtml = resolved.length ? `
        <div style="grid-column:1/-1;margin-top:4px;">
          <strong style="color:var(--success)">Itens devolvidos/resolvidos:</strong>
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px;">
            ${resolved.map(t => `
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:0.78rem;color:var(--text-muted);">
                <span><strong>${t.name}</strong> — ${t.resolvedReason}${t.resolvedBy ? ' — assinado por ' + t.resolvedBy : ''}</span>
                ${t.resolvedSignature ? `<img src="${t.resolvedSignature}" style="width:60px;background:#fff;border-radius:4px;border:1px solid var(--border);">` : ''}
                ${t.resolvedAt ? `<span>${new Date(t.resolvedAt).toLocaleString('pt-BR')}</span>` : ''}
              </div>`).join('')}
          </div>
        </div>` : '';
      return `<div class="record-item">
        <div class="record-stripe" style="background:${missing.length ? 'var(--danger)' : 'var(--success)'}"></div>
        <div class="record-body">
          <div class="record-title-row">
            <span class="badge ${missing.length ? 'badge-red' : 'badge-green'}">${missing.length ? `⚠ ${present}/${total} itens` : allOk ? '✓ OK' : 'SEM ITENS'}</span>
            <span class="record-name">🧰 ${c.driverName}${c.briefcaseName ? ' — ' + c.briefcaseName : ''}</span>
          </div>
          <div class="record-meta">
            <span><strong>Data:</strong> ${fmtDate(c.date)}</span>
            <span><strong>Conferente:</strong> ${c.conferenteName || 'Gestor/Administrador'}</span>
            ${missingHtml}
            ${missingSigHtml}
            ${resolvedHtml}
            ${c.notes ? `<span style="grid-column:1/-1"><strong>Obs:</strong> ${c.notes}</span>` : ''}
          </div>
        </div>
        <div class="record-actions">
          ${canManage ? `<button class="btn btn-danger btn-sm" onclick="deleteBriefcaseConference('${c.id}')">Excluir</button>` : ''}
        </div>
      </div>`;
    }).join('')}</div></div>`;
}

function deleteBriefcaseConference(id) {
  confirmDialog('Excluir este registro de conferência?', () => {
    dbFull.briefcaseConferences = (dbFull.briefcaseConferences || []).filter(c => c.id !== id);
    saveDB(); renderBriefcaseConferenceHistory(); renderBriefcaseList();
    showToast('Registro excluído.', 'success');
  });
}

// Marca um item que ficou faltando (numa devolução ou numa conferência) como resolvido —
// porque foi comprado novamente ou porque foi encontrado — sem apagar o histórico do
// que aconteceu. Atualiza também o aviso mostrado na aba Maletas.
// Na Conferência da Maleta (Termo da Maleta), a devolução do item exige a assinatura de
// quem está registrando — o Gestor ou o Administrador Geral.
function resolveMissingItem(kind, recordId, toolId, reason) {
  if (kind === 'conference') {
    if (!canManageBriefcaseTerms()) { showToast('Apenas o Gestor ou o Administrador Geral podem registrar a devolução de um item faltando.', 'error'); return; }
    openResolveItemSignatureModal(recordId, toolId, reason);
    return;
  }
  const list      = dbFull.briefcaseReturns;
  const record = (list || []).find(r => r.id === recordId);
  if (!record) return;
  const item = (record.checklist || []).find(t => t.id === toolId);
  if (!item) return;
  item.returned      = true;
  item.resolvedReason = reason;
  item.resolvedAt     = new Date().toISOString();
  saveDB();
  showToast(`"${item.name}" marcado como resolvido — ${reason}.`, 'success');
  renderBriefcaseReturnList();
  renderBriefcaseList(); // atualiza o aviso de item faltando na aba Maletas
}

// ── ASSINATURA DE QUEM REGISTRA A DEVOLUÇÃO DE UM ITEM FALTANDO NA CONFERÊNCIA ──
let resolveSigCtx = null, resolveSigDrawing = false, resolveSigHasStroke = false;
let pendingResolveItem = null; // { recordId, toolId, reason }

function openResolveItemSignatureModal(recordId, toolId, reason) {
  const record = (dbFull.briefcaseConferences || []).find(r => r.id === recordId);
  const item = record && (record.checklist || []).find(t => t.id === toolId);
  if (!record || !item) return;
  pendingResolveItem = { recordId, toolId, reason };
  document.getElementById('resolve-sig-title').innerHTML =
    `Item: <strong>${item.name}</strong> — ${reason}<br>Assinatura de quem está registrando a devolução: <strong>${currentUser?.name || 'Gestor/Administrador'}</strong>.`;
  document.getElementById('resolve-signature-modal-overlay').classList.add('open');
  requestAnimationFrame(initResolveSignatureCanvas);
}
function closeResolveItemSignatureModal() {
  document.getElementById('resolve-signature-modal-overlay').classList.remove('open');
  pendingResolveItem = null;
}
function initResolveSignatureCanvas() {
  const canvas = document.getElementById('resolve-signature-canvas');
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  resolveSigCtx = canvas.getContext('2d');
  resolveSigCtx.scale(ratio, ratio);
  resolveSigCtx.lineWidth = 2.2; resolveSigCtx.lineCap = 'round'; resolveSigCtx.strokeStyle = '#0A0E1A';
  resolveSigHasStroke = false;

  const getPos = (e) => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
  const start = (e) => { e.preventDefault(); resolveSigDrawing = true; resolveSigHasStroke = true; const p = getPos(e); resolveSigCtx.beginPath(); resolveSigCtx.moveTo(p.x, p.y); };
  const move  = (e) => { if (!resolveSigDrawing) return; e.preventDefault(); const p = getPos(e); resolveSigCtx.lineTo(p.x, p.y); resolveSigCtx.stroke(); };
  const end   = () => { resolveSigDrawing = false; };

  canvas.onmousedown = start; canvas.onmousemove = move; canvas.onmouseup = end; canvas.onmouseleave = end;
  canvas.ontouchstart = start; canvas.ontouchmove = move; canvas.ontouchend = end;
}
function clearResolveSignature() {
  const canvas = document.getElementById('resolve-signature-canvas');
  const ratio = window.devicePixelRatio || 1;
  resolveSigCtx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
  resolveSigHasStroke = false;
}
function confirmResolveItemSignature() {
  if (!resolveSigHasStroke) { showToast('É necessário assinar para confirmar a devolução do item.', 'error'); return; }
  const pending = pendingResolveItem;
  if (!pending) return;
  const record = (dbFull.briefcaseConferences || []).find(r => r.id === pending.recordId);
  const item = record && (record.checklist || []).find(t => t.id === pending.toolId);
  if (!record || !item) { closeResolveItemSignatureModal(); return; }
  const canvas = document.getElementById('resolve-signature-canvas');
  item.present         = true;
  item.resolvedReason  = pending.reason;
  item.resolvedAt      = new Date().toISOString();
  item.resolvedBy      = currentUser?.name || 'Gestor/Administrador';
  item.resolvedSignature = canvas.toDataURL('image/png');
  saveDB();
  closeResolveItemSignatureModal();
  showToast(`"${item.name}" marcado como resolvido — ${item.resolvedReason}.`, 'success');
  renderBriefcaseConferenceHistory();
  renderBriefcaseList(); // atualiza o aviso de item faltando na aba Maletas
}

function openWeeklyTermModal(driverId) {
  if (!canSignBriefcaseTermNow(driverId)) {
    showToast('É necessário conferir a maleta antes de assinar o termo.', 'error');
    return;
  }
  pendingTermDriverId = driverId;
  const driver = db.drivers.find(d => d.id === driverId);
  const bc = db.briefcases.find(b => b.assignedDriverId === driverId);
  const toolCount = (bc?.tools || []).length;
  document.getElementById('bf-sig-driver-name').innerHTML = `Técnico: <strong>${driver?.name || '—'}</strong> — Termo de Responsabilidade da Maleta (validade de ${BRIEFCASE_TERM_VALIDITY_MONTHS} meses)<br>Este termo incluirá as <strong>${toolCount} ferramenta(s)</strong> atualmente cadastradas na maleta.`;
  document.getElementById('briefcase-signature-modal-overlay').classList.add('open');
  requestAnimationFrame(initBriefcaseSignatureCanvas);
}
function closeBriefcaseSignatureModal() {
  document.getElementById('briefcase-signature-modal-overlay').classList.remove('open');
  pendingTermDriverId = null;
}
function initBriefcaseSignatureCanvas() {
  const canvas = document.getElementById('briefcase-signature-canvas');
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  bfSigCtx = canvas.getContext('2d');
  bfSigCtx.scale(ratio, ratio);
  bfSigCtx.lineWidth = 2.2; bfSigCtx.lineCap = 'round'; bfSigCtx.strokeStyle = '#0A0E1A';
  bfSigHasStroke = false;

  const getPos = (e) => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
  const start = (e) => { e.preventDefault(); bfSigDrawing = true; bfSigHasStroke = true; const p = getPos(e); bfSigCtx.beginPath(); bfSigCtx.moveTo(p.x, p.y); };
  const move  = (e) => { if (!bfSigDrawing) return; e.preventDefault(); const p = getPos(e); bfSigCtx.lineTo(p.x, p.y); bfSigCtx.stroke(); };
  const end   = () => { bfSigDrawing = false; };

  canvas.onmousedown = start; canvas.onmousemove = move; canvas.onmouseup = end; canvas.onmouseleave = end;
  canvas.ontouchstart = start; canvas.ontouchmove = move; canvas.ontouchend = end;
}
function clearBriefcaseSignature() {
  const canvas = document.getElementById('briefcase-signature-canvas');
  const ratio = window.devicePixelRatio || 1;
  bfSigCtx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
  bfSigHasStroke = false;
}
function confirmBriefcaseSignature() {
  if (!bfSigHasStroke) { showToast('É necessário assinar para confirmar o termo.', 'error'); return; }
  const driver = db.drivers.find(d => d.id === pendingTermDriverId);
  const briefcase = db.briefcases.find(b => b.assignedDriverId === pendingTermDriverId);
  const canvas = document.getElementById('briefcase-signature-canvas');
  const entry = {
    id: uid(), driverId: pendingTermDriverId, driverName: driver?.name || '',
    briefcaseId: briefcase?.id || null, briefcaseName: briefcase ? `${briefcase.code ? briefcase.code + ' — ' : ''}${briefcase.name}` : null,
    tools: briefcase ? (briefcase.tools || []).map(t => ({ ...t })) : [],
    signature: canvas.toDataURL('image/png'), date: new Date().toISOString(),
  };
  db.briefcaseTerms = db.briefcaseTerms || [];
  entry.empresaId = currentEmpresaId();
  dbFull.briefcaseTerms.push(entry);
  logAudit('weekly-term-sign', 'briefcase-term', entry.id, entry.driverName, null, { date: entry.date });
  saveDB();
  closeBriefcaseSignatureModal();
  showToast('Termo de responsabilidade assinado!', 'success');
  renderWeeklyTermsPage();
}

// ── FERRAMENTAS DE USO COMUM (catálogo público + retiradas/devoluções + relatório) ──

function initToolsPage() {
  populateToolCatalogSelects();
  populateTempItemSelects();
  renderToolList();
  renderTempItemList();
  renderToolsReport();
  // garante que a aba ativa (ou a primeira, no primeiro acesso) esteja com o conteúdo atualizado
  const activeBtn = document.querySelector('#tools-tab-nav .tab-btn.active') || document.querySelector('#tools-tab-nav .tab-btn[data-tab="catalog"]');
  if (activeBtn) switchToolsTab(activeBtn.dataset.tab, activeBtn);
}

function switchToolsTab(tab, btn) {
  document.querySelectorAll('#tools-tab-nav .tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#temp-items-page .tab-content').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const content = document.getElementById('tools-tab-content-' + tab);
  if (content) content.classList.add('active');
  if (tab === 'catalog')  renderToolList();
  if (tab === 'checkout') { populateTempItemSelects(); renderTempItemList(); }
  if (tab === 'report')   renderToolsReport();
}

// ── Catálogo de Ferramentas ──
function populateToolCatalogSelects() {
  const tools = [...(db.tools || [])].sort((a,b) => a.name.localeCompare(b.name, 'pt-BR'));
  const disponivel = t => (t.quantity || 1) - (db.tempItems || []).filter(ti => ti.toolId === t.id && ti.status !== 'devolvido').length;
  const opts = tools.map(t => `<option value="${t.id}">${t.name}${t.price ? ' — ' + fmtCurrency(t.price) : ''} (Disponível: ${disponivel(t)}/${t.quantity || 1})</option>`).join('');
  const tiSel = document.getElementById('ti-tool');
  if (tiSel) { const cur = tiSel.value; tiSel.innerHTML = '<option value="">Selecione...</option>' + opts; if (cur) tiSel.value = cur; }
  const trSel = document.getElementById('tr-tool');
  if (trSel) { const cur = trSel.value; trSel.innerHTML = '<option value="">Todas</option>' + tools.map(t => `<option value="${t.id}">${t.name}</option>`).join(''); if (cur) trSel.value = cur; }
  const trDriverSel = document.getElementById('tr-driver');
  if (trDriverSel) { const cur = trDriverSel.value; trDriverSel.innerHTML = '<option value="">Todos</option>' + db.drivers.map(d => `<option value="${d.id}">${d.name}</option>`).join(''); if (cur) trDriverSel.value = cur; }
}

function resetToolForm() {
  document.getElementById('tool-form').reset();
  const btn = document.getElementById('tool-submit-btn');
  delete btn.dataset.editId; btn.textContent = 'Cadastrar Ferramenta';
  document.getElementById('tool-form-title').textContent = 'Nova Ferramenta';
}

function submitTool(e) {
  e.preventDefault();
  const btn = document.getElementById('tool-submit-btn');
  const editId = btn.dataset.editId;
  const name = document.getElementById('tool-name').value.trim();
  if (!name) { showToast('Informe o nome da ferramenta.', 'error'); return; }
  const quantity = parseInt(document.getElementById('tool-quantity').value, 10) || 1;
  if (quantity < 1) { showToast('A quantidade deve ser de pelo menos 1.', 'error'); return; }
  if (editId) {
    // não permite reduzir a quantidade abaixo do que já está retirado/em posse no momento
    const emPosseCount = (db.tempItems || []).filter(ti => ti.toolId === editId && ti.status !== 'devolvido').length;
    if (quantity < emPosseCount) {
      showToast(`Não é possível reduzir a quantidade para ${quantity}: há ${emPosseCount} unidade(s) em posse no momento.`, 'error');
      return;
    }
  }
  const oldRecord = editId ? db.tools.find(t => t.id === editId) : null;
  const record = {
    id: editId || uid(),
    name,
    quantity,
    price: parseCurrencyInput('tool-price'),
    category: document.getElementById('tool-category').value.trim(),
    notes: document.getElementById('tool-notes').value.trim(),
    empresaId: editId ? (oldRecord?.empresaId ?? currentEmpresaId()) : currentEmpresaId(),
    createdAt: oldRecord?.createdAt || new Date().toISOString(),
  };
  if (editId) {
    dbFull.tools = dbFull.tools.map(t => t.id === editId ? record : t);
    // mantém o preço/nome sincronizados nas retiradas em aberto desta ferramenta (histórico não é alterado)
    logAudit('update', 'tool', record.id, record.name, oldRecord, record);
    showToast('Ferramenta atualizada!', 'success');
  } else {
    dbFull.tools.push(record);
    logAudit('create', 'tool', record.id, record.name, null, record);
    showToast('Ferramenta cadastrada!', 'success');
  }
  saveDB(); resetToolForm(); renderToolList(); populateToolCatalogSelects();
}

function editTool(id) {
  const t = db.tools.find(t => t.id === id); if (!t) return;
  document.getElementById('tool-name').value = t.name;
  document.getElementById('tool-quantity').value = t.quantity || 1;
  setCurrencyInput('tool-price', t.price);
  document.getElementById('tool-category').value = t.category || '';
  document.getElementById('tool-notes').value = t.notes || '';
  const btn = document.getElementById('tool-submit-btn');
  btn.dataset.editId = id; btn.textContent = 'Salvar Alterações';
  document.getElementById('tool-form-title').textContent = 'Editar Ferramenta';
  scrollMainContent(0);
}

function deleteTool(id) {
  const target = db.tools.find(t => t.id === id);
  const inUse = (db.tempItems || []).some(ti => ti.toolId === id && ti.status !== 'devolvido');
  if (inUse) { showToast('Esta ferramenta está retirada no momento e não pode ser excluída.', 'error'); return; }
  confirmDialog('Excluir esta ferramenta do catálogo? O histórico de retiradas já feitas será mantido.', () => {
    dbFull.tools = dbFull.tools.filter(t => t.id !== id);
    logAudit('delete', 'tool', id, target?.name, target, null);
    saveDB(); renderToolList(); populateToolCatalogSelects();
    showToast('Ferramenta excluída.', 'success');
  });
}

function renderToolList() {
  const el = document.getElementById('tool-list'); if (!el) return;
  const tools = [...(db.tools || [])].sort((a,b) => a.name.localeCompare(b.name, 'pt-BR'));
  if (!tools.length) { el.innerHTML = emptyState('🧰', 'Nenhuma ferramenta cadastrada', 'Cadastre as ferramentas públicas da empresa acima.'); return; }
  el.innerHTML = `<div class="panel"><div class="panel-header"><span class="panel-title">Ferramentas Cadastradas (${tools.length})</span></div>
    <div class="panel-body" style="padding:0">
    ${tools.map(t => {
      const emPosse = (db.tempItems || []).filter(ti => ti.toolId === t.id && ti.status !== 'devolvido').length;
      const total = t.quantity || 1;
      const disponivel = total - emPosse;
      return `<div class="record-item">
        <div class="record-stripe" style="background:${disponivel <= 0 ? 'var(--orange)' : 'var(--success)'}"></div>
        <div class="record-body">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
            <strong>${t.name}</strong>
            ${t.price ? `<span class="badge badge-green">${fmtCurrency(t.price)}</span>` : ''}
            <span class="badge ${disponivel <= 0 ? 'badge-orange' : 'badge-green'}">${disponivel <= 0 ? 'Indisponível' : disponivel + '/' + total + ' disponível'}</span>
          </div>
          <div class="record-meta">
            <span><strong>Quantidade Total:</strong> ${total}</span>
            ${emPosse ? `<span><strong>Em posse:</strong> ${emPosse}</span>` : ''}
            ${t.category ? `<span><strong>Categoria:</strong> ${t.category}</span>` : ''}
            ${t.notes ? `<span style="grid-column:1/-1"><strong>Obs:</strong> ${t.notes}</span>` : ''}
          </div>
        </div>
        <div class="record-actions">
          <button class="btn btn-edit btn-sm" onclick="editTool('${t.id}')">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="deleteTool('${t.id}')">Excluir</button>
        </div>
      </div>`;
    }).join('')}
    </div></div>`;
}

// ── Retiradas & Devoluções ──
function populateTempItemSelects() {
  const sel = document.getElementById('ti-driver');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Selecione...</option>' + db.drivers.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
    if (cur) sel.value = cur;
  }
  populateToolCatalogSelects();
}

function resetTempItemForm() {
  document.getElementById('temp-item-form').reset();
  document.getElementById('ti-checkout-date').valueAsDate = new Date();
  const btn = document.getElementById('ti-submit-btn');
  delete btn.dataset.editId; btn.textContent = 'Registrar Retirada';
}

function submitTempItem(e) {
  e.preventDefault();
  const btn = document.getElementById('ti-submit-btn');
  const editId = btn.dataset.editId;
  const driver = db.drivers.find(d => d.id === document.getElementById('ti-driver').value);
  if (!driver) { showToast('Selecione o técnico.', 'error'); return; }
  const tool = db.tools.find(t => t.id === document.getElementById('ti-tool').value);
  if (!tool) { showToast('Selecione a ferramenta.', 'error'); return; }
  // Só permite retirar até a quantidade disponível hoje no sistema (exclui o próprio registro, se for edição)
  const emPosseCount = (db.tempItems || []).filter(ti => ti.toolId === tool.id && ti.status !== 'devolvido' && ti.id !== editId).length;
  const totalQty = tool.quantity || 1;
  if (emPosseCount >= totalQty) {
    showToast(`Não há unidades disponíveis de "${tool.name}" no momento (${emPosseCount}/${totalQty} em posse).`, 'error');
    return;
  }
  const oldRecord = editId ? db.tempItems.find(t => t.id === editId) : null;
  const record = {
    id: editId || uid(),
    driverId: driver.id, driverName: driver.name,
    toolId: tool.id, item: tool.name,
    price: tool.price || 0, // preço vem sempre do cadastro da ferramenta, não é informado na retirada
    checkoutDate: document.getElementById('ti-checkout-date').value,
    expectedReturnDate: document.getElementById('ti-return-date').value || null,
    returnedDate: oldRecord?.returnedDate || null,
    notes: document.getElementById('ti-notes').value.trim(),
    status: oldRecord?.status || 'em_posse',
    empresaId: editId ? (oldRecord?.empresaId ?? currentEmpresaId()) : currentEmpresaId(),
    createdAt: oldRecord?.createdAt || new Date().toISOString(),
  };
  if (editId) {
    dbFull.tempItems = dbFull.tempItems.map(t => t.id === editId ? record : t);
    logAudit('update', 'temp-item', record.id, record.item, oldRecord, record);
    showToast('Registro atualizado!', 'success');
  } else {
    dbFull.tempItems.push(record);
    logAudit('create', 'temp-item', record.id, record.item, null, record);
    showToast('Retirada registrada!', 'success');
  }
  saveDB(); resetTempItemForm(); renderTempItemList(); renderToolList();
}

function editTempItem(id) {
  const t = db.tempItems.find(t => t.id === id); if (!t) return;
  document.getElementById('ti-driver').value = t.driverId;
  document.getElementById('ti-tool').value = t.toolId || '';
  document.getElementById('ti-checkout-date').value = t.checkoutDate;
  document.getElementById('ti-return-date').value = t.expectedReturnDate || '';
  document.getElementById('ti-notes').value = t.notes || '';
  const btn = document.getElementById('ti-submit-btn');
  btn.dataset.editId = id; btn.textContent = 'Salvar Alterações';
  scrollMainContent(0);
}

function deleteTempItem(id) {
  const target = db.tempItems.find(t => t.id === id);
  confirmDialog('Excluir este registro de retirada?', () => {
    dbFull.tempItems = dbFull.tempItems.filter(t => t.id !== id);
    logAudit('delete', 'temp-item', id, target?.item, target, null);
    saveDB(); renderTempItemList(); renderToolList();
    showToast('Registro excluído.', 'success');
  });
}

function markTempItemReturned(id) {
  const t = db.tempItems.find(t => t.id === id); if (!t) return;
  t.status = 'devolvido';
  t.returnedDate = toISODate(new Date());
  logAudit('update', 'temp-item', id, t.item, null, { status: 'devolvido', returnedDate: t.returnedDate });
  saveDB(); renderTempItemList(); renderToolList();
  showToast('Ferramenta marcada como devolvida.', 'success');
}

function renderTempItemList() {
  const el = document.getElementById('temp-item-list'); if (!el) return;
  if (!db.tempItems.length) { el.innerHTML = emptyState('🔄', 'Nenhuma retirada registrada', ''); return; }
  const sorted = [...db.tempItems].sort((a, b) => new Date(b.checkoutDate) - new Date(a.checkoutDate));
  el.innerHTML = `<div class="panel"><div class="panel-header"><span class="panel-title">Retiradas Registradas (${db.tempItems.length})</span></div>
    <div class="panel-body" style="padding:0">
    ${sorted.map(t => {
      const overdue = t.status === 'em_posse' && t.expectedReturnDate && new Date(t.expectedReturnDate) < new Date();
      return `<div class="record-item">
        <div class="record-stripe" style="background:${t.status==='devolvido' ? 'var(--success)' : overdue ? 'var(--danger)' : 'var(--orange)'}"></div>
        <div class="record-body">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
            <strong>${t.item}</strong>
            ${t.price ? `<span class="badge badge-green">${fmtCurrency(t.price)}</span>` : ''}
            <span class="badge ${t.status==='devolvido' ? 'badge-green' : overdue ? 'badge-red' : 'badge-orange'}">${t.status==='devolvido' ? 'Devolvido' : overdue ? 'Atrasado' : 'Em Posse'}</span>
          </div>
          <div class="record-meta">
            <span><strong>Técnico:</strong> ${t.driverName}</span>
            <span><strong>Retirada:</strong> ${fmtDate(t.checkoutDate)}</span>
            <span><strong>Data de Devolução:</strong> ${t.expectedReturnDate ? fmtDate(t.expectedReturnDate) : '—'}</span>
            ${t.returnedDate ? `<span><strong>Devolvido em:</strong> ${fmtDate(t.returnedDate)}</span>` : ''}
            ${t.notes ? `<span style="grid-column:1/-1"><strong>Obs:</strong> ${t.notes}</span>` : ''}
          </div>
        </div>
        <div class="record-actions">
          ${t.status !== 'devolvido' ? `<button class="btn btn-ghost btn-sm" onclick="markTempItemReturned('${t.id}')">Marcar Devolvido</button>` : ''}
          <button class="btn btn-edit btn-sm" onclick="editTempItem('${t.id}')">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="deleteTempItem('${t.id}')">Excluir</button>
        </div>
      </div>`;
    }).join('')}
    </div></div>`;
}

// ── Relatório de Ferramentas ──
function _toolsReportFiltered() {
  const toolId  = document.getElementById('tr-tool')?.value || '';
  const driverId = document.getElementById('tr-driver')?.value || '';
  const status  = document.getElementById('tr-status')?.value || '';
  const dateFrom = document.getElementById('tr-date-from')?.value || '';
  const dateTo   = document.getElementById('tr-date-to')?.value || '';
  return (db.tempItems || []).filter(t => {
    if (toolId && t.toolId !== toolId) return false;
    if (driverId && t.driverId !== driverId) return false;
    if (status && t.status !== status) return false;
    const d = (t.checkoutDate || '').substring(0,10);
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  }).sort((a,b) => new Date(b.checkoutDate) - new Date(a.checkoutDate));
}

function renderToolsReport() {
  const summaryEl = document.getElementById('tools-report-summary');
  const outEl = document.getElementById('tools-report-output');
  if (!summaryEl || !outEl) return;
  const rows = _toolsReportFiltered();
  const emPosse = rows.filter(t => t.status !== 'devolvido').length;
  const devolvidas = rows.filter(t => t.status === 'devolvido').length;
  const valorEmPosse = rows.filter(t => t.status !== 'devolvido').reduce((s,t) => s + (t.price||0), 0);
  const valorTotal = rows.reduce((s,t) => s + (t.price||0), 0);

  summaryEl.innerHTML = `<div class="report-kpis" style="margin:14px 0">
    <div class="report-kpi"><div class="report-kpi-label">Retiradas no Filtro</div><div class="report-kpi-value">${rows.length}</div></div>
    <div class="report-kpi"><div class="report-kpi-label">Em Posse</div><div class="report-kpi-value">${emPosse}</div></div>
    <div class="report-kpi"><div class="report-kpi-label">Devolvidas</div><div class="report-kpi-value">${devolvidas}</div></div>
    <div class="report-kpi"><div class="report-kpi-label">Valor em Posse</div><div class="report-kpi-value">${fmtCurrency(valorEmPosse)}</div></div>
    <div class="report-kpi"><div class="report-kpi-label">Valor Total (filtro)</div><div class="report-kpi-value">${fmtCurrency(valorTotal)}</div></div>
  </div>`;

  if (!rows.length) { outEl.innerHTML = `<div class="panel"><div class="panel-body">${emptyState('📋','Nenhum registro encontrado para os filtros selecionados','')}</div></div>`; window._toolsReportData = []; return; }

  outEl.innerHTML = `<div class="panel"><div class="panel-body" style="padding:0;overflow-x:auto">
    <table class="data-table">
      <thead><tr><th>Ferramenta</th><th>Técnico</th><th>Quem Pegou</th><th>Retirada</th><th>Data de Devolução</th><th>Quem Devolveu</th><th>Devolvido em</th><th>Status</th><th>Preço</th></tr></thead>
      <tbody>${rows.map(t => `<tr>
        <td>${t.item}</td>
        <td>${t.driverName}</td>
        <td>${t.driverName}</td>
        <td>${fmtDate(t.checkoutDate)}</td>
        <td>${t.expectedReturnDate ? fmtDate(t.expectedReturnDate) : '—'}</td>
        <td>${t.status === 'devolvido' ? t.driverName : '—'}</td>
        <td>${t.returnedDate ? fmtDate(t.returnedDate) : '—'}</td>
        <td><span class="badge ${t.status==='devolvido' ? 'badge-green' : 'badge-orange'}">${t.status==='devolvido' ? 'Devolvido' : 'Em Posse'}</span></td>
        <td>${fmtCurrency(t.price||0)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div></div>`;

  window._toolsReportData = rows;
}

function printToolsReport() {
  const rows = window._toolsReportData || [];
  if (!rows.length) { showToast('Nenhum dado para imprimir.', 'error'); return; }
  window.print();
}

function exportToolsReportCSV() {
  const rows = window._toolsReportData || [];
  if (!rows.length) { showToast('Nenhum dado para exportar.', 'error'); return; }
  const sep = ';';
  const csvRows = [
    [`${BRANDING().appName} — Relatório de Ferramentas de Uso Comum`],
    [`Gerado em: ${new Date().toLocaleString('pt-BR')}`],
    [],
    ['Ferramenta','Técnico (quem pegou)','Data de Retirada','Data de Devolução','Quem Devolveu','Devolvido em','Status','Preço'],
    ...rows.map(t => [
      t.item, t.driverName, fmtDate(t.checkoutDate),
      t.expectedReturnDate ? fmtDate(t.expectedReturnDate) : '',
      t.status === 'devolvido' ? t.driverName : '',
      t.returnedDate ? fmtDate(t.returnedDate) : '',
      t.status === 'devolvido' ? 'Devolvido' : 'Em Posse',
      (t.price||0).toFixed(2),
    ]),
  ];
  const csv = csvRows.map(r => Array.isArray(r) ? r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(sep) : '').join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8;' }));
  a.download = `frotactl_ferramentas_${Date.now()}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
  showToast('CSV exportado!', 'success');
}

let _assignmentOilBypass = false;
function submitAssignment(e) {
  e.preventDefault();
  const driverId  = document.getElementById('a-driver').value;
  const vehicleId = document.getElementById('a-vehicle').value;
  const driver    = db.drivers.find(d => d.id === driverId);
  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  if (!driver || !vehicle) { showToast('Motorista ou veículo não encontrado', 'error'); return; }

  // Garante o aviso de óleo mesmo que o <select> não tenha disparado 'change'
  // (ex.: o veículo já vinha selecionado por padrão e a pessoa nem tocou nele).
  if (!_assignmentOilBypass) {
    const oilStatus = getOilAlertStatus(vehicleId, parseKmInput('a-km-start'));
    if (oilStatus) {
      showOilWarningModal(oilStatus, () => { _assignmentOilBypass = true; submitAssignment(e); _assignmentOilBypass = false; });
      return;
    }
  }

  const kmEnd       = document.getElementById('a-km-end').value.replace(/\D/g,'');
  const record = {
    id: uid(),
    driverId, driverName: driver.name,
    vehicleId, vehiclePlate: vehicle.plate, vehicleModel: `${vehicle.brand} ${vehicle.model}`,
    date:          document.getElementById('a-date').value,
    returnDate:    document.getElementById('a-return-date').value || null,
    kmStart:       parseKmInput('a-km-start'),
    kmEnd:         kmEnd ? parseFloat(kmEnd) : null,
    obs:           document.getElementById('a-obs').value.trim(),
    createdAt:     new Date().toISOString(),
  };
  // Atualiza o KM oficial do veículo com o maior valor já informado (retirada
  // e/ou devolução) — não espera a devolução para refletir o KM real, senão os
  // alertas de óleo/manutenção (que usam v.km) ficam desatualizados enquanto
  // o veículo está em uso.
  const newKm = Math.max(vehicle.km || 0, record.kmStart || 0, record.kmEnd || 0);
  if (newKm > (vehicle.km || 0)) {
    dbFull.vehicles = dbFull.vehicles.map(v => v.id === vehicleId ? { ...v, km: newKm } : v);
  }
  record.empresaId = currentEmpresaId();
  dbFull.assignments.push(record);
  saveDB(); resetAssignmentForm(); renderAssignmentList();
  showToast('Atribuição registrada!', 'success');
}

function resetAssignmentForm() {
  document.getElementById('assignment-form').reset();
  document.getElementById('a-date').valueAsDate = new Date();
}

function deleteAssignment(id) {
  confirmDialog('Excluir atribuição?', () => {
    dbFull.assignments = dbFull.assignments.filter(a => a.id !== id);
    saveDB(); renderAssignmentList();
    showToast('Atribuição excluída.', 'success');
  });
}

function editAssignment(id) {
  const a = db.assignments.find(a => a.id === id); if (!a) return;
  openModal('Editar Atribuição', `
    <div class="form-grid">
      <div class="field"><label>Motorista</label>
        <select id="ea-driver">${db.drivers.map(d=>`<option value="${d.id}"${d.id===a.driverId?' selected':''}>${d.name}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Veículo</label>
        <select id="ea-vehicle">${db.vehicles.map(v=>`<option value="${v.id}"${v.id===a.vehicleId?' selected':''}>${v.plate} — ${v.brand} ${v.model}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Data Retirada</label><input type="date" id="ea-date" value="${a.date}"></div>
      <div class="field"><label>KM Retirada</label><input type="text" inputmode="numeric" id="ea-km-start" value="${a.kmStart ? a.kmStart.toLocaleString('pt-BR') : ''}" oninput="maskKmInput(this)"></div>
      <div class="field"><label>Data Devolução</label><input type="date" id="ea-return-date" value="${a.returnDate||''}"></div>
      <div class="field"><label>KM Devolução</label><input type="text" inputmode="numeric" id="ea-km-end" value="${a.kmEnd ? a.kmEnd.toLocaleString('pt-BR') : ''}" oninput="maskKmInput(this)"></div>
      <div class="field fw"><label>Destino / Observação</label><input type="text" id="ea-obs" value="${a.obs||''}"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="saveAssignmentEdit('${id}')">Salvar</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
    </div>`);
}

function saveAssignmentEdit(id) {
  const driverId    = document.getElementById('ea-driver').value;
  const vehicleId   = document.getElementById('ea-vehicle').value;
  const driver      = db.drivers.find(d => d.id === driverId);
  const vehicle     = db.vehicles.find(v => v.id === vehicleId);
  const kmEnd       = document.getElementById('ea-km-end').value.replace(/\D/g,'');
  const kmStart     = document.getElementById('ea-km-start').value.replace(/\D/g,'');
  dbFull.assignments = dbFull.assignments.map(a => a.id !== id ? a : {
    ...a,
    driverId, driverName: driver?.name || a.driverName,
    vehicleId, vehiclePlate: vehicle?.plate || a.vehiclePlate,
    vehicleModel: vehicle ? `${vehicle.brand} ${vehicle.model}` : a.vehicleModel,
    date:          document.getElementById('ea-date').value,
    returnDate:    document.getElementById('ea-return-date').value || null,
    kmStart:       parseKmInput('ea-km-start'),
    kmEnd:         kmEnd ? parseFloat(kmEnd) : null,
    obs:           document.getElementById('ea-obs').value,
  });
  if (vehicleId) {
    const newKm = Math.max(vehicle?.km || 0, kmStart ? parseFloat(kmStart) : 0, kmEnd ? parseFloat(kmEnd) : 0);
    if (newKm > (vehicle?.km || 0)) {
      dbFull.vehicles = dbFull.vehicles.map(v => v.id === vehicleId ? { ...v, km: newKm } : v);
    }
  }
  saveDB(); closeModal(); renderAssignmentList();
  showToast('Atribuição atualizada!', 'success');
}

// Modal enxuto de devolução — só pede Data e KM de devolução, sem precisar
// abrir a edição completa da atribuição (motorista/veículo/km retirada etc.)
function returnAssignment(id) {
  const a = db.assignments.find(a => a.id === id); if (!a) return;
  if (a.kmEnd) { showToast('Esta atribuição já foi devolvida.', 'error'); return; }
  openModal('Registrar Devolução', `
    <div class="form-grid">
      <div class="field fw"><label>Veículo</label>
        <input type="text" disabled value="${a.vehiclePlate} — ${a.vehicleModel}">
      </div>
      <div class="field fw"><label>Motorista</label>
        <input type="text" disabled value="${a.driverName}">
      </div>
      <div class="field"><label>Data Devolução</label><input type="date" id="ra-return-date" value="${a.returnDate || new Date().toISOString().substring(0,10)}"></div>
      <div class="field"><label>KM Devolução</label><input type="text" inputmode="numeric" id="ra-km-end" value="${a.kmEnd ? a.kmEnd.toLocaleString('pt-BR') : ''}" oninput="maskKmInput(this)" placeholder="Ex.: ${a.kmStart ? a.kmStart.toLocaleString('pt-BR') : '0'}"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="saveAssignmentReturn('${id}')">Confirmar Devolução</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
    </div>`);
}

function saveAssignmentReturn(id) {
  const a = db.assignments.find(a => a.id === id); if (!a) return;
  const returnDate = document.getElementById('ra-return-date').value;
  const kmEnd       = document.getElementById('ra-km-end').value.replace(/\D/g,'');
  if (!returnDate) { showToast('Informe a data de devolução.', 'error'); return; }
  if (!kmEnd) { showToast('Informe o KM de devolução.', 'error'); return; }
  const kmEndNum = parseFloat(kmEnd);
  if (a.kmStart && kmEndNum < a.kmStart) {
    showToast(`KM de devolução não pode ser menor que o KM de retirada (${a.kmStart.toLocaleString('pt-BR')} km).`, 'error');
    return;
  }
  dbFull.assignments = dbFull.assignments.map(x => x.id !== id ? x : {
    ...x,
    returnDate,
    kmEnd: kmEndNum,
  });
  const vehicleId = a.vehicleId;
  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  const newKm = Math.max(vehicle?.km || 0, kmEndNum);
  if (newKm > (vehicle?.km || 0)) {
    dbFull.vehicles = dbFull.vehicles.map(v => v.id === vehicleId ? { ...v, km: newKm } : v);
  }
  saveDB(); closeModal(); renderAssignmentList();
  showToast('Devolução registrada!', 'success');
}

function renderAssignmentList() {
  const el    = document.getElementById('assignment-list');
  const s     = (document.getElementById('a-search')?.value || '').toLowerCase();
  const sf    = document.getElementById('a-status-filter')?.value || '';
  updateFilterBarState('a', (s ? 1 : 0) + (sf ? 1 : 0));
  let items = [...db.assignments].sort((a,b) => new Date(b.date) - new Date(a.date));
  if (s)  items = items.filter(a => `${a.driverName} ${a.vehiclePlate} ${a.vehicleModel} ${a.obs||''}`.toLowerCase().includes(s));
  if (sf === 'uso') items = items.filter(a => !a.kmEnd);
  if (sf === 'dev') items = items.filter(a =>  a.kmEnd);
  if (!items.length) { el.innerHTML = emptyState('🔑','Nenhuma atribuição encontrada','Registre o uso de veículos acima'); return; }
  el.innerHTML = '<div class="panel"><div class="record-list">' + items.map(a => {
    const kmDone  = a.kmEnd && a.kmStart ? (a.kmEnd - a.kmStart).toLocaleString('pt-BR') + ' km' : '—';
    const status  = a.kmEnd ? '<span class="badge badge-green">DEVOLVIDO</span>' : '<span class="badge badge-red">EM USO</span>';
    return `<div class="record-item">
      <div class="record-stripe stripe-purple"></div>
      <div class="record-body">
        <div class="record-title-row">${status}<span class="record-name">${a.driverName} → ${a.vehiclePlate}</span></div>
        <div class="record-meta">
          <span><strong>Retirada:</strong> ${fmtDate(a.date)}</span>
          <span><strong>Devolução:</strong> ${a.returnDate ? fmtDate(a.returnDate) : '—'}</span>
          <span><strong>KM Inicial:</strong> ${a.kmStart.toLocaleString('pt-BR')} km</span>
          <span><strong>KM Final:</strong> ${a.kmEnd ? a.kmEnd.toLocaleString('pt-BR')+' km' : '—'}</span>
          <span><strong>Percorrido:</strong> ${kmDone}</span>
          <span><strong>Modelo:</strong> ${a.vehicleModel}</span>
          ${a.obs ? `<span style="grid-column:1/-1"><strong>Destino:</strong> ${a.obs}</span>` : ''}
        </div>
      </div>
      <div class="record-actions">
        ${!a.kmEnd ? `<button class="btn btn-success btn-sm" onclick="returnAssignment('${a.id}')">Devolver</button>` : ''}
        <button class="btn btn-edit btn-sm" onclick="editAssignment('${a.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAssignment('${a.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('') + '</div></div>';
}

// ════════════════════════════════════════════════
// FUEL CRUD
// ════════════════════════════════════════════════
function calcPricePerLiter() {
  const liters = parseFloat(document.getElementById('f-liters').value) || 0;
  const cost   = parseCurrencyInput('f-cost');
  document.getElementById('f-price-per-liter').value = liters && cost ? fmtCurrency(cost / liters, 3) : '';
}

function calcConsumption() {
  const vehicleId = document.getElementById('f-vehicle').value;
  const liters    = parseFloat(document.getElementById('f-liters').value);
  const km        = parseKmInput('f-km');
  const input     = document.getElementById('f-consumption');
  const box       = document.getElementById('consumption-box');
  const detail    = document.getElementById('consumption-detail');

  calcPricePerLiter();
  if (!vehicleId || !liters || !km) { input.value = ''; box.style.display = 'none'; return; }

  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  const prevFuels = db.fuel.filter(f => f.vehicleId === vehicleId).sort((a,b) => new Date(b.date) - new Date(a.date));

  if (!prevFuels.length) {
    input.value = '—'; box.style.display = 'none'; return;
  }
  const last = prevFuels[0];
  if (km <= last.km) {
    input.value = '⚠ KM inválida';
    detail.textContent = `KM (${km.toLocaleString('pt-BR')}) menor que último registro (${last.km.toLocaleString('pt-BR')}).`;
    box.style.display = 'block'; return;
  }
  const driven = km - last.km;
  const cons   = driven / liters;
  const rating = cons >= 12 ? '🟢 Excelente' : cons >= 10 ? '🟡 Bom' : cons >= 8 ? '🟠 Regular' : '🔴 Baixo';
  input.value = cons.toFixed(2) + ' km/L';
  detail.innerHTML = `<strong>${rating} — ${cons.toFixed(2)} km/L</strong><br>
    Distância: ${driven.toLocaleString('pt-BR')} km · ${liters.toFixed(2)} L · Último: ${fmtDate(last.date)} (${last.km.toLocaleString('pt-BR')} km)`;
  box.style.display = 'block';
}

function submitFuel(e) {
  e.preventDefault();
  const vehicleId = document.getElementById('f-vehicle').value;
  const driverId  = document.getElementById('f-driver').value;
  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  const driver    = db.drivers.find(d => d.id === driverId);
  if (!vehicle || !driver) { showToast('Veículo ou motorista inválido', 'error'); return; }
  const km = parseKmInput('f-km');
  const record = {
    id: uid(),
    vehicleId, vehiclePlate: vehicle.plate, vehicleModel: `${vehicle.brand} ${vehicle.model}`,
    driverId, driverName: driver.name,
    date:     document.getElementById('f-date').value,
    fuelType: document.getElementById('f-fuel-type').value,
    liters:   parseFloat(document.getElementById('f-liters').value),
    cost:     parseCurrencyInput('f-cost'),
    km,
    station:  document.getElementById('f-station').value.trim(),
    createdAt: new Date().toISOString(),
  };
  dbFull.vehicles = dbFull.vehicles.map(v => v.id === vehicleId ? { ...v, km: Math.max(v.km, km) } : v);
  record.empresaId = currentEmpresaId();
  dbFull.fuel.push(record);
  saveDB(); resetFuelForm(); renderFuelList();
  showToast('Abastecimento registrado!', 'success');
}

function resetFuelForm() {
  document.getElementById('fuel-form').reset();
  document.getElementById('f-date').valueAsDate = new Date();
  document.getElementById('consumption-box').style.display = 'none';
  document.getElementById('f-price-per-liter').value = '';
  document.getElementById('f-consumption').value = '';
}

function deleteFuel(id) {
  confirmDialog('Excluir registro de abastecimento?', () => {
    dbFull.fuel = dbFull.fuel.filter(f => f.id !== id);
    saveDB(); renderFuelList();
    showToast('Registro excluído.', 'success');
  });
}

function editFuel(id) {
  const f = db.fuel.find(f => f.id === id); if (!f) return;
  openModal('Editar Abastecimento', `
    <div class="form-grid">
      <div class="field"><label>Veículo</label>
        <select id="ef-vehicle">${db.vehicles.map(v=>`<option value="${v.id}"${v.id===f.vehicleId?' selected':''}>${v.plate} — ${v.brand} ${v.model}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Motorista</label>
        <select id="ef-driver">${db.drivers.map(d=>`<option value="${d.id}"${d.id===f.driverId?' selected':''}>${d.name}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Data</label><input type="date" id="ef-date" value="${f.date}"></div>
      <div class="field"><label>Combustível</label>
        <select id="ef-fuel-type">${['Gasolina','Etanol','Flex','Diesel','GNV'].map(t=>`<option${t===f.fuelType?' selected':''}>${t}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Litros</label><input type="number" step="0.01" id="ef-liters" value="${f.liters}"></div>
      <div class="field"><label>Custo (R$)</label><input type="text" inputmode="decimal" id="ef-cost" value="${fmtCurrency(f.cost).replace('R$ ','')}" oninput="maskCurrencyInput(this)"></div>
      <div class="field"><label>KM</label><input type="text" inputmode="numeric" id="ef-km" value="${f.km ? f.km.toLocaleString('pt-BR') : ''}" oninput="maskKmInput(this)"></div>
      <div class="field"><label>Posto</label><input type="text" id="ef-station" value="${f.station||''}"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="saveFuelEdit('${id}')">Salvar</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
    </div>`);
}

function saveFuelEdit(id) {
  const vehicleId = document.getElementById('ef-vehicle').value;
  const driverId  = document.getElementById('ef-driver').value;
  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  const driver    = db.drivers.find(d => d.id === driverId);
  dbFull.fuel = dbFull.fuel.map(f => f.id !== id ? f : {
    ...f,
    vehicleId, vehiclePlate: vehicle?.plate || f.vehiclePlate,
    vehicleModel: vehicle ? `${vehicle.brand} ${vehicle.model}` : f.vehicleModel,
    driverId, driverName: driver?.name || f.driverName,
    date:     document.getElementById('ef-date').value,
    fuelType: document.getElementById('ef-fuel-type').value,
    liters:   parseFloat(document.getElementById('ef-liters').value),
    cost:     parseCurrencyInput('ef-cost'),
    km:       parseKmInput('ef-km'),
    station:  document.getElementById('ef-station').value,
  });
  saveDB(); closeModal(); renderFuelList();
  showToast('Abastecimento atualizado!', 'success');
}

function renderFuelList() {
  const el = document.getElementById('fuel-list');
  const s  = (document.getElementById('f-search')?.value || '').toLowerCase();
  const tf = document.getElementById('f-type-filter')?.value || '';
  const fFrom = document.getElementById('f-date-from')?.value || '', fTo = document.getElementById('f-date-to')?.value || '';
  updateFilterBarState('f', (s?1:0) + (tf?1:0) + (fFrom?1:0) + (fTo?1:0));
  let items = filterByDate([...db.fuel].sort((a,b)=>new Date(b.date)-new Date(a.date)), 'date', 'f-date-from', 'f-date-to');
  if (s)  items = items.filter(f => `${f.vehiclePlate} ${f.vehicleModel} ${f.driverName} ${f.station||''}`.toLowerCase().includes(s));
  if (tf) items = items.filter(f => f.fuelType === tf);
  if (!items.length) { el.innerHTML = emptyState('⛽','Nenhum abastecimento encontrado','Registre o primeiro abastecimento acima'); return; }

  // Consumption per vehicle
  const sortedAll = [...db.fuel].sort((a,b)=>a.km-b.km);
  const consMap = {};
  sortedAll.forEach(f => {
    const prev = consMap[f.vehicleId];
    if (prev && f.km > prev.km) f._cons = ((f.km - prev.km) / f.liters).toFixed(2);
    consMap[f.vehicleId] = f;
  });

  el.innerHTML = '<div class="panel"><div class="record-list">' + items.map(f => {
    const priceL = f.liters ? fmtCurrency(f.cost / f.liters, 3) : '—';
    const consHtml = f._cons
      ? `<span><strong>Consumo:</strong> ${parseFloat(f._cons)>=12?'🟢':parseFloat(f._cons)>=10?'🟡':parseFloat(f._cons)>=8?'🟠':'🔴'} ${f._cons} km/L</span>` : '';
    return `<div class="record-item">
      <div class="record-stripe stripe-cyan"></div>
      <div class="record-body">
        <div class="record-title-row"><span class="badge badge-cyan">ABASTECIMENTO</span><span class="record-name">${f.vehiclePlate} — ${f.vehicleModel}</span></div>
        <div class="record-meta">
          <span><strong>Data:</strong> ${fmtDate(f.date)}</span>
          <span><strong>Motorista:</strong> ${f.driverName}</span>
          <span><strong>Combustível:</strong> ${f.fuelType || '—'}</span>
          <span><strong>Litros:</strong> ${f.liters.toFixed(2)} L</span>
          <span><strong>Custo:</strong> ${fmtCurrency(f.cost)}</span>
          <span><strong>Preço/L:</strong> ${priceL}</span>
          <span><strong>KM:</strong> ${f.km.toLocaleString('pt-BR')} km</span>
          ${f.station ? `<span><strong>Posto:</strong> ${f.station}</span>` : ''}
          ${consHtml}
        </div>
      </div>
      <div class="record-actions">
        <button class="btn btn-edit btn-sm" onclick="editFuel('${f.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteFuel('${f.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('') + '</div></div>';
}

// ════════════════════════════════════════════════
// MAINTENANCE CRUD
// ════════════════════════════════════════════════
function switchMaintTab(tab, btn) {
  document.querySelectorAll('#maint-tab-nav .tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#maintenance-page .tab-content').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const content = document.getElementById('maint-tab-content-' + tab);
  if (content) content.classList.add('active');
  if (tab === 'scheduled') renderScheduledMaintenanceList();
  if (tab === 'history')   renderMaintenanceList();
}

function updateMaintTabCount() {
  const el = document.getElementById('maint-tab-count-scheduled');
  if (!el) return;
  const pending = (db.scheduledMaintenance || []).filter(s => s.status !== 'concluida').length;
  el.textContent = pending ? pending : '';
}

function submitMaintenance(e) {
  e.preventDefault();
  const vehicleId = document.getElementById('m-vehicle').value;
  const driverId  = document.getElementById('m-driver').value;
  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  const driver    = db.drivers.find(d => d.id === driverId);
  if (!vehicle || !driver) { showToast('Veículo ou responsável inválido', 'error'); return; }
  const km = parseKmInput('m-km');
  const record = {
    id: uid(),
    vehicleId, vehiclePlate: vehicle.plate, vehicleModel: `${vehicle.brand} ${vehicle.model}`,
    driverId, driverName: driver.name,
    date:        document.getElementById('m-date').value,
    km, cost:    parseCurrencyInput('m-cost'),
    type:        document.getElementById('m-type').value,
    workshop:    document.getElementById('m-workshop').value.trim(),
    nextKm:      parseKmInput('m-next-km'),
    description: document.getElementById('m-desc').value.trim(),
    createdAt:   new Date().toISOString(),
  };
  dbFull.vehicles = dbFull.vehicles.map(v => v.id === vehicleId ? { ...v, lastMaint: record.date, km: Math.max(v.km, km) } : v);
  record.empresaId = currentEmpresaId();
  dbFull.maintenance.push(record);
  if (_completingScheduleId) {
    dbFull.scheduledMaintenance = dbFull.scheduledMaintenance.map(s => s.id === _completingScheduleId
      ? { ...s, status:'concluida', completedAt: new Date().toISOString(), maintenanceId: record.id } : s);
    _completingScheduleId = null;
  }
  // Se foi informada uma "Próxima Revisão (KM)", cria automaticamente o agendamento
  // correspondente em "Programadas" — é de lá (e só de lá) que nascem os alertas de
  // manutenção próxima/vencida, nunca de um registro já concluído.
  if (record.nextKm > 0) {
    dbFull.scheduledMaintenance.push({
      id: uid(),
      vehicleId, vehiclePlate: vehicle.plate,
      type: record.type,
      description: `Revisão seguinte (após: ${record.description})`,
      dueDate: null, dueKm: record.nextKm,
      priority: 'media',
      notes: `Gerado automaticamente a partir da manutenção de ${fmtDate(record.date)}.`,
      status: 'pendente',
      linkedMaintenanceId: record.id,
      empresaId: currentEmpresaId(),
      createdAt: new Date().toISOString(),
    });
  }
  saveDB(); resetMaintenanceForm(); renderMaintenanceList(); renderScheduledMaintenanceList();
  showToast('Manutenção registrada!', 'success');
}

function resetMaintenanceForm() {
  document.getElementById('maintenance-form').reset();
  document.getElementById('m-date').valueAsDate = new Date();
}

function deleteMaintenance(id) {
  confirmDialog('Excluir manutenção?', () => {
    dbFull.maintenance = dbFull.maintenance.filter(m => m.id !== id);
    saveDB(); renderMaintenanceList();
    showToast('Manutenção excluída.', 'success');
  });
}

function editMaintenance(id) {
  const m = db.maintenance.find(m => m.id === id); if (!m) return;
  const types = ['Preventiva','Corretiva','Revisão','Pneus','Freios','Suspensão','Elétrica','Funilaria','Outro'];
  openModal('Editar Manutenção', `
    <div class="form-grid">
      <div class="field"><label>Veículo</label>
        <select id="em-vehicle">${db.vehicles.map(v=>`<option value="${v.id}"${v.id===m.vehicleId?' selected':''}>${v.plate} — ${v.brand} ${v.model}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Responsável</label>
        <select id="em-driver">${db.drivers.map(d=>`<option value="${d.id}"${d.id===m.driverId?' selected':''}>${d.name}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Data</label><input type="date" id="em-date" value="${m.date}"></div>
      <div class="field"><label>KM</label><input type="text" inputmode="numeric" id="em-km" value="${m.km ? m.km.toLocaleString('pt-BR') : ''}" oninput="maskKmInput(this)"></div>
      <div class="field"><label>Custo (R$)</label><input type="text" inputmode="decimal" id="em-cost" value="${fmtCurrency(m.cost).replace('R$ ','')}" oninput="maskCurrencyInput(this)"></div>
      <div class="field"><label>Tipo</label><select id="em-type">${types.map(t=>`<option${t===m.type?' selected':''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label>Oficina</label><input type="text" id="em-workshop" value="${m.workshop||''}"></div>
      <div class="field"><label>Próxima KM</label><input type="text" inputmode="numeric" id="em-next-km" value="${m.nextKm ? m.nextKm.toLocaleString('pt-BR') : ''}" oninput="maskKmInput(this)"></div>
      <div class="field fw"><label>Descrição</label><textarea id="em-desc">${m.description}</textarea></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="saveMaintenanceEdit('${id}')">Salvar</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
    </div>`);
}

function saveMaintenanceEdit(id) {
  const vehicleId = document.getElementById('em-vehicle').value;
  const driverId  = document.getElementById('em-driver').value;
  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  const driver    = db.drivers.find(d => d.id === driverId);
  dbFull.maintenance = dbFull.maintenance.map(m => m.id !== id ? m : {
    ...m,
    vehicleId, vehiclePlate: vehicle?.plate || m.vehiclePlate,
    vehicleModel: vehicle ? `${vehicle.brand} ${vehicle.model}` : m.vehicleModel,
    driverId, driverName: driver?.name || m.driverName,
    date:        document.getElementById('em-date').value,
    km:          parseKmInput('em-km'),
    cost:        parseCurrencyInput('em-cost'),
    type:        document.getElementById('em-type').value,
    workshop:    document.getElementById('em-workshop').value,
    nextKm:      parseKmInput('em-next-km'),
    description: document.getElementById('em-desc').value,
  });
  saveDB(); closeModal(); renderMaintenanceList();
  showToast('Manutenção atualizada!', 'success');
}

function renderMaintenanceList() {
  const el = document.getElementById('maintenance-list');
  const s  = (document.getElementById('m-search')?.value || '').toLowerCase();
  const tf = document.getElementById('m-type-filter')?.value || '';
  const mFrom = document.getElementById('m-date-from')?.value || '', mTo = document.getElementById('m-date-to')?.value || '';
  updateFilterBarState('m', (s?1:0) + (tf?1:0) + (mFrom?1:0) + (mTo?1:0));
  let items = filterByDate([...db.maintenance].sort((a,b)=>new Date(b.date)-new Date(a.date)), 'date', 'm-date-from', 'm-date-to');
  if (s)  items = items.filter(m => `${m.vehiclePlate} ${m.vehicleModel} ${m.description} ${m.type}`.toLowerCase().includes(s));
  if (tf) items = items.filter(m => m.type === tf);
  if (!items.length) { el.innerHTML = emptyState('🔧','Nenhuma manutenção encontrada','Registre a primeira manutenção acima'); return; }
  el.innerHTML = '<div class="panel"><div class="record-list">' + items.map(m => `
    <div class="record-item">
      <div class="record-stripe stripe-yellow"></div>
      <div class="record-body">
        <div class="record-title-row">
          <span class="badge badge-yellow">MANUTENÇÃO</span>
          <span class="badge badge-blue">${m.type}</span>
          <span class="record-name">${m.vehiclePlate} — ${m.vehicleModel}</span>
        </div>
        <div class="record-meta">
          <span><strong>Data:</strong> ${fmtDate(m.date)}</span>
          <span><strong>Responsável:</strong> ${m.driverName}</span>
          <span><strong>KM:</strong> ${m.km.toLocaleString('pt-BR')} km</span>
          <span><strong>Custo:</strong> ${fmtCurrency(m.cost)}</span>
          ${m.workshop ? `<span><strong>Oficina:</strong> ${m.workshop}</span>` : ''}
          ${m.nextKm   ? `<span><strong>Próxima KM:</strong> ${m.nextKm.toLocaleString('pt-BR')} km</span>` : ''}
          <span style="grid-column:1/-1"><strong>Descrição:</strong> ${m.description}</span>
        </div>
      </div>
      <div class="record-actions">
        <button class="btn btn-edit btn-sm" onclick="editMaintenance('${m.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteMaintenance('${m.id}')">Excluir</button>
      </div>
    </div>`).join('') + '</div></div>';
}

// ════════════════════════════════════════════════
// PROGRAMAR MANUTENÇÃO (agendamento futuro, antes de o serviço ser realizado)
// ════════════════════════════════════════════════
// Controla o guardado da manutenção-programada que está sendo concluída (para vincular
// o registro efetivo criado em "Registrar Manutenção" ao agendamento de origem).
let _completingScheduleId = null;

function resetScheduleMaintenanceForm() {
  const form = document.getElementById('schedule-maintenance-form');
  if (form) form.reset();
  delete document.getElementById('sm-submit-btn').dataset.editId;
  document.getElementById('sm-submit-btn').textContent = 'Programar Manutenção';
}

function submitScheduledMaintenance(e) {
  e.preventDefault();
  const vehicleId = document.getElementById('sm-vehicle').value;
  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  if (!vehicle) { showToast('Selecione um veículo', 'error'); return; }
  const dueDate = document.getElementById('sm-due-date').value;
  const dueKm   = parseKmInput('sm-due-km');
  if (!dueDate && !dueKm) { showToast('Informe uma data prevista ou um KM previsto.', 'error'); return; }
  const editId = document.getElementById('sm-submit-btn').dataset.editId;
  const record = {
    id: editId || uid(),
    vehicleId, vehiclePlate: vehicle.plate,
    type:        document.getElementById('sm-type').value,
    description: document.getElementById('sm-desc').value.trim(),
    dueDate, dueKm,
    priority:    document.getElementById('sm-priority').value,
    notes:       document.getElementById('sm-notes').value.trim(),
    status: 'pendente',
    empresaId: currentEmpresaId(),
    createdAt: new Date().toISOString(),
  };
  if (editId) {
    dbFull.scheduledMaintenance = dbFull.scheduledMaintenance.map(s => s.id === editId ? { ...s, ...record, status: s.status } : s);
    showToast('Manutenção programada atualizada!', 'success');
  } else {
    dbFull.scheduledMaintenance.push(record);
    showToast('Manutenção programada com sucesso!', 'success');
  }
  saveDB(); resetScheduleMaintenanceForm(); renderScheduledMaintenanceList();
}

function editScheduledMaintenance(id) {
  const s = db.scheduledMaintenance.find(s => s.id === id); if (!s) return;
  document.getElementById('sm-vehicle').value  = s.vehicleId;
  document.getElementById('sm-type').value     = s.type || 'Preventiva';
  document.getElementById('sm-desc').value     = s.description || '';
  document.getElementById('sm-due-date').value = s.dueDate || '';
  setKmInput('sm-due-km', s.dueKm || 0);
  document.getElementById('sm-priority').value = s.priority || 'media';
  document.getElementById('sm-notes').value    = s.notes || '';
  const btn = document.getElementById('sm-submit-btn');
  btn.dataset.editId = id;
  btn.textContent = 'Salvar Alteração';
  document.getElementById('schedule-maintenance-form').scrollIntoView({ behavior:'smooth', block:'center' });
}

function deleteScheduledMaintenance(id) {
  confirmDialog('Excluir esta manutenção programada?', () => {
    dbFull.scheduledMaintenance = dbFull.scheduledMaintenance.filter(s => s.id !== id);
    saveDB(); renderScheduledMaintenanceList();
    showToast('Manutenção programada excluída.', 'success');
  });
}

// Leva o usuário até o formulário "Registrar Manutenção" já preenchido com os dados do
// agendamento. Ao salvar o registro real (submitMaintenance), o agendamento é marcado como concluído.
function completeScheduledMaintenance(id) {
  const s = db.scheduledMaintenance.find(s => s.id === id); if (!s) return;
  document.getElementById('m-vehicle').value = s.vehicleId;
  if (s.type) document.getElementById('m-type').value = s.type;
  document.getElementById('m-desc').value = s.description || '';
  const vehicle = db.vehicles.find(v => v.id === s.vehicleId);
  if (vehicle) setKmInput('m-km', vehicle.km);
  document.getElementById('m-date').valueAsDate = new Date();
  _completingScheduleId = id;
  showToast('Preencha o custo e confirme para concluir a manutenção programada.', 'success');
  document.getElementById('maintenance-form').scrollIntoView({ behavior:'smooth', block:'start' });
}

function _daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr+'T00:00:00') - new Date()) / 86400000);
}

function renderScheduledMaintenanceList() {
  const el = document.getElementById('scheduled-maintenance-list');
  updateMaintTabCount();
  if (!el) return;
  const items = [...(db.scheduledMaintenance || [])].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pendente' ? -1 : 1;
    return (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
  });
  if (!items.length) {
    el.innerHTML = emptyState('🗓️', 'Nenhuma manutenção programada', 'Programe revisões e serviços futuros para não perder o prazo');
    return;
  }
  const priorityLabel = { alta:'Alta', media:'Média', baixa:'Baixa' };
  el.innerHTML = '<div class="panel"><div class="record-list">' + items.map(s => {
    const vehicle  = db.vehicles.find(v => v.id === s.vehicleId);
    const daysLeft = _daysUntil(s.dueDate);
    const kmLeft   = (s.dueKm && vehicle) ? s.dueKm - vehicle.km : null;
    const overdue  = s.status === 'pendente' && ((daysLeft !== null && daysLeft < 0) || (kmLeft !== null && kmLeft <= 0));
    const stripe   = s.status === 'concluida' ? 'stripe-green' : overdue ? 'stripe-red' : 'stripe-yellow';
    return `<div class="record-item">
      <div class="record-stripe ${stripe}"></div>
      <div class="record-body">
        <div class="record-title-row">
          <span class="badge ${s.status === 'concluida' ? 'badge-green' : overdue ? 'badge-red' : 'badge-yellow'}">${s.status === 'concluida' ? 'CONCLUÍDA' : overdue ? 'ATRASADA' : 'PROGRAMADA'}</span>
          ${s.type ? `<span class="badge badge-blue">${s.type}</span>` : ''}
          <span class="badge">${priorityLabel[s.priority] || 'Média'}</span>
          <span class="record-name">${s.vehiclePlate}${vehicle ? ` — ${vehicle.brand} ${vehicle.model}` : ''}</span>
        </div>
        <div class="record-meta">
          ${s.description ? `<span style="grid-column:1/-1"><strong>Serviço:</strong> ${s.description}</span>` : ''}
          ${s.dueDate ? `<span><strong>Data prevista:</strong> ${fmtDate(s.dueDate)}${s.status==='pendente' && daysLeft!==null ? (daysLeft<0 ? ` (atrasada ${Math.abs(daysLeft)}d)` : ` (em ${daysLeft}d)`) : ''}</span>` : ''}
          ${s.dueKm ? `<span><strong>KM previsto:</strong> ${s.dueKm.toLocaleString('pt-BR')} km${s.status==='pendente' && kmLeft!==null ? (kmLeft<=0 ? ` (${Math.abs(kmLeft).toLocaleString('pt-BR')} km acima)` : ` (faltam ${kmLeft.toLocaleString('pt-BR')} km)`) : ''}</span>` : ''}
          ${s.notes ? `<span style="grid-column:1/-1"><strong>Obs:</strong> ${s.notes}</span>` : ''}
        </div>
      </div>
      <div class="record-actions">
        ${s.status === 'pendente' ? `<button class="btn btn-primary btn-sm" onclick="completeScheduledMaintenance('${s.id}')">Concluir</button>
        <button class="btn btn-edit btn-sm" onclick="editScheduledMaintenance('${s.id}')">Editar</button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteScheduledMaintenance('${s.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('') + '</div></div>';
}

// ════════════════════════════════════════════════
// OIL CRUD
// ════════════════════════════════════════════════
function updateNextOilKm() {
  const km       = parseKmInput('o-km');
  const interval = parseFloat(document.getElementById('o-interval').value) || 5000;
  document.getElementById('o-next-km').value = km && interval ? (km + interval).toLocaleString('pt-BR') + ' km' : '';

  const dateStr        = document.getElementById('o-date').value;
  const intervalMonths = parseFloat(document.getElementById('o-interval-months').value) || 6;
  const nextDateEl      = document.getElementById('o-next-date');
  if (dateStr) {
    const nd = new Date(dateStr + 'T00:00:00');
    nd.setMonth(nd.getMonth() + intervalMonths);
    nextDateEl.value = nd.toLocaleDateString('pt-BR');
  } else {
    nextDateEl.value = '';
  }
}

function submitOil(e) {
  e.preventDefault();
  const vehicleId = document.getElementById('o-vehicle').value;
  const driverId  = document.getElementById('o-driver').value;
  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  const driver    = db.drivers.find(d => d.id === driverId);
  if (!vehicle || !driver) { showToast('Veículo ou responsável inválido', 'error'); return; }
  const km       = parseKmInput('o-km');
  const interval = parseFloat(document.getElementById('o-interval').value) || 5000;
  const date     = document.getElementById('o-date').value;
  const intervalMonths = parseFloat(document.getElementById('o-interval-months').value) || 6;
  const record = {
    id: uid(),
    vehicleId, vehiclePlate: vehicle.plate, vehicleModel: `${vehicle.brand} ${vehicle.model}`,
    driverId, driverName: driver.name,
    date,
    km, cost:  parseCurrencyInput('o-cost'),
    oilType:   document.getElementById('o-oil-type').value,
    viscosity: document.getElementById('o-viscosity').value.trim(),
    brand:     document.getElementById('o-brand').value.trim(),
    interval, nextKm: km + interval,
    intervalMonths, nextDate: addMonths(date, intervalMonths),
    obs:       document.getElementById('o-obs').value.trim(),
    createdAt: new Date().toISOString(),
  };
  dbFull.vehicles = dbFull.vehicles.map(v => v.id === vehicleId ? { ...v, lastOil: record.date, oilKm: km, km: Math.max(v.km, km) } : v);
  record.empresaId = currentEmpresaId();
  dbFull.oil.push(record);
  saveDB(); resetOilForm(); renderOilList();
  showToast('Troca de óleo registrada!', 'success');
}

function resetOilForm() {
  document.getElementById('oil-form').reset();
  document.getElementById('o-date').valueAsDate = new Date();
  document.getElementById('o-interval').value   = '5000';
  document.getElementById('o-next-km').value    = '';
  document.getElementById('o-interval-months').value = '6';
  document.getElementById('o-next-date').value  = '';
}

// Soma meses a uma data 'YYYY-MM-DD' e devolve no mesmo formato
function addMonths(dateStr, months) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + (months || 0));
  return d.toISOString().substring(0, 10);
}

// ── VERIFICAÇÃO DE ÓLEO (usada tanto ao trocar o veículo no <select> quanto,
// de forma garantida, no momento de salvar a atribuição) ──────────────────
// Retorna null se o óleo está em dia, ou um objeto com os detalhes do alerta.
// Retorna o registro de troca de óleo mais recente do veículo. Desempata por
// data de CRIAÇÃO (createdAt) quando duas trocas caem no mesmo dia — sem isso,
// um registro antigo (ex.: gerado automaticamente no cadastro do veículo)
// pode continuar sendo tratado como "o mais recente" só porque a troca de
// verdade, feita depois, foi registrada com a mesma data (empate na ordenação).
function getLastOilRecord(vehicleId) {
  return [...db.oil]
    .filter(o => o.vehicleId === vehicleId)
    .sort((a, b) => {
      const dateDiff = new Date(b.date) - new Date(a.date);
      if (dateDiff !== 0) return dateDiff;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    })[0];
}

function getOilAlertStatus(vehicleId, kmOverride) {
  if (!vehicleId) return null;
  const v = db.vehicles.find(x => x.id === vehicleId);
  if (!v) return null;

  const lastOil = getLastOilRecord(vehicleId);
  if (!lastOil) return null; // nunca teve troca registrada, nada a checar

  // Usa o maior entre o KM cadastrado no veículo e o KM sendo digitado agora
  // (ex.: KM de retirada de uma atribuição) — o cadastro do veículo só é
  // atualizado na devolução, então sem isso o aviso ficaria sempre atrasado.
  const effectiveKm = Math.max(v.km || 0, kmOverride || 0);

  // Limites fixos de antecedência para considerar a troca "próxima do vencimento".
  const kmBefore   = 500;
  const daysBefore = 7;

  const kmRemaining = (lastOil.nextKm || 0) - effectiveKm;
  let daysRemaining = null;
  if (lastOil.nextDate) {
    daysRemaining = Math.ceil((new Date(lastOil.nextDate + 'T00:00:00') - new Date()) / 86400000);
  }

  const overdue    = kmRemaining <= 0 || (daysRemaining !== null && daysRemaining <= 0);
  const nearByKm   = !overdue && kmRemaining <= kmBefore;
  const nearByDate = !overdue && daysRemaining !== null && daysRemaining <= daysBefore;
  if (!overdue && !nearByKm && !nearByDate) return null; // óleo em dia

  let statusText;
  if (overdue) {
    statusText = 'está <strong style="color:var(--danger,#DC2626)">VENCIDA</strong>';
  } else if (nearByKm && nearByDate) {
    statusText = `está próxima — faltam ${Math.max(0,Math.round(kmRemaining)).toLocaleString('pt-BR')} km ou ${daysRemaining} dia(s)`;
  } else if (nearByKm) {
    statusText = `está próxima — faltam ${Math.max(0,Math.round(kmRemaining)).toLocaleString('pt-BR')} km`;
  } else {
    statusText = `está próxima — faltam ${daysRemaining} dia(s)`;
  }

  return { vehicle: v, overdue, statusText };
}

// Mostra o pop-up de alerta. Se `onContinue` for informado, o botão vira
// "Continuar e Registrar" e SÓ EXECUTA a ação depois que a pessoa confirmar
// — ou seja, a atribuição fica bloqueada até essa decisão consciente.
function showOilWarningModal(status, onContinue) {
  const { vehicle: v, statusText } = status;
  const continueLabel = onContinue ? 'Continuar e Registrar' : 'Continuar mesmo assim';
  window._oilWarningContinue = onContinue || null;
  openModal('⚠ Atenção — Troca de Óleo', `
    <div style="padding:4px 0;line-height:1.6;">
      <p>O veículo <strong>${v.plate}</strong> (${v.brand} ${v.model}) ${statusText} da troca de óleo.</p>
      <p style="font-size:0.85rem;color:var(--text-secondary);margin-top:10px;">
        Recomendamos agendar a manutenção antes de liberar o veículo para uso.
      </p>
      <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap;">
        <button type="button" class="btn btn-ghost" onclick="(window._oilWarningContinue ? window._oilWarningContinue() : null); closeModal(); window._oilWarningContinue = null;">${continueLabel}</button>
      </div>
    </div>
  `);
}

// Chamada pelo campo "KM na Retirada" (Atribuições) ao sair do campo (blur) —
// pega o veículo já selecionado e o KM que acabou de ser digitado.
function checkOilOnKmStartInput() {
  const vehicleId = document.getElementById('a-vehicle')?.value;
  const km = parseKmInput('a-km-start');
  if (!vehicleId || !km) return;
  const status = getOilAlertStatus(vehicleId, km);
  if (status) showOilWarningModal(status, null);
}

// Chamada pelo <select> de veículo (Atribuições) — aviso "cedo", ao trocar a
// seleção. Não bloqueia nada, é só um alerta informativo antecipado.
function checkAndAlertOilStatus(vehicleId) {
  const status = getOilAlertStatus(vehicleId, parseKmInput('a-km-start'));
  if (status) showOilWarningModal(status, null);
}

// ── CAPITALIZAÇÃO DE NOMES (padrão ABNT: cada palavra com inicial maiúscula,
// exceto conectivos, que ficam em minúsculo salvo quando são a 1ª palavra) ──
const NAME_CONNECTORS = new Set(['de','da','do','das','dos','e']);
function toTitleCasePT(str) {
  if (!str) return str;
  return str
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .split(' ')
    .map((word, i) => {
      if (i > 0 && NAME_CONNECTORS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}
function applyNameCasing(el) { el.value = toTitleCasePT(el.value); }

function deleteOil(id) {
  if (!confirm('Excluir registro de troca de óleo?')) return;
  dbFull.oil = dbFull.oil.filter(o => o.id !== id);
  saveDB(); renderOilList();
  showToast('Registro excluído.', 'success');
}

function editOil(id) {
  const o = db.oil.find(o => o.id === id); if (!o) return;
  const types = ['Mineral','Semissintético','Sintético'];
  openModal('Editar Troca de Óleo', `
    <div class="form-grid">
      <div class="field"><label>Veículo</label>
        <select id="eo-vehicle">${db.vehicles.map(v=>`<option value="${v.id}"${v.id===o.vehicleId?' selected':''}>${v.plate} — ${v.brand} ${v.model}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Responsável</label>
        <select id="eo-driver">${db.drivers.map(d=>`<option value="${d.id}"${d.id===o.driverId?' selected':''}>${d.name}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Data</label><input type="date" id="eo-date" value="${o.date}" oninput="updateNextOilKmEdit()"></div>
      <div class="field"><label>KM</label><input type="text" inputmode="numeric" id="eo-km" value="${o.km ? o.km.toLocaleString('pt-BR') : ''}" oninput="maskKmInput(this);updateNextOilKmEdit()"></div>
      <div class="field"><label>Custo (R$)</label><input type="text" inputmode="decimal" id="eo-cost" value="${fmtCurrency(o.cost).replace('R$ ','')}" oninput="maskCurrencyInput(this)"></div>
      <div class="field"><label>Tipo de Óleo</label><select id="eo-type">${types.map(t=>`<option${t===o.oilType?' selected':''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label>Viscosidade</label><input type="text" id="eo-viscosity" value="${o.viscosity||''}"></div>
      <div class="field"><label>Marca do Óleo</label><input type="text" id="eo-brand" value="${o.brand||''}"></div>
      <div class="field"><label>Intervalo (km)</label><input type="number" id="eo-interval" value="${o.interval}" oninput="updateNextOilKmEdit()"></div>
      <div class="field"><label>Intervalo (meses)</label><input type="number" id="eo-interval-months" value="${o.intervalMonths || 6}" oninput="updateNextOilKmEdit()"></div>
      <div class="field"><label>Próxima Troca (km)</label><input type="text" id="eo-next-km" readonly disabled></div>
      <div class="field"><label>Próxima Troca (data)</label><input type="text" id="eo-next-date" readonly disabled></div>
      <div class="field fw"><label>Observações</label><textarea id="eo-obs">${o.obs||''}</textarea></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="saveOilEdit('${id}')">Salvar</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
    </div>`);
  updateNextOilKmEdit();
}

function updateNextOilKmEdit() {
  const km       = parseKmInput('eo-km');
  const interval = parseFloat(document.getElementById('eo-interval').value) || 5000;
  document.getElementById('eo-next-km').value = km && interval ? (km + interval).toLocaleString('pt-BR') + ' km' : '';

  const dateStr        = document.getElementById('eo-date').value;
  const intervalMonths = parseFloat(document.getElementById('eo-interval-months').value) || 6;
  const nextDateEl     = document.getElementById('eo-next-date');
  if (dateStr) {
    const nd = new Date(dateStr + 'T00:00:00');
    nd.setMonth(nd.getMonth() + intervalMonths);
    nextDateEl.value = nd.toLocaleDateString('pt-BR');
  } else {
    nextDateEl.value = '';
  }
}

function saveOilEdit(id) {
  const vehicleId = document.getElementById('eo-vehicle').value;
  const driverId  = document.getElementById('eo-driver').value;
  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  const driver    = db.drivers.find(d => d.id === driverId);
  const km        = parseKmInput('eo-km');
  const interval  = parseFloat(document.getElementById('eo-interval').value) || 5000;
  const date      = document.getElementById('eo-date').value;
  const intervalMonths = parseFloat(document.getElementById('eo-interval-months').value) || 6;
  dbFull.oil = dbFull.oil.map(o => o.id !== id ? o : {
    ...o,
    vehicleId, vehiclePlate: vehicle?.plate || o.vehiclePlate,
    vehicleModel: vehicle ? `${vehicle.brand} ${vehicle.model}` : o.vehicleModel,
    driverId, driverName: driver?.name || o.driverName,
    date,
    km, cost:  parseCurrencyInput('eo-cost'),
    oilType:   document.getElementById('eo-type').value,
    viscosity: document.getElementById('eo-viscosity').value,
    brand:     document.getElementById('eo-brand').value,
    interval, nextKm: km + interval,
    intervalMonths, nextDate: addMonths(date, intervalMonths),
    obs:       document.getElementById('eo-obs').value,
  });
  saveDB(); closeModal(); renderOilList();
  showToast('Troca de óleo atualizada!', 'success');
}

function renderOilList() {
  const el = document.getElementById('oil-list');
  const s  = (document.getElementById('o-search')?.value || '').toLowerCase();
  const oFrom = document.getElementById('o-date-from')?.value || '', oTo = document.getElementById('o-date-to')?.value || '';
  updateFilterBarState('o', (s?1:0) + (oFrom?1:0) + (oTo?1:0));
  let items = filterByDate([...db.oil].sort((a,b)=>new Date(b.date)-new Date(a.date)), 'date', 'o-date-from', 'o-date-to');
  if (s) items = items.filter(o => `${o.vehiclePlate} ${o.vehicleModel} ${o.driverName} ${o.oilType}`.toLowerCase().includes(s));
  if (!items.length) { el.innerHTML = emptyState('🛢️','Nenhuma troca de óleo encontrada','Registre a primeira troca acima'); return; }
  el.innerHTML = '<div class="panel"><div class="record-list">' + items.map(o => {
    const v = db.vehicles.find(v => v.id === o.vehicleId);
    const remaining = v ? o.nextKm - v.km : null;
    const alertHtml = remaining !== null && remaining <= (o.interval || 5000) * 0.2
      ? `<span class="badge badge-orange">⚠ Próxima: ${Math.max(0,remaining).toLocaleString('pt-BR')} km</span>` : '';
    return `<div class="record-item">
      <div class="record-stripe stripe-orange"></div>
      <div class="record-body">
        <div class="record-title-row">
          <span class="badge badge-orange">TROCA DE ÓLEO</span>${alertHtml}
          <span class="record-name">${o.vehiclePlate} — ${o.vehicleModel}</span>
        </div>
        <div class="record-meta">
          <span><strong>Data:</strong> ${fmtDate(o.date)}</span>
          <span><strong>Responsável:</strong> ${o.driverName}</span>
          <span><strong>Tipo:</strong> ${o.oilType}${o.viscosity?' ('+o.viscosity+')':''}</span>
          ${o.brand?`<span><strong>Marca:</strong> ${o.brand}</span>`:''}
          <span><strong>KM:</strong> ${o.km.toLocaleString('pt-BR')} km</span>
          <span><strong>Custo:</strong> ${fmtCurrency(o.cost)}</span>
          <span><strong>Próxima Troca:</strong> ${o.nextKm.toLocaleString('pt-BR')} km</span>
          <span><strong>Intervalo:</strong> ${o.interval.toLocaleString('pt-BR')} km</span>
          ${o.obs?`<span style="grid-column:1/-1"><strong>Obs:</strong> ${o.obs}</span>`:''}
        </div>
      </div>
      <div class="record-actions">
        <button class="btn btn-edit btn-sm" onclick="editOil('${o.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteOil('${o.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('') + '</div></div>';
}

// ════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════

let _dashPeriod = 'month';
let _costChartMode = 'monthly';
let _fuelChartMode = 'monthly';
let _dashCustomFrom = null;
let _dashCustomTo = null;

// ── Painéis do Dashboard (recolher/expandir removido) ──
// Limpa qualquer estado "recolhido" salvo de versões anteriores, para que
// nenhum painel fique escondido sem o botão que permitia reabri-lo.
(function _clearLegacyDashCollapseState() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith('dash_collapsed_'))
      .forEach(k => localStorage.removeItem(k));
  } catch(_) {}
})();

function setDashPeriod(period, btn) {
  _dashPeriod = period;
  document.querySelectorAll('.dpt-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const customRow = document.getElementById('dash-custom-period-row');
  if (period === 'custom') {
    if (customRow) customRow.style.display = 'flex';
    // Se já havia datas escolhidas antes, mantém; senão sugere o mês atual como ponto de partida
    if (!_dashCustomFrom && !_dashCustomTo) {
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      document.getElementById('dash-custom-from').valueAsDate = from;
      document.getElementById('dash-custom-to').valueAsDate = now;
      _dashCustomFrom = toISODate(from);
      _dashCustomTo = toISODate(now);
    }
  } else {
    if (customRow) customRow.style.display = 'none';
  }
  renderDashboard();
}

function applyDashCustomPeriod() {
  const from = document.getElementById('dash-custom-from').value;
  const to = document.getElementById('dash-custom-to').value;
  if (!from && !to) { showToast('Selecione ao menos uma data.', 'error'); return; }
  if (from && to && from > to) { showToast('A data "De" não pode ser depois da data "Até".', 'error'); return; }
  _dashCustomFrom = from || null;
  _dashCustomTo = to || null;
  _dashPeriod = 'custom';
  document.querySelectorAll('.dpt-btn').forEach(b => b.classList.remove('active'));
  const customBtn = document.querySelector('.dpt-btn[data-period="custom"]');
  if (customBtn) customBtn.classList.add('active');
  renderDashboard();
}

function switchCostChart(mode, btn) {
  _costChartMode = mode;
  const group = btn ? btn.closest('.chart-tab-group') : null;
  (group ? group.querySelectorAll('.chart-tab') : document.querySelectorAll('.chart-tab')).forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderDashboard();
}

function switchFuelChart(mode, btn) {
  _fuelChartMode = mode;
  const group = btn ? btn.closest('.chart-tab-group') : null;
  (group ? group.querySelectorAll('.chart-tab') : document.querySelectorAll('.chart-tab')).forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderDashboard();
}

function _dashFilterByPeriod(arr, dateField) {
  const now = new Date();
  let from, to = null;
  if (_dashPeriod === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (_dashPeriod === 'quarter') {
    from = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  } else if (_dashPeriod === 'year') {
    from = new Date(now.getFullYear(), 0, 1);
  } else if (_dashPeriod === 'custom') {
    const fromStr = _dashCustomFrom;
    const toStr = _dashCustomTo;
    return arr.filter(r => {
      const d = (r[dateField] || '').substring(0, 10);
      if (!d) return false;
      if (fromStr && d < fromStr) return false;
      if (toStr && d > toStr) return false;
      return true;
    });
  } else {
    return arr; // all
  }
  const fromStr = from.toISOString().substring(0, 10);
  return arr.filter(r => (r[dateField] || '').substring(0, 10) >= fromStr);
}

function renderDashboard() {
  const filteredFuel  = _dashFilterByPeriod(db.fuel,        'date');
  const filteredMaint = _dashFilterByPeriod(db.maintenance, 'date');
  const filteredOil   = _dashFilterByPeriod(db.oil,         'date');

  const totalMaint = filteredMaint.reduce((s, r) => s + r.cost, 0);
  const totalFuel  = filteredFuel.reduce((s, r)  => s + r.cost, 0);
  const totalOil   = filteredOil.reduce((s, r)   => s + r.cost, 0);
  const totalCost  = totalMaint + totalFuel + totalOil;
  const totalLiters = filteredFuel.reduce((s, r) => s + r.liters, 0);
  const inUse      = db.assignments.filter(a => !a.kmEnd).length;

  // KM total rodado (from assignments in period)
  // Conta viagens já devolvidas (kmEnd - kmStart) e também as que ainda estão
  // em uso, estimando o km rodado até agora pelo KM atual do veículo.
  const _vehByIdKm = Object.fromEntries(db.vehicles.map(v => [v.id, v]));
  const filteredAssignments = _dashFilterByPeriod(db.assignments, 'date');
  const totalKm = filteredAssignments.reduce((s, a) => {
    if (a.kmEnd && a.kmStart) return s + (a.kmEnd - a.kmStart);
    if (!a.kmEnd && a.kmStart) {
      const veh = _vehByIdKm[a.vehicleId];
      if (veh && veh.km > a.kmStart) return s + (veh.km - a.kmStart);
    }
    return s;
  }, 0);

  // KPI Row 1
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('kpi-v', db.vehicles.length);
  setEl('kpi-v-sub', db.vehicles.length === 1 ? 'cadastrado' : 'cadastrados');
  setEl('kpi-d', db.drivers.length);
  setEl('kpi-d-sub', db.drivers.length === 1 ? 'cadastrado' : 'cadastrados');
  setEl('kpi-inuse', inUse);
  setEl('kpi-inuse-sub', inUse === 1 ? 'veículo' : 'veículos');
  setEl('kpi-maint-count', filteredMaint.length);
  setEl('kpi-maint-sub', `${filteredMaint.length === 1 ? 'serviço' : 'serviços'} no período`);
  setEl('kpi-fuel-liters', totalLiters.toLocaleString('pt-BR', {minimumFractionDigits:1,maximumFractionDigits:1}) + ' L');
  setEl('kpi-fuel-sub', `${filteredFuel.length} abastecimento(s)`);
  setEl('kpi-tc', fmtCurrency(totalCost));
  setEl('dash-subtitle', `${db.vehicles.length} veículo(s) · ${db.drivers.length} motorista(s) · Custo acumulado ${fmtCurrency(db.maintenance.reduce((s,r)=>s+r.cost,0) + db.fuel.reduce((s,r)=>s+r.cost,0) + db.oil.reduce((s,r)=>s+r.cost,0))}`);

  // KPI Row 2 — Cost bars
  setEl('kpi-fc', fmtCurrency(totalFuel));
  setEl('kpi-mc', fmtCurrency(totalMaint));
  setEl('kpi-oc', fmtCurrency(totalOil));
  setEl('kpi-km', totalKm.toLocaleString('pt-BR') + ' km');
  const maxCost = Math.max(totalFuel, totalMaint, totalOil, 1);
  const setBar = (id, val) => { const el = document.getElementById(id); if (el) el.style.width = Math.round((val / maxCost) * 100) + '%'; };
  setBar('kpi-fc-bar', totalFuel);
  setBar('kpi-mc-bar', totalMaint);
  setBar('kpi-oc-bar', totalOil);
  // KM não é a mesma unidade que R$, então não faz sentido comparar com maxCost.
  // Aqui a barra só indica se houve quilometragem registrada no período (0% ou 100%).
  const kmBarEl = document.getElementById('kpi-km-bar');
  if (kmBarEl) kmBarEl.style.width = (totalKm > 0 ? 100 : 0) + '%';

  // Period label on ranking
  const periodLabels = { month:'Este mês', quarter:'Trimestre', year:'Este ano', all:'Histórico',
    custom: (_dashCustomFrom || _dashCustomTo) ? `${_dashCustomFrom?fmtDate(_dashCustomFrom):'início'} a ${_dashCustomTo?fmtDate(_dashCustomTo):'hoje'}` : 'Período específico' };
  setEl('ranking-period-label', periodLabels[_dashPeriod] || '');

  // ── ALERT BANNER (topo) ──
  const alertEl = document.getElementById('dash-alerts');
  const cnhAlerts = db.drivers.filter(d => cnhStatus(d.cnhExpiry) !== 'ok');
  const oilAlertsVehicles = [];
  db.vehicles.forEach(v => {
    if (getOilAlertStatus(v.id)) oilAlertsVehicles.push(v);
  });
  const today = new Date();
  const dueScheduledMaint = (db.scheduledMaintenance || []).filter(s => {
    if (s.status === 'concluida') return false;
    const v = db.vehicles.find(vv => vv.id === s.vehicleId);
    const daysLeft = s.dueDate ? Math.ceil((new Date(s.dueDate+'T00:00:00') - today) / 86400000) : null;
    const kmLeft = (s.dueKm && v) ? s.dueKm - v.km : null;
    return (daysLeft !== null && daysLeft <= 7) || (kmLeft !== null && kmLeft <= 500);
  });
  const totalAlerts = cnhAlerts.length + oilAlertsVehicles.length + dueScheduledMaint.length + (inUse > 0 ? 1 : 0);
  let alertHtml = '';
  if (totalAlerts > 0) {
    const parts = [];
    if (cnhAlerts.length) parts.push(`CNH de ${cnhAlerts.map(d=>d.name.split(' ')[0]).join(', ')} vence em breve`);
    if (oilAlertsVehicles.length) parts.push(`Troca de óleo pendente em ${oilAlertsVehicles.map(v=>v.plate).join(', ')}`);
    if (dueScheduledMaint.length) parts.push(`${dueScheduledMaint.length} manutenção(ões) programada(s) próxima(s)`);
    if (inUse > 0) parts.push(`${inUse} veículo(s) em uso agora`);
    alertHtml = `<div class="alert-strip-new warning">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L15 14H1L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v4M8 12v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <span><strong>${totalAlerts} alerta(s) ativo(s):</strong> ${parts.join(' · ')}</span>
    </div>`;
  }
  alertEl.innerHTML = alertHtml;

  // ── ALERTS DETAIL PANEL ──
  const detailEl = document.getElementById('dash-alerts-detail');
  const badge = document.getElementById('alert-count-badge');
  let detailItems = [];
  cnhAlerts.forEach(d => {
    const s = cnhStatus(d.cnhExpiry);
    detailItems.push({
      icon:'🪪', color: s === 'expired' ? '#EF4444' : '#F59E0B',
      title: `CNH — ${d.name}`,
      sub: s === 'expired' ? `Vencida em ${fmtDate(d.cnhExpiry)}` : `Vence em ${fmtDate(d.cnhExpiry)}`,
      type: s === 'expired' ? 'danger' : 'warning',
    });
  });
  oilAlertsVehicles.forEach(v => {
    const lastOilRec = getLastOilRecord(v.id);
    const remaining = lastOilRec ? Math.max(0, lastOilRec.nextKm - v.km) : 0;
    detailItems.push({
      icon:'🛢️', color:'#EA580C',
      title: `Óleo — ${v.plate}`,
      sub: `Faltam ${remaining.toLocaleString('pt-BR')} km para próxima troca`,
      type: remaining === 0 ? 'danger' : 'warning',
    });
  });
  // (Manutenções: os alertas de "próxima revisão" vêm exclusivamente da aba
  // Programadas — dueScheduledMaint, abaixo — nunca de registros já concluídos.)
  dueScheduledMaint.forEach(s => {
    const v = db.vehicles.find(vv => vv.id === s.vehicleId);
    const daysLeft = s.dueDate ? Math.ceil((new Date(s.dueDate+'T00:00:00') - today) / 86400000) : null;
    const kmLeft = (s.dueKm && v) ? s.dueKm - v.km : null;
    const overdue = (daysLeft !== null && daysLeft < 0) || (kmLeft !== null && kmLeft <= 0);
    detailItems.push({
      icon:'🗓️', color: overdue ? '#EF4444' : '#F59E0B',
      title: `${s.description || s.type || 'Manutenção'} — ${s.vehiclePlate}`,
      sub: daysLeft !== null ? (overdue ? `Atrasada há ${Math.abs(daysLeft)} dia(s)` : `Prevista para ${fmtDate(s.dueDate)}`) : (kmLeft !== null ? `Faltam ${kmLeft.toLocaleString('pt-BR')} km` : 'Manutenção programada pendente'),
      type: overdue ? 'danger' : 'warning',
    });
  });
  if (inUse > 0) {
    const active = db.assignments.filter(a => !a.kmEnd);
    active.forEach(a => {
      detailItems.push({
        icon:'🚗', color:'#22C55E',
        title: `Em uso — ${a.vehiclePlate}`,
        sub: `${a.driverName} · desde ${fmtDate(a.date)}`,
        type: 'info',
      });
    });
  }

  if (badge) {
    const alertCount = cnhAlerts.length + oilAlertsVehicles.length + dueScheduledMaint.length;
    badge.style.display = alertCount > 0 ? '' : 'none';
    badge.textContent = alertCount;
  }

  if (!detailItems.length) {
    detailEl.innerHTML = '<div class="alert-detail-empty"><svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="14" stroke="#22C55E" stroke-width="1.5"/><path d="M10 16l4 4 8-8" stroke="#22C55E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Tudo em ordem!</span></div>';
  } else {
    detailEl.innerHTML = detailItems.map(item => `
      <div class="alert-detail-item alert-detail-${item.type}">
        <span class="alert-detail-icon">${item.icon}</span>
        <div class="alert-detail-body">
          <div class="alert-detail-title">${item.title}</div>
          <div class="alert-detail-sub">${item.sub}</div>
        </div>
      </div>`).join('');
  }

  // ── COST MAP PER VEHICLE (all time for status grid) ──
  const allCosts = {};
  db.vehicles.forEach(v => { allCosts[v.id] = { v, maint:0, fuel:0, oil:0, liters:0 }; });
  db.maintenance.forEach(r => { if (allCosts[r.vehicleId]) allCosts[r.vehicleId].maint += r.cost; });
  db.fuel.forEach(r => { if (allCosts[r.vehicleId]) { allCosts[r.vehicleId].fuel += r.cost; allCosts[r.vehicleId].liters += r.liters; } });
  db.oil.forEach(r => { if (allCosts[r.vehicleId]) allCosts[r.vehicleId].oil += r.cost; });
  const allEntries = Object.values(allCosts).sort((a,b) => (b.maint+b.fuel+b.oil) - (a.maint+a.fuel+a.oil));

  // Period-filtered cost map for ranking
  const pCosts = {};
  db.vehicles.forEach(v => { pCosts[v.id] = { v, maint:0, fuel:0, oil:0 }; });
  filteredMaint.forEach(r => { if (pCosts[r.vehicleId]) pCosts[r.vehicleId].maint += r.cost; });
  filteredFuel.forEach(r => { if (pCosts[r.vehicleId]) pCosts[r.vehicleId].fuel += r.cost; });
  filteredOil.forEach(r => { if (pCosts[r.vehicleId]) pCosts[r.vehicleId].oil += r.cost; });
  const pEntries = Object.values(pCosts).sort((a,b) => (b.maint+b.fuel+b.oil) - (a.maint+a.fuel+a.oil));

  // ── COST RANKING ──
  const rankEl = document.getElementById('cost-ranking-list');
  if (!pEntries.length || !db.vehicles.length) {
    rankEl.innerHTML = '<div class="rank-empty">' + emptyState('📊','Sem dados no período','Registre abastecimentos e manutenções') + '</div>';
  } else {
    const maxT = Math.max(...pEntries.map(e => e.maint + e.fuel + e.oil), 1);
    rankEl.innerHTML = pEntries.map((e, i) => {
      const total = e.maint + e.fuel + e.oil;
      const pct = Math.round((total / maxT) * 100);
      return `<div class="rank-item">
        <div class="rank-pos">${i+1}</div>
        <div class="rank-body">
          <div class="rank-header">
            <span class="rank-plate">${e.v.plate}</span>
            <span class="rank-model">${e.v.brand} ${e.v.model}</span>
            <span class="rank-total">${fmtCurrency(total)}</span>
          </div>
          <div class="rank-bar-wrap">
            <div class="rank-bar" style="width:${pct}%"></div>
          </div>
          <div class="rank-cats">
            ${e.fuel > 0 ? `<span class="rank-cat" style="color:#0891B2">⛽ ${fmtCurrency(e.fuel)}</span>` : ''}
            ${e.maint > 0 ? `<span class="rank-cat" style="color:#CA8A04">🔧 ${fmtCurrency(e.maint)}</span>` : ''}
            ${e.oil > 0 ? `<span class="rank-cat" style="color:#EA580C">🛢️ ${fmtCurrency(e.oil)}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // ── VEHICLE STATUS GRID ──
  const vsg = document.getElementById('vehicle-status-grid');
  if (!db.vehicles.length) {
    vsg.innerHTML = '<div style="padding:32px 20px">' + emptyState('🚗','Nenhum veículo cadastrado','Acesse o menu Veículos') + '</div>';
  } else {
    vsg.innerHTML = allEntries.map(({ v, maint, fuel, oil, liters }) => {
      const ico     = v.type === 'moto' ? '🏍️' : '🚗';
      const total   = maint + fuel + oil;
      const isInUse = db.assignments.some(a => a.vehicleId === v.id && !a.kmEnd);
      const isOnTrip = db.trips.some(t => t.vehicleId === v.id && t.status === 'andamento');
      const oilAlert = !!getOilAlertStatus(v.id);
      // avg consumption
      const vFuelSorted = [...db.fuel].filter(f => f.vehicleId === v.id).sort((a,b) => a.km - b.km);
      let avgCons = null;
      if (vFuelSorted.length >= 2) {
        const kmDiff = vFuelSorted[vFuelSorted.length-1].km - vFuelSorted[0].km;
        const litersUsed = vFuelSorted.slice(1).reduce((s,f) => s+f.liters, 0);
        if (litersUsed > 0) avgCons = kmDiff / litersUsed;
      }
      return `<div class="vehicle-status-card">
        <div class="vsc-header">
          <div>
            <div class="vsc-plate">${v.plate}</div>
            <div class="vsc-model">${v.brand} ${v.model} · ${v.year}</div>
          </div>
          <div class="vsc-badges">
            <span class="vsc-type-badge">${ico}</span>
            ${isOnTrip ? '<span class="vsc-status-badge vsc-status-trip">Em Viagem</span>' : (isInUse ? '<span class="vsc-status-badge vsc-status-inuse">Em Uso</span>' : '<span class="vsc-status-badge vsc-status-avail">Disponível</span>')}
            ${oilAlert ? '<span class="vsc-status-badge vsc-status-oil">⚠ Óleo</span>' : ''}
          </div>
        </div>
        <div class="vsc-stats">
          <div class="vsc-stat"><div class="vsc-stat-label">KM Atual</div><div class="vsc-stat-value">${v.km.toLocaleString('pt-BR')}</div></div>
          <div class="vsc-stat"><div class="vsc-stat-label">Litros Total</div><div class="vsc-stat-value">${liters.toFixed(1)} L</div></div>
          <div class="vsc-stat"><div class="vsc-stat-label">Consumo Médio</div><div class="vsc-stat-value">${avgCons ? avgCons.toFixed(2)+' km/L' : '—'}</div></div>
          <div class="vsc-stat"><div class="vsc-stat-label">Últ. Manutenção</div><div class="vsc-stat-value">${v.lastMaint ? fmtDate(v.lastMaint) : '—'}</div></div>
        </div>
        <div class="vsc-footer">
          <div class="vsc-cost-bars">
            ${fuel > 0 ? `<div class="vsc-cost-bar-item"><span style="color:#0891B2">⛽</span><span>${fmtCurrency(fuel)}</span></div>` : ''}
            ${maint > 0 ? `<div class="vsc-cost-bar-item"><span style="color:#CA8A04">🔧</span><span>${fmtCurrency(maint)}</span></div>` : ''}
            ${oil > 0 ? `<div class="vsc-cost-bar-item"><span style="color:#EA580C">🛢️</span><span>${fmtCurrency(oil)}</span></div>` : ''}
          </div>
          <div class="vsc-total"><span class="vsc-total-label">Total</span><span class="vsc-total-value">${fmtCurrency(total)}</span></div>
        </div>
      </div>`;
    }).join('');
  }

  // ── ACTIVITY FEED ──
  const events = [
    ...db.fuel.map(r => ({ date:r.date, label:`Abastecimento · ${r.vehiclePlate}`, meta:`${r.liters.toFixed(1)} L · ${r.driverName}`, cost:r.cost, color:'#0891B2' })),
    ...db.maintenance.map(r => ({ date:r.date, label:`Manutenção · ${r.vehiclePlate}`, meta:`${r.type} · ${r.driverName}`, cost:r.cost, color:'#CA8A04' })),
    ...db.oil.map(r => ({ date:r.date, label:`Troca de Óleo · ${r.vehiclePlate}`, meta:`${r.oilType}${r.viscosity?' '+r.viscosity:''} · ${r.driverName}`, cost:r.cost, color:'#EA580C' })),
    ...db.assignments.map(r => ({ date:r.date, label:`Atribuição · ${r.vehiclePlate}`, meta:`${r.driverName} · ${r.kmEnd?'devolvido':'em uso'}`, cost:null, color:'#7C3AED' })),
  ].sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0, 10);

  const actEl = document.getElementById('activity-list');
  actEl.innerHTML = events.length ? events.map(ev => `
    <div class="activity-item">
      <div class="activity-dot" style="background:${ev.color};box-shadow:0 0 5px ${ev.color}40"></div>
      <div class="activity-body">
        <div class="activity-title">${ev.label}</div>
        <div class="activity-meta">${fmtDate(ev.date)} · ${ev.meta}</div>
      </div>
      ${ev.cost != null ? `<div class="activity-cost">${fmtCurrency(ev.cost)}</div>` : ''}
    </div>`).join('')
    : '<div style="padding:32px 20px">' + emptyState('📋','Sem movimentações','Registre abastecimentos, manutenções e trocas de óleo') + '</div>';

  // ── CONSUMPTION TABLE ──
  const consEl = document.getElementById('consumption-table');
  if (consEl) {
    const consData = db.vehicles.map(v => {
      const vFuels = [...db.fuel].filter(f => f.vehicleId === v.id).sort((a,b) => a.km - b.km);
      let avgCons = null;
      if (vFuels.length >= 2) {
        const kmDiff = vFuels[vFuels.length-1].km - vFuels[0].km;
        const litersUsed = vFuels.slice(1).reduce((s,f) => s+f.liters, 0);
        if (litersUsed > 0) avgCons = kmDiff / litersUsed;
      }
      const totalV = allCosts[v.id]?.fuel || 0;
      const totalLitersV = allCosts[v.id]?.liters || 0;
      return { v, avgCons, totalLitersV, totalV };
    }).sort((a,b) => (b.avgCons||0) - (a.avgCons||0));

    if (!consData.length) {
      consEl.innerHTML = '<div style="padding:24px">' + emptyState('📊','Sem dados','Registre abastecimentos para calcular o consumo') + '</div>';
    } else {
      consEl.innerHTML = `<table class="cons-table">
        <thead><tr>
          <th>Veículo</th><th>Marca / Modelo</th><th>KM Atual</th>
          <th>Litros Consumidos</th><th>Consumo Médio</th><th>Custo Combustível</th>
        </tr></thead>
        <tbody>${consData.map(({v, avgCons, totalLitersV, totalV}) => {
          const rating = avgCons === null ? '' : avgCons >= 12 ? '🟢' : avgCons >= 10 ? '🟡' : avgCons >= 8 ? '🟠' : '🔴';
          return `<tr>
            <td><strong>${v.plate}</strong></td>
            <td>${v.brand} ${v.model} ${v.year}</td>
            <td>${v.km.toLocaleString('pt-BR')} km</td>
            <td>${totalLitersV.toFixed(1)} L</td>
            <td>${avgCons !== null ? `${rating} ${avgCons.toFixed(2)} km/L` : '—'}</td>
            <td>${fmtCurrency(totalV)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    }
  }

  // Legacy oil-alert panel (hidden)
  const alertPanel = document.getElementById('oil-alert-panel');
  if (alertPanel) alertPanel.style.display = 'none';

  renderCharts(allEntries, filteredFuel, filteredMaint, filteredOil);
}

function _setChartEmpty(canvasId, isEmpty, icon, title, sub) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const wrap = canvas.parentElement;
  wrap.classList.toggle('is-empty', isEmpty);
  let emptyEl = wrap.querySelector('.chart-empty-overlay');
  if (isEmpty) {
    canvas.style.display = 'none';
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.className = 'chart-empty-overlay';
      wrap.appendChild(emptyEl);
    }
    emptyEl.innerHTML = emptyState(icon, title, sub);
  } else {
    canvas.style.display = '';
    if (emptyEl) emptyEl.remove();
  }
}

function _lastNMonthKeys(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  return out;
}

function renderCharts(entries, filteredFuel, filteredMaint, filteredOil) {
  // Enquanto a aba Dashboard não está visível (ex.: durante a atualização automática de
  // fundo, com o usuário em outra tela), o Chart.js não consegue medir corretamente o
  // canvas escondido — isso é o que fazia os gráficos ficarem com tamanho errado/quebrado
  // ("se comendo"). Por isso só recriamos os gráficos quando a página está realmente ativa;
  // eles são redesenhados do zero, com o tamanho certo, assim que o usuário volta pro Dashboard.
  const dashPage = document.getElementById('dashboard-page');
  if (!dashPage || !dashPage.classList.contains('active')) return;

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  const tickColor = isDark ? '#6B7AA0' : '#8A93B0';
  const baseOpts = {
    responsive:true, maintainAspectRatio:false,
    layout: { padding: { top: 8 } },
    plugins: { legend: { labels: { color:tickColor, font:{family:'DM Sans',size:11}, boxWidth:10, padding:14 } } },
    scales: {
      x: { ticks:{color:tickColor,font:{family:'DM Sans',size:11}}, grid:{color:gridColor} },
      y: { beginAtZero:true, grace:'12%', ticks:{color:tickColor,font:{family:'DM Sans',size:11}}, grid:{color:gridColor} },
    },
  };

  // ── COST CHART (monthly or by vehicle) ──
  if (charts.costs) { charts.costs.destroy(); charts.costs = null; }
  const costCtx = document.getElementById('chart-costs');
  if (costCtx) {
    if (_costChartMode === 'monthly') {
      // Janela fixa dos últimos 6 meses (sempre a mesma quantidade de colunas,
      // independente de quantos meses têm lançamento)
      const monthly = {};
      const allArr = [...db.fuel.map(r=>({date:r.date,cat:'fuel',val:r.cost})),
                      ...db.maintenance.map(r=>({date:r.date,cat:'maint',val:r.cost})),
                      ...db.oil.map(r=>({date:r.date,cat:'oil',val:r.cost}))];
      allArr.forEach(r => {
        const m = r.date?.substring(0,7); if (!m) return;
        if (!monthly[m]) monthly[m] = {fuel:0,maint:0,oil:0};
        monthly[m][r.cat] += r.val;
      });
      const mKeys = _lastNMonthKeys(6);
      const mLabels = mKeys.map(k => { const [y,m]=k.split('-'); return new Date(y,m-1).toLocaleDateString('pt-BR',{month:'short',year:'2-digit'}); });
      if (!allArr.length) {
        _setChartEmpty('chart-costs', true, '📊', 'Nenhum custo registrado ainda', 'Registre abastecimentos, manutenções ou trocas de óleo para ver o gráfico.');
      } else {
        _setChartEmpty('chart-costs', false);
        charts.costs = new Chart(costCtx.getContext('2d'), {
          type:'bar',
          data: {
            labels: mLabels,
            datasets: [
              { label:'Combustível', data:mKeys.map(k=>(monthly[k]?.fuel||0)), backgroundColor:'rgba(8,145,178,0.75)',  borderRadius:4, maxBarThickness:56 },
              { label:'Manutenção',  data:mKeys.map(k=>(monthly[k]?.maint||0)), backgroundColor:'rgba(202,138,4,0.75)', borderRadius:4, maxBarThickness:56 },
              { label:'Óleo',        data:mKeys.map(k=>(monthly[k]?.oil||0)),  backgroundColor:'rgba(234,88,12,0.75)',  borderRadius:4, maxBarThickness:56 },
            ],
          },
          options: { ...baseOpts,
            plugins: { ...baseOpts.plugins, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtCurrency(ctx.parsed.y)}` } } },
            scales: {
            x: { ...baseOpts.scales.x, stacked:true },
            y: { ...baseOpts.scales.y, stacked:true, ticks:{...baseOpts.scales.y.ticks, callback:v=>'R$ '+v.toLocaleString('pt-BR')} },
          }},
        });
      }
    } else {
      // By vehicle
      const hasVehicleCosts = entries.some(e => (e.maint + e.fuel + e.oil) > 0);
      if (!hasVehicleCosts) {
        _setChartEmpty('chart-costs', true, '📊', 'Nenhum custo registrado ainda', 'Registre abastecimentos, manutenções ou trocas de óleo para ver o gráfico.');
      } else {
        _setChartEmpty('chart-costs', false);
        charts.costs = new Chart(costCtx.getContext('2d'), {
          type:'bar',
          data: {
            labels: entries.map(e => e.v.plate),
            datasets: [
              { label:'Combustível', data:entries.map(e=>e.fuel),  backgroundColor:'rgba(8,145,178,0.75)',  borderRadius:4, maxBarThickness:56 },
              { label:'Manutenção',  data:entries.map(e=>e.maint), backgroundColor:'rgba(202,138,4,0.75)',  borderRadius:4, maxBarThickness:56 },
              { label:'Óleo',        data:entries.map(e=>e.oil),   backgroundColor:'rgba(234,88,12,0.75)',  borderRadius:4, maxBarThickness:56 },
            ],
          },
          options: { ...baseOpts,
            plugins: { ...baseOpts.plugins, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtCurrency(ctx.parsed.y)}` } } },
            scales: {
            x: { ...baseOpts.scales.x, stacked:true },
            y: { ...baseOpts.scales.y, stacked:true, ticks:{...baseOpts.scales.y.ticks, callback:v=>'R$ '+v.toLocaleString('pt-BR')} },
          }},
        });
      }
    }
  }

  // ── FUEL CHART (mensal ou por veículo) ──
  if (charts.fuel) { charts.fuel.destroy(); charts.fuel = null; }
  const fuelCtx = document.getElementById('chart-fuel');
  if (fuelCtx) {
    if (_fuelChartMode === 'vehicle') {
      // Litros consumidos por veículo (usa o mesmo recorte "entries" da tabela de custos)
      const byVehicle = [...entries].filter(e => e.liters > 0).sort((a,b) => b.liters - a.liters).slice(0, 10);
      if (!byVehicle.length) {
        _setChartEmpty('chart-fuel', true, '⛽', 'Nenhum abastecimento registrado ainda', 'Registre abastecimentos para ver o consumo por veículo.');
      } else {
        _setChartEmpty('chart-fuel', false);
        charts.fuel = new Chart(fuelCtx.getContext('2d'), {
          type:'bar',
          data: {
            labels: byVehicle.map(e => e.v.plate),
            datasets: [{ label:'Litros', data: byVehicle.map(e => parseFloat(e.liters.toFixed(2))),
              backgroundColor:accentColorRgba(0.75), borderRadius:4, maxBarThickness:36,
            }],
          },
          options: { ...baseOpts, indexAxis:'y', plugins:{ legend:{ display:false } } },
        });
      }
    } else {
      const monthly2 = {};
      db.fuel.forEach(f => { const m=f.date?.substring(0,7); if(m) monthly2[m]=(monthly2[m]||0)+f.liters; });
      const mKeys2   = _lastNMonthKeys(6);
      const mLabels2 = mKeys2.map(k => { const [y,m]=k.split('-'); return new Date(y,m-1).toLocaleDateString('pt-BR',{month:'short',year:'2-digit'}); });
      if (!db.fuel.length) {
        _setChartEmpty('chart-fuel', true, '⛽', 'Nenhum abastecimento registrado ainda', 'Registre abastecimentos para ver a evolução do consumo.');
      } else {
        _setChartEmpty('chart-fuel', false);
        charts.fuel = new Chart(fuelCtx.getContext('2d'), {
          type:'line',
          data: {
            labels: mLabels2,
            datasets: [{ label:'Litros', data:mKeys2.map(k=>parseFloat(monthly2[k].toFixed(2))),
              borderColor:accentColor(), backgroundColor:accentColorRgba(0.08), fill:true, tension:0.4,
              pointBackgroundColor:accentColor(), pointRadius:4, pointHoverRadius:6,
            }],
          },
          options: baseOpts,
        });
      }
    }
  }
}


// ════════════════════════════════════════════════
// CENTRAL DE ALERTAS
// ════════════════════════════════════════════════
function goToPage(pageId) {
  switchPage(pageId, document.querySelector(`.nav-item[data-page="${pageId}"]`));
}

// ── ATUALIZAÇÃO AUTOMÁTICA (evita ter que dar F5) ─────────────────────
// A cada poucos segundos, busca os dados mais recentes do servidor. Se algo
// mudou (ex.: outro usuário registrou algo em outro computador/aba), a tela
// atualiza sozinha — inclusive disparando um pop-up na hora quando surge um
// alerta novo na Central de Alertas.
const AUTO_REFRESH_INTERVAL_MS = 15000; // 15s
let _autoRefreshTimer = null;
let _lastServerSnapshot = null;
let _seenAlertKeys = null; // null = ainda não inicializado; evita notificar alertas que já existiam ao entrar no sistema

function startAutoRefresh() {
  if (_autoRefreshTimer) return;
  try { _lastServerSnapshot = JSON.stringify(dbFull); } catch (_) {}
  _autoRefreshTimer = setInterval(pollForUpdates, AUTO_REFRESH_INTERVAL_MS);
}

async function pollForUpdates() {
  if (!currentUser) return;

  // Não interrompe o usuário no meio de uma ação: se houver um modal aberto
  // ou ele estiver digitando/selecionando algo num campo, tenta de novo no
  // próximo ciclo, sem perder o que ele estava fazendo.
  const modalOpen = document.getElementById('modal-overlay')?.classList.contains('open');
  const active = document.activeElement;
  const typing = active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
  if (modalOpen || typing) return;

  const data = await StorageProvider.load();
  if (!data) return; // servidor indisponível — não faz nada, mantém o que já está na tela

  let snapshot;
  try { snapshot = JSON.stringify(data); } catch (_) { return; }
  if (snapshot === _lastServerSnapshot) return; // nada mudou desde a última checagem
  _lastServerSnapshot = snapshot;

  dbFull = { ...dbFull, ...data };
  migrateToMultiEmpresa();
  rebuildView();
  renderAllModules();
  renderCompanyBadge();
}

// Compara os alertas atuais com os vistos na última renderização e dispara
// um toast quando surge algo novo — assim quem está com o sistema aberto
// fica sabendo na hora, sem precisar entrar na Central de Alertas ou dar F5.
function notifyNewAlerts(items) {
  const keys = new Set(items.map(i => `${i.category}|${i.title}|${i.sub}`));
  if (_seenAlertKeys === null) { _seenAlertKeys = keys; return; } // primeira carga: não notifica o que já existia
  const newOnes = [...keys].filter(k => !_seenAlertKeys.has(k));
  _seenAlertKeys = keys;
  if (!newOnes.length) return;

  const msg = newOnes.length === 1
    ? `🔔 Novo alerta: ${newOnes[0].split('|')[1]}`
    : `🔔 ${newOnes.length} novos alertas na Central de Alertas`;
  showToast(msg, 'warning');
}

function renderAlertsPage() {
  const el = document.getElementById('alerts-content');
  if (!el) return;
  const items = [];
  const today = new Date();

  // CNH alerts
  db.drivers.forEach(d => {
    const st = cnhStatus(d.cnhExpiry);
    if (st !== 'ok') {
      const days = d.cnhExpiry ? Math.ceil((new Date(d.cnhExpiry+'T00:00:00') - today) / 86400000) : null;
      items.push({
        type: st === 'expired' ? 'danger' : 'warning',
        icon: '🪪', category: 'CNH',
        title: `CNH de ${d.name}`,
        sub: st === 'expired' ? `Vencida em ${fmtDate(d.cnhExpiry)}` : `Vence em ${fmtDate(d.cnhExpiry)} (${days} dias)`,
        action: `goToPage('drivers')`,
        actionLabel: 'Ver motorista',
      });
    }
  });

  // Oil alerts
  // Considera tanto KM quanto DATA de vencimento (nextKm / nextDate) — usar só
  // o KM deixava passar batido o caso de um veículo cadastrado com a troca já
  // vencida por data mas ainda com folga de KM (ex.: KM atual = KM da última
  // troca, informados juntos no cadastro).
  const oilKmBefore   = 500;
  const oilDaysBefore = 7;
  db.vehicles.forEach(v => {
    const oilRec = getLastOilRecord(v.id);
    if (!oilRec) return;

    const kmRemaining = (oilRec.nextKm || 0) - v.km;
    const daysRemaining = oilRec.nextDate
      ? Math.ceil((new Date(oilRec.nextDate + 'T00:00:00') - today) / 86400000)
      : null;

    const overdue    = kmRemaining <= 0 || (daysRemaining !== null && daysRemaining <= 0);
    const nearByKm    = !overdue && kmRemaining <= oilKmBefore;
    const nearByDate  = !overdue && daysRemaining !== null && daysRemaining <= oilDaysBefore;
    if (!overdue && !nearByKm && !nearByDate) return; // óleo em dia

    const subParts = [];
    if (overdue) {
      if (kmRemaining <= 0) subParts.push(`Atrasada em ${Math.abs(kmRemaining).toLocaleString('pt-BR')} km`);
      if (daysRemaining !== null && daysRemaining <= 0) subParts.push(`vencida há ${Math.abs(daysRemaining)} dia(s)`);
    } else {
      if (nearByKm) subParts.push(`faltam ${Math.round(kmRemaining).toLocaleString('pt-BR')} km`);
      if (nearByDate) subParts.push(`${daysRemaining} dia(s) restante(s)`);
    }

    items.push({
      type: overdue ? 'danger' : 'warning',
      icon: '🛢️', category: 'Óleo',
      title: `Troca de óleo — ${v.plate}`,
      sub: subParts.join(' · ') || `Próxima: ${(oilRec.nextKm || 0).toLocaleString('pt-BR')} km`,
      action: `goToPage('oil')`,
      actionLabel: 'Ver trocas',
    });
  });

  // (Alertas de manutenção vêm só de "Programadas" — bloco abaixo — nunca de
  // registros já concluídos na aba "Registrar".)

  // Manutenções programadas (agendadas manualmente, ainda não realizadas)
  (db.scheduledMaintenance || []).filter(s => s.status !== 'concluida').forEach(s => {
    const v = db.vehicles.find(vv => vv.id === s.vehicleId);
    const daysLeft = s.dueDate ? Math.ceil((new Date(s.dueDate+'T00:00:00') - today) / 86400000) : null;
    const kmLeft = (s.dueKm && v) ? s.dueKm - v.km : null;
    const overdue = (daysLeft !== null && daysLeft < 0) || (kmLeft !== null && kmLeft <= 0);
    const nearing = !overdue && ((daysLeft !== null && daysLeft <= 7) || (kmLeft !== null && kmLeft <= 500));
    if (overdue || nearing) {
      const subParts = [];
      if (daysLeft !== null) subParts.push(overdue && daysLeft < 0 ? `Atrasada há ${Math.abs(daysLeft)} dia(s)` : `Prevista para ${fmtDate(s.dueDate)} (${daysLeft} dia(s))`);
      if (kmLeft !== null) subParts.push(overdue && kmLeft <= 0 ? `${Math.abs(kmLeft).toLocaleString('pt-BR')} km acima do previsto` : `Faltam ${kmLeft.toLocaleString('pt-BR')} km`);
      items.push({
        type: overdue ? 'danger' : 'warning',
        icon: '🗓️', category: 'Manutenção Programada',
        title: `${s.description || s.type || 'Manutenção'} — ${s.vehiclePlate}`,
        sub: subParts.join(' · ') || 'Manutenção programada pendente',
        action: `goToPage('maintenance')`,
        actionLabel: 'Ver programadas',
      });
    }
  });

  // Vehicles in use > 7 days
  db.assignments.filter(a => !a.returnDate).forEach(a => {
    const days = Math.floor((today - new Date(a.date+'T00:00:00')) / 86400000);
    if (days >= 7) {
      items.push({
        type: 'info',
        icon: '🚗', category: 'Em Uso',
        title: `${a.vehiclePlate} sem devolução`,
        sub: `Retirado por ${a.driverName} há ${days} dias (${fmtDate(a.date)})`,
        action: `goToPage('assignments')`,
        actionLabel: 'Ver atribuições',
      });
    }
  });

  // Termo da maleta pendente (validade de 6 meses ou solicitação do administrador)
  db.drivers.filter(d => db.briefcases.some(b => b.assignedDriverId === d.id)).forEach(d => {
    const status = getBriefcaseTermStatus(d.id);
    if (status.needed) {
      items.push({
        type: 'warning',
        icon: '📋', category: 'Termo da Maleta',
        title: `Termo pendente — ${d.name}`,
        sub: status.reason,
        action: `goToPage('weekly-terms')`,
        actionLabel: 'Assinar termo',
      });
    }
  });

  // Ferramentas de uso comum atrasadas
  (db.tempItems || []).filter(t => t.status === 'em_posse' && t.expectedReturnDate && new Date(t.expectedReturnDate) < today).forEach(t => {
    const days = Math.floor((today - new Date(t.expectedReturnDate+'T00:00:00')) / 86400000);
    items.push({
      type: 'danger',
      icon: '🧰', category: 'Ferramenta',
      title: `${t.item} atrasada — ${t.driverName}`,
      sub: `Data de devolução era ${fmtDate(t.expectedReturnDate)} (${days} dia(s) atrás)`,
      action: `goToPage('temp-items')`,
      actionLabel: 'Ver ferramentas',
    });
  });

  const badge = document.getElementById('alerts-page-badge');
  if (badge) {
    badge.textContent = items.length || '';
    badge.style.display = items.length ? 'inline-flex' : 'none';
  }

  notifyNewAlerts(items);

  if (!items.length) {
    el.innerHTML = `<div style="padding:60px 20px;text-align:center;">
      <div style="font-size:2.5rem;margin-bottom:12px;">✅</div>
      <div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:6px;">Tudo em ordem!</div>
      <div style="font-size:0.88rem;color:var(--text-muted);">Nenhum alerta ativo no momento.</div>
    </div>`;
    return;
  }

  const typeOrder = { danger: 0, warning: 1, info: 2 };
  items.sort((a,b) => (typeOrder[a.type]||2) - (typeOrder[b.type]||2));

  el.innerHTML = items.map(item => {
    const colors = { danger: '#EF4444', warning: '#F59E0B', info: '#3B82F6' };
    const bgColors = { danger: 'rgba(239,68,68,0.07)', warning: 'rgba(245,158,11,0.07)', info: 'rgba(59,130,246,0.07)' };
    return `<div class="alert-page-item" style="background:${bgColors[item.type]};border-left:4px solid ${colors[item.type]};">
      <div class="alert-page-icon">${item.icon}</div>
      <div class="alert-page-body">
        <div class="alert-page-cat" style="color:${colors[item.type]}">${item.category}</div>
        <div class="alert-page-title">${item.title}</div>
        <div class="alert-page-sub">${item.sub}</div>
      </div>
      <button class="btn btn-sm btn-ghost" onclick="${item.action}">${item.actionLabel}</button>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════════════
// FICHA DE IMPRESSÃO (Veículo ou Motorista)
// ════════════════════════════════════════════════
function printVehicleCard(vehicleId) {
  const v = db.vehicles.find(x => x.id === vehicleId); if (!v) return;
  const fuels  = db.fuel.filter(f => f.vehicleId === vehicleId).sort((a,b) => new Date(b.date)-new Date(a.date));
  const maints = db.maintenance.filter(m => m.vehicleId === vehicleId).sort((a,b) => new Date(b.date)-new Date(a.date));
  const oils   = db.oil.filter(o => o.vehicleId === vehicleId).sort((a,b) => new Date(b.date)-new Date(a.date));
  const totalCost = fuels.reduce((s,r)=>s+r.cost,0) + maints.reduce((s,r)=>s+r.cost,0) + oils.reduce((s,r)=>s+r.cost,0);

  const win = window.open('','_blank','width=900,height=700');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ficha — ${v.plate}</title>
  <style>
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:400 700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-ext-400-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:400; font-display:swap; src:url('fonts/ibm-plex-sans-latin-400-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-ext-700-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-700-normal.woff2') format('woff2'); }
    @font-face { font-family:'Plus Jakarta Sans'; font-style:normal; font-weight:800; font-display:swap; src:url('fonts/plus-jakarta-sans-latin-ext-800-normal.woff2') format('woff2'); }
    @font-face { font-family:'Plus Jakarta Sans'; font-style:normal; font-weight:800; font-display:swap; src:url('fonts/plus-jakarta-sans-latin-800-normal.woff2') format('woff2'); }
    body { font-family: 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif; margin: 0; padding: 24px; color: #1e293b; font-size: 13px; }
    h1 { font-family:'Plus Jakarta Sans', 'Segoe UI', Arial, sans-serif; font-weight:800; font-size: 20px; margin: 0 0 4px; } .sub { color: #64748b; font-size: 13px; margin-bottom: 20px; }
    .kpis { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .kpi { background: #f1f5f9; padding: 12px 16px; border-radius: 8px; min-width: 120px; }
    .kpi-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    .kpi-value { font-size: 18px; font-weight: 700; color: #1e293b; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
    th { background: #f8fafc; padding: 8px; text-align: left; border-bottom: 2px solid #e2e8f0; font-size: 11px; text-transform: uppercase; color: #64748b; }
    td { padding: 7px 8px; border-bottom: 1px solid #f1f5f9; }
    h2 { font-size: 14px; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; margin: 20px 0 10px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 2px solid #1e293b; padding-bottom: 12px; }
    .footer { margin-top: 32px; color: #94a3b8; font-size: 11px; text-align: center; }
    @media print { body { margin: 0; padding: 16px; } }
  </style></head><body>
  <div class="header">
    <div><h1>${v.plate} — ${v.brand} ${v.model} ${v.year}</h1><div class="sub">${v.color || ''} · ${v.fuelType || ''} · KM Atual: ${v.km.toLocaleString('pt-BR')} km</div></div>
    <div style="text-align:right;font-size:12px;color:#64748b;">Gerado em ${new Date().toLocaleDateString('pt-BR')}<br>${BRANDING().appName} — ${BRANDING().appSubtitle}</div>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="kpi-label">Custo Total</div><div class="kpi-value">${fmtCurrency(totalCost)}</div></div>
    <div class="kpi"><div class="kpi-label">Abastecimentos</div><div class="kpi-value">${fuels.length}</div></div>
    <div class="kpi"><div class="kpi-label">Manutenções</div><div class="kpi-value">${maints.length}</div></div>
    <div class="kpi"><div class="kpi-label">Trocas de Óleo</div><div class="kpi-value">${oils.length}</div></div>
  </div>
  <h2>Abastecimentos</h2>
  ${fuels.length ? `<table><thead><tr><th>Data</th><th>Motorista</th><th>Combustível</th><th>Litros</th><th>Custo</th><th>KM</th><th>Posto</th></tr></thead><tbody>
  ${fuels.map(f=>`<tr><td>${fmtDate(f.date)}</td><td>${f.driverName}</td><td>${f.fuelType}</td><td>${f.liters.toFixed(2)} L</td><td>${fmtCurrency(f.cost)}</td><td>${f.km.toLocaleString('pt-BR')} km</td><td>${f.station||'—'}</td></tr>`).join('')}
  </tbody></table>` : '<p style="color:#94a3b8;font-size:12px">Nenhum registro.</p>'}
  <h2>Manutenções</h2>
  ${maints.length ? `<table><thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Oficina</th><th>KM</th><th>Custo</th></tr></thead><tbody>
  ${maints.map(m=>`<tr><td>${fmtDate(m.date)}</td><td>${m.type}</td><td>${m.description||'—'}</td><td>${m.workshop||'—'}</td><td>${m.km.toLocaleString('pt-BR')} km</td><td>${fmtCurrency(m.cost)}</td></tr>`).join('')}
  </tbody></table>` : '<p style="color:#94a3b8;font-size:12px">Nenhum registro.</p>'}
  <h2>Trocas de Óleo</h2>
  ${oils.length ? `<table><thead><tr><th>Data</th><th>Tipo</th><th>Marca</th><th>KM</th><th>Próxima KM</th><th>Custo</th></tr></thead><tbody>
  ${oils.map(o=>`<tr><td>${fmtDate(o.date)}</td><td>${o.oilType}${o.viscosity?' ('+o.viscosity+')':''}</td><td>${o.brand||'—'}</td><td>${o.km.toLocaleString('pt-BR')} km</td><td>${o.nextKm.toLocaleString('pt-BR')} km</td><td>${fmtCurrency(o.cost)}</td></tr>`).join('')}
  </tbody></table>` : '<p style="color:#94a3b8;font-size:12px">Nenhum registro.</p>'}
  <div class="footer">${BRANDING().reportFooter || BRANDING().appName} — Ficha de Veículo · ${v.plate} · Emitida em ${new Date().toLocaleString('pt-BR')}</div>
  <script>window.onload = () => window.print();</script>
  </body></html>`);
  win.document.close();
}

function printDriverCard(driverId) {
  const d = db.drivers.find(x => x.id === driverId); if (!d) return;
  const assignments = db.assignments.filter(a => a.driverId === driverId).sort((a,b) => new Date(b.date)-new Date(a.date));
  const fuels       = db.fuel.filter(f => f.driverId === driverId).sort((a,b) => new Date(b.date)-new Date(a.date));
  const maints      = db.maintenance.filter(m => m.driverId === driverId).sort((a,b) => new Date(b.date)-new Date(a.date));
  const totalCost   = fuels.reduce((s,r)=>s+r.cost,0) + maints.reduce((s,r)=>s+r.cost,0);
  const st          = cnhStatus(d.cnhExpiry);
  const cnhLabel    = st === 'expired' ? 'VENCIDA' : st === 'expiring' ? 'VENCE EM BREVE' : 'VÁLIDA';

  const win = window.open('','_blank','width=900,height=700');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ficha — ${d.name}</title>
  <style>
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:400 700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-ext-400-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:400; font-display:swap; src:url('fonts/ibm-plex-sans-latin-400-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-ext-700-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-700-normal.woff2') format('woff2'); }
    @font-face { font-family:'Plus Jakarta Sans'; font-style:normal; font-weight:800; font-display:swap; src:url('fonts/plus-jakarta-sans-latin-ext-800-normal.woff2') format('woff2'); }
    @font-face { font-family:'Plus Jakarta Sans'; font-style:normal; font-weight:800; font-display:swap; src:url('fonts/plus-jakarta-sans-latin-800-normal.woff2') format('woff2'); }
    body { font-family: 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif; margin: 0; padding: 24px; color: #1e293b; font-size: 13px; }
    h1 { font-family:'Plus Jakarta Sans', 'Segoe UI', Arial, sans-serif; font-weight:800; font-size: 20px; margin: 0 0 4px; } .sub { color: #64748b; font-size: 13px; margin-bottom: 20px; }
    .kpis { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .kpi { background: #f1f5f9; padding: 12px 16px; border-radius: 8px; min-width: 120px; }
    .kpi-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    .kpi-value { font-size: 18px; font-weight: 700; color: #1e293b; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
    th { background: #f8fafc; padding: 8px; text-align: left; border-bottom: 2px solid #e2e8f0; font-size: 11px; text-transform: uppercase; color: #64748b; }
    td { padding: 7px 8px; border-bottom: 1px solid #f1f5f9; }
    h2 { font-size: 14px; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; margin: 20px 0 10px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 2px solid #1e293b; padding-bottom: 12px; }
    .footer { margin-top: 32px; color: #94a3b8; font-size: 11px; text-align: center; }
    @media print { body { margin: 0; padding: 16px; } }
  </style></head><body>
  <div class="header">
    <div><h1>${d.name}</h1><div class="sub">${d.function||'—'} · CNH: ${d.cnh} Cat. ${d.cnhCat||'B'} (${cnhLabel}) · Tel: ${d.phone||'—'}</div></div>
    <div style="text-align:right;font-size:12px;color:#64748b;">Gerado em ${new Date().toLocaleDateString('pt-BR')}<br>${BRANDING().appName} — ${BRANDING().appSubtitle}</div>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="kpi-label">Atribuições</div><div class="kpi-value">${assignments.length}</div></div>
    <div class="kpi"><div class="kpi-label">Abastecimentos</div><div class="kpi-value">${fuels.length}</div></div>
    <div class="kpi"><div class="kpi-label">Custo Total</div><div class="kpi-value">${fmtCurrency(totalCost)}</div></div>
  </div>
  <h2>Histórico de Atribuições</h2>
  ${assignments.length ? `<table><thead><tr><th>Retirada</th><th>Devolução</th><th>Veículo</th><th>KM Inicial</th><th>KM Final</th><th>Percorrido</th><th>Destino</th></tr></thead><tbody>
  ${assignments.map(a=>`<tr><td>${fmtDate(a.date)}</td><td>${a.returnDate?fmtDate(a.returnDate):'Em uso'}</td><td>${a.vehiclePlate}</td><td>${a.kmStart.toLocaleString('pt-BR')} km</td><td>${a.kmEnd?a.kmEnd.toLocaleString('pt-BR')+' km':'—'}</td><td>${a.kmEnd&&a.kmStart?(a.kmEnd-a.kmStart).toLocaleString('pt-BR')+' km':'—'}</td><td>${a.obs||'—'}</td></tr>`).join('')}
  </tbody></table>` : '<p style="color:#94a3b8;font-size:12px">Nenhum registro.</p>'}
  <h2>Abastecimentos</h2>
  ${fuels.length ? `<table><thead><tr><th>Data</th><th>Veículo</th><th>Combustível</th><th>Litros</th><th>Custo</th><th>KM</th></tr></thead><tbody>
  ${fuels.map(f=>`<tr><td>${fmtDate(f.date)}</td><td>${f.vehiclePlate}</td><td>${f.fuelType}</td><td>${f.liters.toFixed(2)} L</td><td>${fmtCurrency(f.cost)}</td><td>${f.km.toLocaleString('pt-BR')} km</td></tr>`).join('')}
  </tbody></table>` : '<p style="color:#94a3b8;font-size:12px">Nenhum registro.</p>'}
  <div class="footer">${BRANDING().reportFooter || BRANDING().appName} — Ficha de Motorista · ${d.name} · Emitida em ${new Date().toLocaleString('pt-BR')}</div>
  <script>window.onload = () => window.print();</script>
  </body></html>`);
  win.document.close();
}

// ════════════════════════════════════════════════
// EXPORTAR PDF (relatório via print)
// ════════════════════════════════════════════════
function exportReportPDF() {
  const d = window._reportData;
  if (!d) { showToast('Gere um relatório primeiro', 'error'); return; }
  const sheet = document.getElementById('report-sheet');
  if (!sheet) return;
  const win = window.open('','_blank','width=1000,height=700');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Relatório</title>
  <style>
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:400 700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-ext-400-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:400; font-display:swap; src:url('fonts/ibm-plex-sans-latin-400-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-ext-700-normal.woff2') format('woff2'); }
    @font-face { font-family:'IBM Plex Sans'; font-style:normal; font-weight:700; font-display:swap; src:url('fonts/ibm-plex-sans-latin-700-normal.woff2') format('woff2'); }
    @font-face { font-family:'Plus Jakarta Sans'; font-style:normal; font-weight:800; font-display:swap; src:url('fonts/plus-jakarta-sans-latin-ext-800-normal.woff2') format('woff2'); }
    @font-face { font-family:'Plus Jakarta Sans'; font-style:normal; font-weight:800; font-display:swap; src:url('fonts/plus-jakarta-sans-latin-800-normal.woff2') format('woff2'); }
    body { font-family: 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif; margin: 0; padding: 24px; color: #1e293b; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 11px; }
    th { background: #f8fafc; padding: 7px; text-align: left; border-bottom: 2px solid #e2e8f0; font-size: 10px; text-transform: uppercase; color: #64748b; }
    td { padding: 6px 7px; border-bottom: 1px solid #f1f5f9; }
    .report-header { margin-bottom: 20px; border-bottom: 2px solid #1e293b; padding-bottom: 12px; }
    .report-vehicle-name { font-family:'Plus Jakarta Sans', 'Segoe UI', Arial, sans-serif; font-size: 18px; font-weight: 700; }
    .report-period { color: #64748b; margin: 4px 0 12px; }
    .report-kpis { display: flex; gap: 10px; flex-wrap: wrap; }
    .report-kpi { background: #f1f5f9; padding: 10px 14px; border-radius: 6px; }
    .report-kpi-label { font-size: 10px; color: #64748b; text-transform: uppercase; }
    .report-kpi-value { font-size: 16px; font-weight: 700; }
    .report-section { margin-bottom: 20px; }
    .report-section-title { font-size: 13px; font-weight: 700; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin-bottom: 10px; }
    .report-footer { margin-top: 32px; color: #94a3b8; font-size: 10px; text-align: center; }
    @media print { @page { margin: 1.5cm; } body { padding: 0; } }
  </style></head><body>
  ${sheet.innerHTML}
  <script>window.onload = () => { window.print(); }<\/script>
  </body></html>`);
  win.document.close();
}

// ════════════════════════════════════════════════
// RELATÓRIOS AVANÇADOS
// ════════════════════════════════════════════════
function renderAdvancedReports() {
  const el = document.getElementById('adv-reports-content');
  if (!el) return;

  const now = new Date();
  const currentYear  = now.getFullYear();
  const currentMonth = now.getMonth();

  // Build monthly cost data for last 12 months
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(currentYear, currentMonth - i, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`, label: d.toLocaleDateString('pt-BR',{month:'short',year:'2-digit'}) });
  }
  const monthlyCosts = months.map(m => {
    const fuel  = db.fuel.filter(r => r.date?.substring(0,7) === m.key).reduce((s,r)=>s+r.cost,0);
    const maint = db.maintenance.filter(r => r.date?.substring(0,7) === m.key).reduce((s,r)=>s+r.cost,0);
    const oil   = db.oil.filter(r => r.date?.substring(0,7) === m.key).reduce((s,r)=>s+r.cost,0);
    const liters = db.fuel.filter(r => r.date?.substring(0,7) === m.key).reduce((s,r)=>s+r.liters,0);
    return { ...m, fuel, maint, oil, total: fuel+maint+oil, liters };
  });

  // Per-vehicle cost+km
  const vehicleStats = db.vehicles.map(v => {
    const fuel   = db.fuel.filter(f => f.vehicleId === v.id).reduce((s,r)=>s+r.cost,0);
    const liters = db.fuel.filter(f => f.vehicleId === v.id).reduce((s,r)=>s+r.liters,0);
    const maint  = db.maintenance.filter(m => m.vehicleId === v.id).reduce((s,r)=>s+r.cost,0);
    const oil    = db.oil.filter(o => o.vehicleId === v.id).reduce((s,r)=>s+r.cost,0);
    const total  = fuel + maint + oil;
    const kmTotal = db.assignments.filter(a => a.vehicleId === v.id && a.kmStart).reduce((s,a) => {
      if (a.kmEnd) return s + (a.kmEnd - a.kmStart);
      if (v.km > a.kmStart) return s + (v.km - a.kmStart); // ainda em uso: estima pelo KM atual
      return s;
    }, 0);
    const costPerKm = kmTotal > 0 ? total / kmTotal : null;
    return { v, fuel, maint, oil, total, liters, kmTotal, costPerKm };
  }).sort((a,b) => b.total - a.total);

  // Month-over-month variation
  const lastMonthKey = months[months.length-2]?.key;
  const thisMonthKey = months[months.length-1]?.key;
  const lastMonthTotal = lastMonthKey ? monthlyCosts.find(m=>m.key===lastMonthKey)?.total || 0 : 0;
  const thisMonthTotal = thisMonthKey ? monthlyCosts.find(m=>m.key===thisMonthKey)?.total || 0 : 0;
  const variation = lastMonthTotal > 0 ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal * 100).toFixed(1) : null;
  const varLabel = variation !== null ? (parseFloat(variation) > 0 ? `▲ ${variation}%` : `▼ ${Math.abs(variation)}%`) : '—';
  const varColor = variation !== null ? (parseFloat(variation) > 0 ? '#EF4444' : '#22C55E') : 'inherit';

  // Avg cost per km overall
  const totalKmAll = vehicleStats.reduce((s,r)=>s+r.kmTotal,0);
  const totalCostAll = vehicleStats.reduce((s,r)=>s+r.total,0);
  const avgCostPerKm = totalKmAll > 0 ? (totalCostAll / totalKmAll) : null;

  const maxMonthly = Math.max(...monthlyCosts.map(m=>m.total), 1);

  el.innerHTML = `
  <div class="adv-kpis">
    <div class="adv-kpi">
      <div class="adv-kpi-label">Custo Total (12 meses)</div>
      <div class="adv-kpi-value">${fmtCurrency(totalCostAll)}</div>
    </div>
    <div class="adv-kpi">
      <div class="adv-kpi-label">Variação vs mês anterior</div>
      <div class="adv-kpi-value" style="color:${varColor}">${varLabel}</div>
    </div>
    <div class="adv-kpi">
      <div class="adv-kpi-label">Custo Médio / KM</div>
      <div class="adv-kpi-value">${avgCostPerKm !== null ? fmtCurrency(avgCostPerKm) : '—'}</div>
    </div>
    <div class="adv-kpi">
      <div class="adv-kpi-label">KM Total Rodado</div>
      <div class="adv-kpi-value">${totalKmAll.toLocaleString('pt-BR')} km</div>
    </div>
  </div>

  <div class="panel" style="margin-top:18px;">
    <div class="panel-header"><span class="panel-title">📊 Custos Mensais — Últimos 12 Meses</span></div>
    <div class="panel-body">
      <div style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Mês</th><th>Combustível</th><th>Manutenção</th><th>Óleo</th><th>Total</th><th>Litros</th><th>Barra</th></tr></thead>
          <tbody>
          ${monthlyCosts.map(m => {
            const pct = Math.round((m.total / maxMonthly) * 100);
            return `<tr>
              <td><strong>${m.label}</strong></td>
              <td style="color:#0891B2">${fmtCurrency(m.fuel)}</td>
              <td style="color:#CA8A04">${fmtCurrency(m.maint)}</td>
              <td style="color:#EA580C">${fmtCurrency(m.oil)}</td>
              <td><strong>${fmtCurrency(m.total)}</strong></td>
              <td>${m.liters.toFixed(1)} L</td>
              <td style="min-width:80px"><div style="height:8px;background:var(--bg-surface-3);border-radius:4px;"><div style="height:8px;background:var(--accent);border-radius:4px;width:${pct}%"></div></div></td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="panel" style="margin-top:14px;">
    <div class="panel-header"><span class="panel-title">🚗 Custo por Veículo + Custo/KM</span></div>
    <div class="panel-body">
      ${!vehicleStats.length ? emptyState('🚗','Sem veículos','Cadastre veículos para ver análise') : `
      <div style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Placa</th><th>Modelo</th><th>KM Rodado</th><th>Combustível</th><th>Manutenção</th><th>Óleo</th><th>Total</th><th>Custo/KM</th></tr></thead>
          <tbody>
          ${vehicleStats.map(r => `<tr>
            <td><strong>${r.v.plate}</strong></td>
            <td>${r.v.brand} ${r.v.model}</td>
            <td>${r.kmTotal.toLocaleString('pt-BR')} km</td>
            <td style="color:#0891B2">${fmtCurrency(r.fuel)}</td>
            <td style="color:#CA8A04">${fmtCurrency(r.maint)}</td>
            <td style="color:#EA580C">${fmtCurrency(r.oil)}</td>
            <td><strong>${fmtCurrency(r.total)}</strong></td>
            <td>${r.costPerKm !== null ? fmtCurrency(r.costPerKm)+'/km' : '—'}</td>
          </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
    </div>
  </div>`;
}

// ════════════════════════════════════════════════
// REPORTS
// ════════════════════════════════════════════════
function applyQuickPeriod() {
  const val = document.getElementById('r-period-quick')?.value;
  if (!val || val === 'custom') return;
  const now = new Date(); const y = now.getFullYear(); const m = now.getMonth();
  const pad = n => String(n).padStart(2,'0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  let from = '', to = fmt(now);
  if      (val === 'today')     { from = fmt(now); }
  else if (val === 'week')      { const d=new Date(now); d.setDate(d.getDate()-d.getDay()); from=fmt(d); }
  else if (val === 'month')     { from=`${y}-${pad(m+1)}-01`; }
  else if (val === 'lastmonth') { const lm=new Date(y,m,0); from=`${lm.getFullYear()}-${pad(lm.getMonth()+1)}-01`; to=fmt(lm); }
  else if (val === 'quarter')   { from=`${y}-${pad(Math.floor(m/3)*3+1)}-01`; }
  else if (val === 'year')      { from=`${y}-01-01`; }
  document.getElementById('r-date-from').value = from;
  document.getElementById('r-date-to').value   = to;
  buildReport();
}

function buildReport() {
  const vehicleId = document.getElementById('r-vehicle').value;
  const driverId  = document.getElementById('r-driver').value;
  const dateFrom  = document.getElementById('r-date-from').value;
  const dateTo    = document.getElementById('r-date-to').value;

  // at least one filter required
  if (!vehicleId && !dateFrom && !dateTo && !driverId) {
    document.getElementById('report-output').style.display = 'none';
    document.getElementById('r-print-btn').disabled = true;
    document.getElementById('r-csv-btn').disabled   = true;
    return;
  }

  const inRange = r => {
    const d = (r.date || '').substring(0,10);
    if (dateFrom && d < dateFrom) return false;
    if (dateTo   && d > dateTo)   return false;
    return true;
  };
  const byVehicle = r => !vehicleId || r.vehicleId === vehicleId || r.vehiclePlate === (db.vehicles.find(v=>v.id===vehicleId)?.plate);
  const byDriver  = r => !driverId  || r.driverId === driverId;

  const assignments = db.assignments.filter(r => byVehicle(r) && byDriver(r) && inRange(r));
  const fuels       = db.fuel.filter(r => byVehicle(r) && byDriver(r) && inRange(r));
  const maints      = db.maintenance.filter(r => byVehicle(r) && byDriver(r) && inRange(r));
  const oils        = db.oil.filter(r => byVehicle(r) && byDriver(r) && inRange(r));
  const pendingMaints = (db.scheduledMaintenance || []).filter(r => r.status !== 'concluida' && byVehicle(r));

  const tFuel   = fuels.reduce((s,r)=>s+r.cost,0);
  const tMaint  = maints.reduce((s,r)=>s+r.cost,0);
  const tOil    = oils.reduce((s,r)=>s+r.cost,0);
  const tCost   = tFuel+tMaint+tOil;
  const tLiters = fuels.reduce((s,r)=>s+r.liters,0);

  // KM Rodado: calculado automaticamente a partir das atribuições (cada retirada já registra
  // o KM inicial e final do veículo), sem necessidade de lançamento manual de KM diário.
  // Atribuições ainda EM USO (sem devolução) entram na conta estimando pelo KM atual do
  // veículo — mesma lógica já usada no Dashboard — senão o período fica com 0 km sempre que
  // o carro ainda não foi devolvido, mesmo já tendo rodado.
  const kmByVehicle = {};
  assignments.forEach(a => {
    if (!a.kmStart) return;
    const v = db.vehicles.find(x => x.id === a.vehicleId);
    let km = null;
    if (a.kmEnd) km = a.kmEnd - a.kmStart;
    else if (v && v.km > a.kmStart) km = v.km - a.kmStart; // ainda em uso: estimativa
    if (km === null) return;
    const key = a.vehicleId;
    if (!kmByVehicle[key]) kmByVehicle[key] = { vehiclePlate: a.vehiclePlate, vehicleModel: a.vehicleModel, km: 0, trips: 0 };
    kmByVehicle[key].km += km;
    kmByVehicle[key].trips += 1;
  });
  const kmRows = Object.entries(kmByVehicle).sort((a,b) => b[1].km - a[1].km).map(([vId, r]) => {
    const v = db.vehicles.find(x => x.id === vId);
    return `<tr><td>${r.vehiclePlate} — ${r.vehicleModel}</td><td>${r.trips}</td><td>${r.km.toLocaleString('pt-BR')} km</td><td>${v ? v.km.toLocaleString('pt-BR')+' km' : '—'}</td></tr>`;
  }).join('');
  const tKmRodado = Object.values(kmByVehicle).reduce((s,r) => s+r.km, 0);

  const vehicle   = vehicleId ? db.vehicles.find(v=>v.id===vehicleId) : null;
  const driver    = driverId  ? db.drivers.find(d=>d.id===driverId)  : null;
  const ico       = vehicle?.type==='moto' ? '🏍️' : '🚗';
  const titleVeh  = vehicle ? `${ico} ${vehicle.plate} — ${vehicle.brand} ${vehicle.model}` : 'Todos os veículos';
  const titleDrv  = driver  ? ` · ${driver.name}` : '';
  const period    = dateFrom||dateTo
    ? `${dateFrom?fmtDate(dateFrom):'início'} até ${dateTo?fmtDate(dateTo):'hoje'}`
    : 'Período completo';

  const mkTable = (cols, rows, empty) => rows.length
    ? `<div style="overflow-x:auto;"><table class="data-table"><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="report-empty">${empty}</p>`;

  const assignRows = assignments.map(a=>`<tr><td>${fmtDate(a.date)}</td><td>${a.returnDate?fmtDate(a.returnDate):'—'}</td><td>${a.driverName}</td><td>${a.vehiclePlate}</td><td>${a.kmStart.toLocaleString('pt-BR')} km</td><td>${a.kmEnd?a.kmEnd.toLocaleString('pt-BR')+' km':'—'}</td><td>${a.kmEnd&&a.kmStart?(a.kmEnd-a.kmStart).toLocaleString('pt-BR')+' km':'—'}</td><td>${a.obs||'—'}</td></tr>`).join('');
  const fuelRows   = fuels.map(f=>`<tr><td>${fmtDate(f.date)}</td><td>${f.driverName}</td><td>${f.vehiclePlate}</td><td>${f.fuelType||'—'}</td><td>${f.liters.toFixed(2)} L</td><td>${fmtCurrency(f.cost)}</td><td>${f.liters?fmtCurrency(f.cost/f.liters,3):'—'}</td><td>${f.km.toLocaleString('pt-BR')} km</td><td>${f.station||'—'}</td></tr>`).join('');
  const maintRows  = maints.map(m=>`<tr><td>${fmtDate(m.date)}</td><td>${m.vehiclePlate}</td><td>${m.type}</td><td>${m.description}</td><td>${m.driverName}</td><td>${m.km.toLocaleString('pt-BR')} km</td><td>${fmtCurrency(m.cost)}</td>${m.workshop?`<td>${m.workshop}</td>`:'<td>—</td>'}</tr>`).join('');
  const oilRows    = oils.map(o=>`<tr><td>${fmtDate(o.date)}</td><td>${o.vehiclePlate}</td><td>${o.oilType}${o.viscosity?' ('+o.viscosity+')':''}</td><td>${o.brand||'—'}</td><td>${o.driverName}</td><td>${o.km.toLocaleString('pt-BR')} km</td><td>${o.nextKm.toLocaleString('pt-BR')} km</td><td>${fmtCurrency(o.cost)}</td></tr>`).join('');

  document.getElementById('report-sheet').innerHTML = `
    <div class="report-header">
      <div class="report-vehicle-name">${titleVeh}${titleDrv}</div>
      <div class="report-period">Período: ${period}</div>
      <div class="report-kpis">
        <div class="report-kpi"><div class="report-kpi-label">Custo Total</div><div class="report-kpi-value">${fmtCurrency(tCost)}</div></div>
        <div class="report-kpi"><div class="report-kpi-label">Combustível</div><div class="report-kpi-value">${fmtCurrency(tFuel)}</div></div>
        <div class="report-kpi"><div class="report-kpi-label">Manutenções</div><div class="report-kpi-value">${fmtCurrency(tMaint)}</div></div>
        <div class="report-kpi"><div class="report-kpi-label">Troca de Óleo</div><div class="report-kpi-value">${fmtCurrency(tOil)}</div></div>
        <div class="report-kpi"><div class="report-kpi-label">Total Litros</div><div class="report-kpi-value">${tLiters.toFixed(2)} L</div></div>
        <div class="report-kpi"><div class="report-kpi-label">Nº Atribuições</div><div class="report-kpi-value">${assignments.length}</div></div>
        <div class="report-kpi"><div class="report-kpi-label">KM Rodado</div><div class="report-kpi-value">${tKmRodado.toLocaleString('pt-BR')} km</div></div>
      </div>
    </div>
    <div class="report-section"><div class="report-section-title">📍 KM Rodado por Veículo (calculado automaticamente pelas retiradas)</div>
      ${mkTable(['Veículo','Nº de Retiradas c/ KM','KM Percorrido no Período','KM Atual do Veículo'],kmRows,'Nenhuma retirada com KM inicial/final registrada no período.')}
    </div>
    <div class="report-section"><div class="report-section-title">🔑 Atribuições (${assignments.length})</div>
      ${mkTable(['Retirada','Devolução','Motorista','Veículo','KM Inicial','KM Final','Percorrido','Destino'],assignRows,'Nenhuma atribuição no período.')}
    </div>
    <div class="report-section"><div class="report-section-title">⛽ Abastecimentos (${fuels.length})</div>
      ${mkTable(['Data','Motorista','Veículo','Combustível','Litros','Custo','Preço/L','KM','Posto'],fuelRows,'Nenhum abastecimento no período.')}
    </div>
    <div class="report-section"><div class="report-section-title">🔧 Manutenções (${maints.length})</div>
      ${mkTable(['Data','Veículo','Tipo','Descrição','Responsável','KM','Custo','Oficina'],maintRows,'Nenhuma manutenção no período.')}
    </div>
    <div class="report-section"><div class="report-section-title">🗓️ Manutenções Programadas Pendentes (${pendingMaints.length})</div>
      ${mkTable(['Veículo','Tipo','Prioridade','Serviço','Data Prevista','KM Previsto'],pendingMaints.map(s=>`<tr><td>${s.vehiclePlate}</td><td>${s.type||'—'}</td><td>${s.priority||'—'}</td><td>${s.description||'—'}</td><td>${s.dueDate?fmtDate(s.dueDate):'—'}</td><td>${s.dueKm?s.dueKm.toLocaleString('pt-BR')+' km':'—'}</td></tr>`).join(''),'Nenhuma manutenção programada pendente.')}
    </div>
    <div class="report-section"><div class="report-section-title">🛢️ Trocas de Óleo (${oils.length})</div>
      ${mkTable(['Data','Veículo','Tipo','Marca','Responsável','KM','Próxima KM','Custo'],oilRows,'Nenhuma troca de óleo no período.')}
    </div>
    <div class="report-footer">Gerado em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR')} · ${BRANDING().appName} — ${BRANDING().appSubtitle}</div>`;

  document.getElementById('report-output').style.display = 'block';
  document.getElementById('r-print-btn').disabled = false;
  document.getElementById('r-csv-btn').disabled   = false;
  const pdfBtn = document.getElementById('r-pdf-btn'); if (pdfBtn) pdfBtn.disabled = false;

  // Store for CSV export
  window._reportData = { assignments, fuels, maints, oils, pendingMaints, tFuel, tMaint, tOil, tCost, tLiters, period, titleVeh, titleDrv, kmByVehicle, tKmRodado };
}

function printReport() { window.print(); }

function exportReportCSV() {
  const d = window._reportData; if (!d) return;
  const sep = ';';
  const rows = [
    [`${BRANDING().appName} — Relatório de Frota`],
    [`${d.titleVeh}${d.titleDrv} · ${d.period}`],
    [`Gerado em: ${new Date().toLocaleString('pt-BR')}`],
    [],
    ['RESUMO'],
    ['Custo Total',fmtCurrency(d.tCost)],
    ['Combustível',fmtCurrency(d.tFuel)],
    ['Manutenções',fmtCurrency(d.tMaint)],
    ['Óleo',fmtCurrency(d.tOil)],
    ['Total Litros',d.tLiters.toFixed(2)+' L'],
    ['KM Rodado',d.tKmRodado.toLocaleString('pt-BR')+' km'],
    [],
    ['KM RODADO POR VEÍCULO'],
    ['Veículo','Nº de Retiradas c/ KM','KM Percorrido no Período'],
    ...Object.values(d.kmByVehicle||{}).map(r=>[`${r.vehiclePlate} — ${r.vehicleModel}`,r.trips,r.km]),
    [],
    ['ATRIBUIÇÕES'],
    ['Retirada','Devolução','Motorista','Veículo','KM Inicial','KM Final','Percorrido','Destino'],
    ...d.assignments.map(a=>[fmtDate(a.date),a.returnDate?fmtDate(a.returnDate):'—',a.driverName,a.vehiclePlate,a.kmStart,a.kmEnd||'',a.kmEnd&&a.kmStart?a.kmEnd-a.kmStart:'—',a.obs||'']),
    [],
    ['ABASTECIMENTOS'],
    ['Data','Motorista','Veículo','Combustível','Litros','Custo','Preço/L','KM','Posto'],
    ...d.fuels.map(f=>[fmtDate(f.date),f.driverName,f.vehiclePlate,f.fuelType||'',f.liters.toFixed(2),f.cost.toFixed(2),f.liters?(f.cost/f.liters).toFixed(3):'',f.km,f.station||'']),
    [],
    ['MANUTENÇÕES'],
    ['Data','Veículo','Tipo','Descrição','Responsável','KM','Custo','Oficina'],
    ...d.maints.map(m=>[fmtDate(m.date),m.vehiclePlate,m.type,m.description,m.driverName,m.km,m.cost.toFixed(2),m.workshop||'']),
    [],
    ['MANUTENÇÕES PROGRAMADAS PENDENTES'],
    ['Veículo','Tipo','Prioridade','Serviço','Data Prevista','KM Previsto'],
    ...(d.pendingMaints||[]).map(s=>[s.vehiclePlate,s.type||'',s.priority||'',s.description||'',s.dueDate?fmtDate(s.dueDate):'',s.dueKm||'']),
    [],
    ['TROCAS DE ÓLEO'],
    ['Data','Veículo','Tipo','Viscosidade','Marca','Responsável','KM','Próxima KM','Custo'],
    ...d.oils.map(o=>[fmtDate(o.date),o.vehiclePlate,o.oilType,o.viscosity||'',o.brand||'',o.driverName,o.km,o.nextKm,o.cost.toFixed(2)]),
  ];
  const csv = rows.map(r => Array.isArray(r) ? r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(sep) : '').join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8;' }));
  a.download = `frotactl_frota_${Date.now()}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
  showToast('CSV exportado!', 'success');
}

// ════════════════════════════════════════════════
// BRIEFCASE CRUD
// ════════════════════════════════════════════════
let _briefcaseTools = []; // temp tool list while editing

function addBriefcaseTool() {
  const inp = document.getElementById('bc-tool-input');
  const name = inp.value.trim();
  if (!name) return;
  _briefcaseTools.push({ id: uid(), name });
  inp.value = '';
  renderBriefcaseToolList();
}

function removeBriefcaseTool(id) {
  _briefcaseTools = _briefcaseTools.filter(t => t.id !== id);
  renderBriefcaseToolList();
}

function renderBriefcaseToolList() {
  const el = document.getElementById('bc-tools-list');
  if (!el) return;
  if (!_briefcaseTools.length) {
    el.innerHTML = '<div class="bc-tools-empty">Nenhuma ferramenta adicionada</div>';
    return;
  }
  el.innerHTML = _briefcaseTools.map(t =>
    `<div class="bc-tool-chip">${t.name}<button type="button" class="bc-tool-remove" onclick="removeBriefcaseTool('${t.id}')">✕</button></div>`
  ).join('');
}

function submitBriefcase(e) {
  e.preventDefault();
  const btn    = document.getElementById('bc-submit-btn');
  const editId = btn.dataset.editId;
  const name   = document.getElementById('bc-name').value.trim();
  const driver = db.drivers.find(d => d.id === document.getElementById('bc-assigned-driver').value);
  const record = {
    id:        editId || uid(),
    name,
    code:      document.getElementById('bc-code').value.trim(),
    assignedDriverId: driver?.id || null,
    assignedDriverName: driver?.name || null,
    tools:     [..._briefcaseTools],
    obs:       document.getElementById('bc-obs').value.trim(),
    forceResignRequestedAt: editId ? (db.briefcases.find(b => b.id === editId)?.forceResignRequestedAt || null) : null,
    empresaId: editId ? (db.briefcases.find(b => b.id === editId)?.empresaId ?? currentEmpresaId()) : currentEmpresaId(),
    createdAt: editId ? (db.briefcases.find(b => b.id === editId)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
  };
  const isNew = !editId;
  if (editId) {
    dbFull.briefcases = dbFull.briefcases.map(b => b.id === editId ? record : b);
    showToast('Maleta atualizada!', 'success');
    delete btn.dataset.editId; btn.textContent = 'Cadastrar Maleta';
    document.getElementById('bc-form-title').textContent = 'Nova Maleta';
  } else {
    dbFull.briefcases.push(record);
    showToast('Maleta cadastrada! Gerando PDF de conferência para assinatura...', 'success');
  }
  saveDB(); resetBriefcaseForm(); renderBriefcaseList(); populateBriefcaseSelects(); populateNewModuleSelects();
  if (isNew && record.tools.length) printBriefcaseChecklist(record.id);
}

function resetBriefcaseForm() {
  document.getElementById('briefcase-form').reset();
  _briefcaseTools = [];
  renderBriefcaseToolList();
  const btn = document.getElementById('bc-submit-btn');
  delete btn.dataset.editId; btn.textContent = 'Cadastrar Maleta';
  document.getElementById('bc-form-title').textContent = 'Nova Maleta';
}

function editBriefcase(id) {
  const b = db.briefcases.find(b => b.id === id); if (!b) return;
  switchPage('briefcases', document.querySelector('[data-page="briefcases"]'));
  document.getElementById('bc-name').value = b.name;
  document.getElementById('bc-code').value = b.code || '';
  document.getElementById('bc-assigned-driver').value = b.assignedDriverId || '';
  document.getElementById('bc-obs').value  = b.obs  || '';
  _briefcaseTools = (b.tools || []).map(t => ({ ...t }));
  renderBriefcaseToolList();
  const btn = document.getElementById('bc-submit-btn');
  btn.dataset.editId = id; btn.textContent = 'Salvar Alterações';
  document.getElementById('bc-form-title').textContent = 'Editar Maleta';
  scrollMainContent(0);
}

function deleteBriefcase(id) {
  confirmDialog('Excluir esta maleta?', () => {
    dbFull.briefcases = dbFull.briefcases.filter(b => b.id !== id);
    saveDB(); renderBriefcaseList(); populateBriefcaseSelects(); populateNewModuleSelects();
    showToast('Maleta excluída.', 'success');
  });
}

function renderBriefcaseList() {
  const el = document.getElementById('briefcase-list');
  if (!db.briefcases.length) { el.innerHTML = emptyState('🧰','Nenhuma maleta cadastrada','Preencha o formulário acima'); return; }
  el.innerHTML = '<div class="panel"><div class="record-list">' + db.briefcases.map(b => {
    const toolsHtml = (b.tools || []).length
      ? `<span style="grid-column:1/-1"><strong>Ferramentas (${b.tools.length}):</strong> ${b.tools.map(t => t.name).join(', ')}</span>`
      : '';
    // Pega a devolução mais recente desta maleta para avisar, aqui mesmo no cadastro,
    // se ficou algum item sem devolver da última vez.
    const lastReturn = [...(db.briefcaseReturns || [])]
      .filter(r => r.briefcaseId === b.id)
      .sort((a,b2) => new Date(b2.date) - new Date(a.date))[0];
    const missingFromLastReturn = lastReturn ? (lastReturn.checklist || []).filter(t => !t.returned) : [];
    const missingHtml = missingFromLastReturn.length
      ? `<div style="grid-column:1/-1;">
          <strong style="color:var(--danger)">⚠ Não devolvido (${lastReturn.driverName}, ${fmtDate(lastReturn.date)}):</strong>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
            ${missingFromLastReturn.map(t => `
              <span class="missing-item-chip">
                ${t.name}
                <button type="button" class="btn-inline-link" title="Marcar como comprado novamente" onclick="resolveMissingItem('return','${lastReturn.id}','${t.id}','Comprado novamente')">🛒</button>
                <button type="button" class="btn-inline-link" title="Marcar como encontrado" onclick="resolveMissingItem('return','${lastReturn.id}','${t.id}','Item encontrado')">🔍</button>
              </span>`).join('')}
          </div>
        </div>`
      : '';
    const responsavelHtml = b.assignedDriverId
      ? b.assignedDriverName
      : `<span class="badge badge-green" style="margin-left:0;">Maleta disponível</span>`;
    return `<div class="record-item">
      <div class="record-stripe stripe-orange"></div>
      <div class="record-body">
        <div class="record-title-row"><span class="badge badge-orange">MALETA</span><span class="record-name">🧰 ${b.code ? b.code + ' — ' : ''}${b.name}</span></div>
        <div class="record-meta">
          ${b.code ? `<span><strong>Código:</strong> ${b.code}</span>` : ''}
          <span><strong>Responsável:</strong> ${responsavelHtml}</span>
          <span><strong>Qtd. Ferramentas:</strong> ${(b.tools||[]).length}</span>
          ${b.obs ? `<span><strong>Obs:</strong> ${b.obs}</span>` : ''}
          ${toolsHtml}
          ${missingHtml}
        </div>
      </div>
      <div class="record-actions">
        <button class="btn btn-ghost btn-sm" onclick="printBriefcaseChecklist('${b.id}')">📄 PDF de Conferência</button>
        <button class="btn btn-edit btn-sm" onclick="editBriefcase('${b.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteBriefcase('${b.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('') + '</div></div>';
}

// ════════════════════════════════════════════════
// BRIEFCASE RETURN CRUD
// ════════════════════════════════════════════════
function loadBriefcaseChecklist() {
  const briefcaseId = document.getElementById('br-briefcase').value;
  const el = document.getElementById('br-checklist');
  if (!briefcaseId) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:0.82rem;">Selecione uma maleta para ver o checklist de ferramentas</span>';
    return;
  }
  const briefcase = db.briefcases.find(b => b.id === briefcaseId);
  if (!briefcase || !briefcase.tools || !briefcase.tools.length) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:0.82rem;">Esta maleta não possui ferramentas cadastradas.</span>';
    return;
  }
  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;">` +
    briefcase.tools.map(t =>
      `<label style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;font-size:0.84rem;">
        <input type="checkbox" data-tool-id="${t.id}" data-tool-name="${t.name.replace(/"/g,'&quot;')}" checked style="width:16px;height:16px;accent-color:var(--success);">
        ${t.name}
      </label>`
    ).join('') + `</div>`;
}

function submitBriefcaseReturn(e) {
  e.preventDefault();
  const briefcaseId = document.getElementById('br-briefcase').value;
  const driverId    = document.getElementById('br-driver').value;
  const briefcase   = db.briefcases.find(b => b.id === briefcaseId);
  const driver      = db.drivers.find(d => d.id === driverId);
  if (!briefcase || !driver) { showToast('Maleta ou técnico inválido', 'error'); return; }

  const checklist = [];
  document.querySelectorAll('#br-checklist input[type="checkbox"]').forEach(chk => {
    checklist.push({ id: chk.dataset.toolId, name: chk.dataset.toolName, returned: chk.checked });
  });

  const record = {
    id:            uid(),
    briefcaseId,
    briefcaseName: `${briefcase.code ? briefcase.code + ' — ' : ''}${briefcase.name}`,
    driverId,
    driverName:    driver.name,
    date:          document.getElementById('br-date').value,
    checklist,
    missing:       document.getElementById('br-missing').value.trim(),
    createdAt:     new Date().toISOString(),
  };
  if (!db.briefcaseReturns) db.briefcaseReturns = [];
  record.empresaId = currentEmpresaId();
  dbFull.briefcaseReturns.push(record);
  // Devolução final: libera a maleta (fica disponível) para ser atribuída a outro técnico.
  if (briefcase.assignedDriverId === driverId) {
    dbFull.briefcases = dbFull.briefcases.map(b => b.id === briefcaseId ? { ...b, assignedDriverId: null, assignedDriverName: null } : b);
  }
  saveDB(); resetBriefcaseReturnForm(); renderBriefcaseReturnList(); renderBriefcaseList();
  showToast('Devolução final registrada! A maleta continua cadastrada e ficou disponível.', 'success');
}

function resetBriefcaseReturnForm() {
  document.getElementById('briefcase-return-form').reset();
  document.getElementById('br-date').valueAsDate = new Date();
  document.getElementById('br-checklist').innerHTML = '<span style="color:var(--text-muted);font-size:0.82rem;">Selecione uma maleta para ver o checklist de ferramentas</span>';
}

function deleteBriefcaseReturn(id) {
  confirmDialog('Excluir registro de devolução?', () => {
    dbFull.briefcaseReturns = (dbFull.briefcaseReturns || []).filter(r => r.id !== id);
    saveDB(); renderBriefcaseReturnList(); renderBriefcaseList();
    showToast('Registro excluído.', 'success');
  });
}

function renderBriefcaseReturnList() {
  const el  = document.getElementById('briefcase-return-list');
  const s   = (document.getElementById('br-search')?.value || '').toLowerCase();
  const from = document.getElementById('br-date-from')?.value || '';
  const to   = document.getElementById('br-date-to')?.value   || '';
  updateFilterBarState('br', (s?1:0) + (from?1:0) + (to?1:0));
  let items = [...(db.briefcaseReturns || [])].sort((a,b) => new Date(b.date) - new Date(a.date));
  if (s) items = items.filter(r => `${r.briefcaseName} ${r.driverName}`.toLowerCase().includes(s));
  if (from) items = items.filter(r => r.date >= from);
  if (to)   items = items.filter(r => r.date <= to);
  if (!items.length) { el.innerHTML = emptyState('📦','Nenhuma devolução registrada','Registre devoluções de maleta acima'); return; }
  el.innerHTML = '<div class="panel"><div class="record-list">' + items.map(r => {
    const totalTools    = r.checklist ? r.checklist.length : 0;
    const returnedTools = r.checklist ? r.checklist.filter(t => t.returned).length : 0;
    const missingTools  = r.checklist ? r.checklist.filter(t => !t.returned) : [];
    const allOk = totalTools > 0 && returnedTools === totalTools;
    const checkBadge = totalTools === 0 ? '' :
      allOk ? `<span class="badge badge-green">✓ ${returnedTools}/${totalTools} ferramentas</span>` :
               `<span class="badge badge-red">⚠ ${returnedTools}/${totalTools} devolvidas</span>`;
    const missingHtml = missingTools.length ? `
      <div style="grid-column:1/-1;">
        <strong style="color:var(--danger)">Faltando:</strong>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
          ${missingTools.map(t => `
            <span class="missing-item-chip">
              ${t.name}
              <button type="button" class="btn-inline-link" title="Marcar como comprado novamente" onclick="resolveMissingItem('return','${r.id}','${t.id}','Comprado novamente')">🛒</button>
              <button type="button" class="btn-inline-link" title="Marcar como encontrado" onclick="resolveMissingItem('return','${r.id}','${t.id}','Item encontrado')">🔍</button>
            </span>`).join('')}
        </div>
      </div>` : '';
    return `<div class="record-item">
      <div class="record-stripe stripe-orange"></div>
      <div class="record-body">
        <div class="record-title-row"><span class="badge badge-orange">DESLIGAMENTO</span>${checkBadge}<span class="record-name">🧰 ${r.briefcaseName}</span></div>
        <div class="record-meta">
          <span><strong>Técnico:</strong> ${r.driverName}</span>
          <span><strong>Data:</strong> ${fmtDate(r.date)}</span>
          ${missingHtml}
          ${r.missing ? `<span style="grid-column:1/-1"><strong>Obs:</strong> ${r.missing}</span>` : ''}
        </div>
      </div>
      <div class="record-actions">
        <button class="btn btn-danger btn-sm" onclick="deleteBriefcaseReturn('${r.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('') + '</div></div>';
}

// ════════════════════════════════════════════════
// INSPECTION CRUD
// ════════════════════════════════════════════════
const INS_CHECKS = [
  { id:'pneus',      label:'🛞 Pneus OK' },
  { id:'lataria',    label:'🚗 Lataria sem danos' },
  { id:'limpeza',    label:'🧹 Limpeza interna' },
  { id:'vidros',     label:'🔲 Vidros intactos' },
  { id:'farois',     label:'💡 Faróis funcionando' },
  { id:'retrovisor', label:'🔄 Retrovisores OK' },
  { id:'macaco',     label:'🔧 Macaco / triângulo' },
  { id:'extintor',   label:'🧯 Extintor válido' },
];

function submitInspection(e) {
  e.preventDefault();
  const vehicleId = document.getElementById('ins-vehicle').value;
  const driverId  = document.getElementById('ins-driver').value;
  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  const driver    = db.drivers.find(d => d.id === driverId);
  if (!vehicle || !driver) { showToast('Veículo ou responsável inválido', 'error'); return; }
  const checks = {};
  INS_CHECKS.forEach(c => { checks[c.id] = document.getElementById('ins-' + c.id)?.checked || false; });
  const km = parseKmInput('ins-km');
  const record = {
    id:           uid(),
    vehicleId, vehiclePlate: vehicle.plate, vehicleModel: `${vehicle.brand} ${vehicle.model}`,
    driverId, driverName: driver.name,
    type:         document.getElementById('ins-type').value,
    datetime:     document.getElementById('ins-datetime').value,
    km,
    fuelLevel:    document.getElementById('ins-fuel-level').value,
    checks,
    obs:          document.getElementById('ins-obs').value.trim(),
    createdAt:    new Date().toISOString(),
  };
  // Update vehicle km
  dbFull.vehicles = dbFull.vehicles.map(v => v.id === vehicleId ? { ...v, km: Math.max(v.km, km) } : v);
  if (!db.inspections) db.inspections = [];
  record.empresaId = currentEmpresaId();
  dbFull.inspections.push(record);
  saveDB(); resetInspectionForm(); renderInspectionList();
  showToast('Vistoria registrada!', 'success');
}

function resetInspectionForm() {
  document.getElementById('inspection-form').reset();
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0,16);
  document.getElementById('ins-datetime').value = local;
  INS_CHECKS.forEach(c => { const el = document.getElementById('ins-' + c.id); if (el) el.checked = true; });
}

function deleteInspection(id) {
  confirmDialog('Excluir vistoria?', () => {
    dbFull.inspections = (dbFull.inspections || []).filter(r => r.id !== id);
    saveDB(); renderInspectionList();
    showToast('Vistoria excluída.', 'success');
  });
}

function renderInspectionList() {
  const el   = document.getElementById('inspection-list');
  const s    = (document.getElementById('ins-search')?.value || '').toLowerCase();
  const tf   = document.getElementById('ins-type-filter')?.value || '';
  const from = document.getElementById('ins-date-from')?.value || '';
  const to   = document.getElementById('ins-date-to')?.value   || '';
  let items = [...(db.inspections || [])].sort((a,b) => new Date(b.datetime) - new Date(a.datetime));
  if (s)  items = items.filter(r => `${r.vehiclePlate} ${r.vehicleModel} ${r.driverName}`.toLowerCase().includes(s));
  if (tf) items = items.filter(r => r.type === tf);
  if (from) items = items.filter(r => (r.datetime || '').substring(0,10) >= from);
  if (to)   items = items.filter(r => (r.datetime || '').substring(0,10) <= to);
  if (!items.length) { el.innerHTML = emptyState('🛡️','Nenhuma vistoria registrada','Registre a primeira vistoria acima'); return; }
  el.innerHTML = '<div class="panel"><div class="record-list">' + items.map(r => {
    const failedChecks = r.checks ? INS_CHECKS.filter(c => !r.checks[c.id]).map(c => c.label) : [];
    const checkBadge   = failedChecks.length === 0
      ? '<span class="badge badge-green">✓ Todos OK</span>'
      : `<span class="badge badge-red">⚠ ${failedChecks.length} item(s) com problema</span>`;
    const typeBadge = r.type === 'retirada'
      ? '<span class="badge badge-blue">RETIRADA</span>'
      : '<span class="badge badge-purple">DEVOLUÇÃO</span>';
    const dt = r.datetime ? new Date(r.datetime).toLocaleString('pt-BR') : '—';
    return `<div class="record-item">
      <div class="record-stripe" style="background:${r.type === 'retirada' ? 'var(--accent)' : 'var(--purple)'}"></div>
      <div class="record-body">
        <div class="record-title-row">${typeBadge}${checkBadge}<span class="record-name">${r.vehiclePlate} — ${r.vehicleModel}</span></div>
        <div class="record-meta">
          <span><strong>Data/Hora:</strong> ${dt}</span>
          <span><strong>Responsável:</strong> ${r.driverName}</span>
          <span><strong>KM:</strong> ${r.km.toLocaleString('pt-BR')} km</span>
          <span><strong>Combustível:</strong> ${r.fuelLevel || '—'}</span>
          ${failedChecks.length ? `<span style="grid-column:1/-1;color:var(--danger)"><strong>Problemas:</strong> ${failedChecks.join(', ')}</span>` : ''}
          ${r.obs ? `<span style="grid-column:1/-1"><strong>Obs:</strong> ${r.obs}</span>` : ''}
        </div>
      </div>
      <div class="record-actions">
        <button class="btn btn-danger btn-sm" onclick="deleteInspection('${r.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('') + '</div></div>';
}

// ════════════════════════════════════════════════
// SCHEDULE CRUD
// ════════════════════════════════════════════════
function toggleScheduleLoanFields() {
  const isLoan     = document.getElementById('sch-is-loan')?.checked;
  const driverField = document.getElementById('sch-driver-field');
  const nameField   = document.getElementById('sch-loan-name-field');
  const cpfField    = document.getElementById('sch-loan-cpf-field');
  const driverSel   = document.getElementById('sch-driver');
  const nameInp     = document.getElementById('sch-loan-name');
  const cpfInp      = document.getElementById('sch-loan-cpf');
  if (isLoan) {
    driverField.style.display = 'none';
    nameField.style.display   = '';
    cpfField.style.display    = '';
    driverSel.required = false; driverSel.value = '';
    nameInp.required = true; cpfInp.required = true;
  } else {
    driverField.style.display = '';
    nameField.style.display   = 'none';
    cpfField.style.display    = 'none';
    driverSel.required = true;
    nameInp.required = false; cpfInp.required = false;
    nameInp.value = ''; cpfInp.value = '';
  }
}

function checkScheduleConflict() {
  const vehicleId  = document.getElementById('sch-vehicle')?.value;
  const dateStart  = document.getElementById('sch-date-start')?.value;
  const dateEnd    = document.getElementById('sch-date-end')?.value;
  const conflictBox = document.getElementById('sch-conflict-box');
  const conflictMsg = document.getElementById('sch-conflict-msg');
  if (!vehicleId || !dateStart || !dateEnd || !conflictBox) return;
  // Check overlaps in active schedules
  const conflicts = (db.schedules || []).filter(s =>
    s.vehicleId === vehicleId &&
    s.status !== 'cancelada' &&
    s.dateStart <= dateEnd &&
    s.dateEnd >= dateStart
  );
  if (conflicts.length) {
    const v = db.vehicles.find(v => v.id === vehicleId);
    conflictMsg.textContent = `⚠️ Conflito: ${v ? v.plate : 'Veículo'} já reservado de ${fmtDate(conflicts[0].dateStart)} a ${fmtDate(conflicts[0].dateEnd)} para ${conflicts[0].driverName}.`;
    conflictBox.style.display = 'block';
  } else {
    conflictBox.style.display = 'none';
  }
}

function submitSchedule(e) {
  e.preventDefault();
  const vehicleId = document.getElementById('sch-vehicle').value;
  const vehicle   = db.vehicles.find(v => v.id === vehicleId);
  const isLoan    = document.getElementById('sch-is-loan')?.checked;

  let driverId = '', driverName = '', loanName = '', loanCpf = '';
  if (isLoan) {
    loanName = document.getElementById('sch-loan-name').value.trim();
    loanCpf  = document.getElementById('sch-loan-cpf').value.trim();
    if (!loanName || !loanCpf) { showToast('Informe nome e CPF de quem vai usar o veículo', 'error'); return; }
    driverName = loanName;
  } else {
    driverId = document.getElementById('sch-driver').value;
    const driver = db.drivers.find(d => d.id === driverId);
    if (!driver) { showToast('Veículo ou motorista inválido', 'error'); return; }
    driverName = driver.name;
  }
  if (!vehicle) { showToast('Veículo ou motorista inválido', 'error'); return; }

  const dateStart = document.getElementById('sch-date-start').value;
  const dateEnd   = document.getElementById('sch-date-end').value;
  if (dateEnd < dateStart) { showToast('Data de término deve ser igual ou após a data de início', 'error'); return; }
  // Conflict check (warn but allow)
  const conflicts = (db.schedules || []).filter(s =>
    s.vehicleId === vehicleId && s.status !== 'cancelada' &&
    s.dateStart <= dateEnd && s.dateEnd >= dateStart
  );
  if (conflicts.length && !confirm(`Este veículo já tem reserva de ${fmtDate(conflicts[0].dateStart)} a ${fmtDate(conflicts[0].dateEnd)}. Confirmar mesmo assim?`)) return;
  const record = {
    id:           uid(),
    vehicleId, vehiclePlate: vehicle.plate, vehicleModel: `${vehicle.brand} ${vehicle.model}`,
    driverId, driverName,
    isLoan:       !!isLoan,
    loanCpf:      isLoan ? loanCpf : '',
    dateStart, dateEnd,
    obs:          document.getElementById('sch-obs').value.trim(),
    status:       'pendente',
    createdAt:    new Date().toISOString(),
  };
  if (!db.schedules) db.schedules = [];
  record.empresaId = currentEmpresaId();
  dbFull.schedules.push(record);
  saveDB(); resetScheduleForm(); renderScheduleList();
  showToast('Reserva registrada!', 'success');
}

function resetScheduleForm() {
  document.getElementById('schedule-form').reset();
  document.getElementById('sch-conflict-box').style.display = 'none';
  toggleScheduleLoanFields();
}

function cancelSchedule(id) {
  confirmDialog('Cancelar esta reserva?', () => {
    dbFull.schedules = (dbFull.schedules || []).map(s => s.id === id ? { ...s, status: 'cancelada' } : s);
    saveDB(); renderScheduleList();
    showToast('Reserva cancelada.', 'success');
  });
}

function concludeSchedule(id) {
  dbFull.schedules = (dbFull.schedules || []).map(s => s.id === id ? { ...s, status: 'concluida' } : s);
  saveDB(); renderScheduleList();
  showToast('Reserva marcada como concluída!', 'success');
}

function deleteSchedule(id) {
  confirmDialog('Excluir esta reserva?', () => {
    dbFull.schedules = (dbFull.schedules || []).filter(s => s.id !== id);
    saveDB(); renderScheduleList();
    showToast('Reserva excluída.', 'success');
  });
}

function renderScheduleList() {
  const el  = document.getElementById('schedule-list');
  const s   = (document.getElementById('sch-search')?.value || '').toLowerCase();
  const sf  = document.getElementById('sch-status-filter')?.value || '';
  updateFilterBarState('sch', (s?1:0) + (sf?1:0));
  const today = new Date().toISOString().substring(0,10);
  let items = [...(db.schedules || [])].sort((a,b) => new Date(a.dateStart) - new Date(b.dateStart));
  if (s)  items = items.filter(r => `${r.vehiclePlate} ${r.vehicleModel} ${r.driverName} ${r.obs} ${r.loanCpf||''}`.toLowerCase().includes(s));
  if (sf) items = items.filter(r => r.status === sf);
  if (!items.length) { el.innerHTML = emptyState('📅','Nenhuma reserva registrada','Agende o uso de veículos acima'); return; }
  el.innerHTML = '<div class="panel"><div class="record-list">' + items.map(r => {
    const statusColors = { pendente: 'badge-blue', concluida: 'badge-green', cancelada: 'badge-red' };
    const statusLabels = { pendente: 'PENDENTE', concluida: 'CONCLUÍDA', cancelada: 'CANCELADA' };
    const isActive = r.dateStart <= today && r.dateEnd >= today && r.status === 'pendente';
    const activeBadge = isActive ? '<span class="badge badge-orange">EM ANDAMENTO</span>' : '';
    const loanBadge = r.isLoan ? '<span class="badge badge-orange">🔑 EMPRÉSTIMO</span>' : '';
    const days = Math.ceil((new Date(r.dateEnd+'T00:00:00') - new Date(r.dateStart+'T00:00:00')) / 86400000) + 1;
    return `<div class="record-item">
      <div class="record-stripe" style="background:${r.status==='cancelada'?'var(--danger)':r.status==='concluida'?'var(--success)':'var(--cyan)'}"></div>
      <div class="record-body">
        <div class="record-title-row">
          <span class="badge ${statusColors[r.status] || 'badge-blue'}">${statusLabels[r.status] || r.status}</span>${activeBadge}${loanBadge}
          <span class="record-name">📅 ${r.vehiclePlate} — ${r.vehicleModel}</span>
        </div>
        <div class="record-meta">
          <span><strong>${r.isLoan ? 'Emprestado para' : 'Motorista'}:</strong> ${r.driverName}</span>
          ${r.isLoan ? `<span><strong>CPF:</strong> ${r.loanCpf}</span>` : ''}
          <span><strong>De:</strong> ${fmtDate(r.dateStart)}</span>
          <span><strong>Até:</strong> ${fmtDate(r.dateEnd)}</span>
          <span><strong>Duração:</strong> ${days} dia(s)</span>
          ${r.obs ? `<span style="grid-column:1/-1"><strong>Destino:</strong> ${r.obs}</span>` : ''}
        </div>
      </div>
      <div class="record-actions">
        ${r.status === 'pendente' ? `<button class="btn btn-edit btn-sm" onclick="concludeSchedule('${r.id}')">Concluir</button>` : ''}
        ${r.status === 'pendente' ? `<button class="btn btn-ghost btn-sm" onclick="cancelSchedule('${r.id}')">Cancelar</button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteSchedule('${r.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('') + '</div></div>';
}

// ════════════════════════════════════════════════
// SIDEBAR TOGGLE & THEME
// ════════════════════════════════════════════════
function initSidebar() {
  const sb  = document.getElementById('sidebar');
  const mw  = document.getElementById('mainWrapper');
  const tog = document.getElementById('sidebarToggle');
  const ov  = document.getElementById('overlay');

  function setSidebarCollapsed(collapsed) {
    sb.classList.toggle('collapsed', collapsed);
    mw.classList.toggle('collapsed', collapsed);
    localStorage.setItem('frotactl_sb_collapsed', collapsed ? '1' : '0');
    // Atualiza título do botão
    tog.title = collapsed ? 'Expandir menu' : 'Recolher menu';
  }

  tog.addEventListener('click', (e) => {
    e.stopPropagation();
    setSidebarCollapsed(!sb.classList.contains('collapsed'));
  });

  document.getElementById('menu-toggle').addEventListener('click', () => {
    sb.classList.add('mobile-open');
    ov.classList.add('active');
  });

  ov.addEventListener('click', () => {
    sb.classList.remove('mobile-open');
    ov.classList.remove('active');
  });

  // Restaurar estado salvo
  if (localStorage.getItem('frotactl_sb_collapsed') === '1') {
    setSidebarCollapsed(true);
  }
}

// Lê a cor de destaque atual (aplicada por applyBranding()) para uso em
// contextos que não são CSS puro, como as cores dos gráficos (Chart.js).
function accentColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return v || DEFAULT_BRANDING.primaryColor;
}
function accentColorRgba(alpha) {
  const rgb = hexToRgb(accentColor());
  return rgb ? `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})` : `rgba(0,85,255,${alpha})`;
}

function initTheme() {
  const saved = localStorage.getItem('frotactl_theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  document.getElementById('themeToggle').addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('frotactl_theme', next);
    renderDashboard(); // re-render charts with correct colors
  });
}

// ════════════════════════════════════════════════
// PERSONALIZAÇÃO (identidade visual: nome, logotipo, cor)
// ════════════════════════════════════════════════
// Converte HEX (#RRGGBB) em {r,g,b}. Retorna null se o valor for inválido.
function hexToRgb(hex) {
  let c = (hex || '').replace('#', '');
  if (c.length === 3) c = c.split('').map(ch => ch + ch).join('');
  const num = parseInt(c, 16);
  if (c.length !== 6 || isNaN(num)) return null;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
// Clareia (percent > 0) ou escurece (percent < 0) uma cor HEX, misturando com branco/preto.
function shadeHexColor(hex, percent) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const target = percent < 0 ? 0 : 255;
  const p = Math.min(Math.abs(percent), 100) / 100;
  const mix = (v) => Math.round((target - v) * p) + v;
  return '#' + [mix(rgb.r), mix(rgb.g), mix(rgb.b)].map(v => v.toString(16).padStart(2, '0')).join('');
}
// Decide se o texto sobre uma cor de fundo deve ser claro ou escuro, pelo brilho relativo
// (fórmula padrão de luminância percebida — WCAG-like). Usada quando o modo é "Automático".
function getContrastTextColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#FFFFFF';
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.6 ? '#14161F' : '#FFFFFF';
}

// Aplica a identidade visual atual (dbFull.branding, com fallback para DEFAULT_BRANDING) em toda a
// interface: título da aba, textos de marca (login/sidebar/topbar), logotipo e paleta de cores.
// Chamada no carregamento (init) e sempre que a Personalização é salva ou restaurada.
function applyBranding() {
  const b = BRANDING();

  document.title = `${b.appName} — ${b.appSubtitle}`;
  document.querySelectorAll('.brand-name, .topbar-brand-mini, .login-title').forEach(el => el.textContent = b.appName);
  document.querySelectorAll('.brand-sub').forEach(el => el.textContent = b.appSubtitle);
  const loginSub = document.querySelector('.login-sub');
  if (loginSub) loginSub.textContent = `${b.appSubtitle} — acesse sua conta`;
  const sidebarVersion = document.getElementById('sidebar-version-text');
  if (sidebarVersion) sidebarVersion.textContent = `v1.0 · ${b.appName}`;

  // Logotipo: se houver upload salvo, usa a imagem; senão mostra o círculo com as iniciais.
  const initials = (b.appName || 'FC').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'FC';
  document.querySelectorAll('.app-logo-fallback-initial').forEach(el => el.textContent = initials);
  document.querySelectorAll('.app-logo-img').forEach(img => {
    const fallback = img.nextElementSibling;
    const hasFallback = fallback && fallback.classList.contains('app-logo-fallback');
    if (b.logoDataUrl) {
      img.src = b.logoDataUrl;
      img.style.display = '';
      if (hasFallback) fallback.style.display = 'none';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      if (hasFallback) fallback.style.display = 'flex';
    }
  });
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = b.logoDataUrl || favicon.dataset.default || favicon.href;

  // Cor principal: deriva toda a paleta de azul do tema a partir de uma única cor.
  const root = document.documentElement.style;
  const c = b.primaryColor || DEFAULT_BRANDING.primaryColor;
  root.setProperty('--accent', c);
  root.setProperty('--accent-hover', shadeHexColor(c, -15));
  root.setProperty('--sidebar-active-bg', c);
  root.setProperty('--brand-500', c);
  root.setProperty('--brand-400', shadeHexColor(c, 20));
  root.setProperty('--brand-600', shadeHexColor(c, -20));
  root.setProperty('--brand-700', shadeHexColor(c, -40));
  root.setProperty('--brand-800', shadeHexColor(c, -55));
  root.setProperty('--brand-900', shadeHexColor(c, -70));
  root.setProperty('--brand-100', shadeHexColor(c, 85));
  root.setProperty('--brand-50', shadeHexColor(c, 93));
  const contrastMode = b.textOnAccent || 'auto';
  const accentContrast = contrastMode === 'light' ? '#FFFFFF'
                        : contrastMode === 'dark'  ? '#14161F'
                        : getContrastTextColor(c);
  root.setProperty('--accent-contrast', accentContrast);
  const rgb = hexToRgb(c);
  if (rgb) {
    root.setProperty('--accent-light', `rgba(${rgb.r},${rgb.g},${rgb.b},0.10)`);
    root.setProperty('--accent-soft', `rgba(${rgb.r},${rgb.g},${rgb.b},0.05)`);
  }

  // Barra lateral: fundo e cor das letras/ícones — totalmente independentes da Cor Principal.
  const sidebarBg   = b.sidebarBg   || DEFAULT_BRANDING.sidebarBg;
  const sidebarText = b.sidebarText || DEFAULT_BRANDING.sidebarText;
  root.setProperty('--sidebar-bg', sidebarBg);
  root.setProperty('--sidebar-text-active', sidebarText);
  const sidebarTextRgb = hexToRgb(sidebarText);
  if (sidebarTextRgb) {
    root.setProperty('--sidebar-text', `rgba(${sidebarTextRgb.r},${sidebarTextRgb.g},${sidebarTextRgb.b},0.58)`);
    root.setProperty('--sidebar-hover', `rgba(${sidebarTextRgb.r},${sidebarTextRgb.g},${sidebarTextRgb.b},0.08)`);
    root.setProperty('--sidebar-border', `rgba(${sidebarTextRgb.r},${sidebarTextRgb.g},${sidebarTextRgb.b},0.10)`);
  }
  root.setProperty('--sidebar-active-accent', shadeHexColor(c, 25)); // ícone + faixa do item ativo, tom claro da Cor Principal
}

// Preenche o formulário da tela Personalização com os valores atuais.
function loadBrandingForm() {
  const b = BRANDING();
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('brand-app-name', b.appName);
  setVal('brand-app-subtitle', b.appSubtitle);
  setVal('brand-primary-color', b.primaryColor);
  setVal('brand-primary-color-hex', b.primaryColor);
  setVal('brand-text-on-accent', b.textOnAccent || 'auto');
  setVal('brand-sidebar-bg', b.sidebarBg || DEFAULT_BRANDING.sidebarBg);
  setVal('brand-sidebar-bg-hex', b.sidebarBg || DEFAULT_BRANDING.sidebarBg);
  setVal('brand-sidebar-text', b.sidebarText || DEFAULT_BRANDING.sidebarText);
  setVal('brand-sidebar-text-hex', b.sidebarText || DEFAULT_BRANDING.sidebarText);
  setVal('brand-report-footer', b.reportFooter);
  window.__pendingLogoDataUrl = undefined;
  const preview = document.getElementById('brand-logo-preview');
  if (preview) {
    if (b.logoDataUrl) { preview.src = b.logoDataUrl; preview.style.display = ''; }
    else { preview.removeAttribute('src'); preview.style.display = 'none'; }
  }
}

// Lê o arquivo de logotipo selecionado e guarda como data URL (fica pendente até "Salvar").
function handleBrandingLogoFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { showToast('Selecione um arquivo de imagem.', 'error'); input.value = ''; return; }
  if (file.size > 2 * 1024 * 1024) { showToast('Imagem muito grande (máximo 2MB).', 'error'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    window.__pendingLogoDataUrl = reader.result;
    const preview = document.getElementById('brand-logo-preview');
    if (preview) { preview.src = reader.result; preview.style.display = ''; }
    showToast('Logotipo carregado — clique em Salvar para aplicar.', 'success');
  };
  reader.readAsDataURL(file);
}
function removeBrandingLogo() {
  window.__pendingLogoDataUrl = '';
  const preview = document.getElementById('brand-logo-preview');
  if (preview) { preview.removeAttribute('src'); preview.style.display = 'none'; }
  const fileInput = document.getElementById('brand-logo-file');
  if (fileInput) fileInput.value = '';
  showToast('Logotipo removido do formulário — clique em Salvar para confirmar.', 'warning');
}

// Salva a identidade visual (nome, subtítulo, logotipo, cor, rodapé de relatórios).
function submitBranding(e) {
  e.preventDefault();
  const appName      = document.getElementById('brand-app-name').value.trim() || DEFAULT_BRANDING.appName;
  const appSubtitle  = document.getElementById('brand-app-subtitle').value.trim() || DEFAULT_BRANDING.appSubtitle;
  const primaryColor = document.getElementById('brand-primary-color').value || DEFAULT_BRANDING.primaryColor;
  const textOnAccent = document.getElementById('brand-text-on-accent').value || 'auto';
  const sidebarBg    = document.getElementById('brand-sidebar-bg').value || DEFAULT_BRANDING.sidebarBg;
  const sidebarText  = document.getElementById('brand-sidebar-text').value || DEFAULT_BRANDING.sidebarText;
  const reportFooter = document.getElementById('brand-report-footer').value.trim();
  const logoDataUrl  = window.__pendingLogoDataUrl !== undefined ? window.__pendingLogoDataUrl : BRANDING().logoDataUrl;

  dbFull.branding = { appName, appSubtitle, primaryColor, reportFooter, logoDataUrl, textOnAccent, sidebarBg, sidebarText };
  window.__pendingLogoDataUrl = undefined;
  saveDB();
  applyBranding();
  showToast('Personalização salva com sucesso!', 'success');
}

// Restaura o nome, cor e logotipo de fábrica (não afeta nenhum outro dado do sistema).
function resetBrandingToDefault() {
  confirmDialog('Restaurar a identidade visual padrão de fábrica (nome, cor e logotipo)? Os demais dados do sistema não são afetados.', () => {
    dbFull.branding = null;
    window.__pendingLogoDataUrl = undefined;
    saveDB();
    applyBranding();
    loadBrandingForm();
    showToast('Identidade visual restaurada para o padrão.', 'success');
  });
}

// ════════════════════════════════════════════════
// MULTAS
// ════════════════════════════════════════════════
function populateFineSelects() {
  const vSel = document.getElementById('fn-vehicle');
  if (vSel) {
    const cur = vSel.value;
    vSel.innerHTML = '<option value="">Selecione...</option>' + db.vehicles.map(v => `<option value="${v.id}">${v.plate} — ${v.brand} ${v.model}</option>`).join('');
    if (cur) vSel.value = cur;
  }
  const dSel = document.getElementById('fn-driver');
  if (dSel) {
    const cur = dSel.value;
    dSel.innerHTML = '<option value="">Não identificado</option>' + db.drivers.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
    if (cur) dSel.value = cur;
  }
}
function resetFineForm() {
  document.getElementById('fine-form').reset();
  document.getElementById('fn-date').valueAsDate = new Date();
  const btn = document.getElementById('fn-submit-btn');
  delete btn.dataset.editId; btn.textContent = 'Cadastrar Multa';
}
function submitFine(e) {
  e.preventDefault();
  const btn = document.getElementById('fn-submit-btn');
  const editId = btn.dataset.editId;
  const vehicle = db.vehicles.find(v => v.id === document.getElementById('fn-vehicle').value);
  const driver  = db.drivers.find(d => d.id === document.getElementById('fn-driver').value);
  const oldRecord = editId ? db.fines.find(f => f.id === editId) : null;
  const record = {
    id: editId || uid(),
    vehicleId: vehicle?.id || '', vehiclePlate: vehicle?.plate || '',
    driverId: driver?.id || null, driverName: driver?.name || null,
    date: document.getElementById('fn-date').value,
    type: document.getElementById('fn-type').value.trim(),
    amount: parseCurrencyInput('fn-amount'),
    points: parseInt(document.getElementById('fn-points').value) || 0,
    paymentStatus: document.getElementById('fn-payment-status').value,
    notes: document.getElementById('fn-notes').value.trim(),
    empresaId: editId ? (oldRecord?.empresaId ?? currentEmpresaId()) : currentEmpresaId(),
    createdAt: editId ? (oldRecord?.createdAt || new Date().toISOString()) : new Date().toISOString(),
  };
  if (editId) {
    dbFull.fines = dbFull.fines.map(f => f.id === editId ? record : f);
    logAudit('update', 'fine', record.id, record.type, oldRecord, record);
    showToast('Multa atualizada!', 'success');
  } else {
    dbFull.fines.push(record);
    logAudit('create', 'fine', record.id, record.type, null, record);
    showToast('Multa cadastrada!', 'success');
  }
  saveDB(); resetFineForm(); renderFineList();
}
function editFine(id) {
  const f = db.fines.find(f => f.id === id); if (!f) return;
  document.getElementById('fn-vehicle').value = f.vehicleId;
  document.getElementById('fn-driver').value = f.driverId || '';
  document.getElementById('fn-date').value = f.date;
  document.getElementById('fn-type').value = f.type;
  setCurrencyInput('fn-amount', f.amount);
  document.getElementById('fn-points').value = f.points || '';
  document.getElementById('fn-payment-status').value = f.paymentStatus;
  document.getElementById('fn-notes').value = f.notes || '';
  const btn = document.getElementById('fn-submit-btn');
  btn.dataset.editId = id; btn.textContent = 'Salvar Alterações';
  scrollMainContent(0);
}
function deleteFine(id) {
  const target = db.fines.find(f => f.id === id);
  confirmDialog('Excluir esta multa?', () => {
    dbFull.fines = dbFull.fines.filter(f => f.id !== id);
    logAudit('delete', 'fine', id, target?.type, target, null);
    saveDB(); renderFineList();
    showToast('Multa excluída.', 'success');
  });
}
function markFinePaid(id) {
  const f = db.fines.find(f => f.id === id); if (!f) return;
  f.paymentStatus = 'pago';
  logAudit('update', 'fine', id, f.type, null, { paymentStatus: 'pago' });
  saveDB(); renderFineList();
  showToast('Multa marcada como paga.', 'success');
}
function renderFineList() {
  const el = document.getElementById('fine-list'); if (!el) return;
  if (!db.fines.length) { el.innerHTML = emptyState('🚨', 'Nenhuma multa cadastrada', ''); return; }
  const statusLabel = { pendente:'Pendente', pago:'Pago', recorrida:'Em Recurso' };
  const statusBadge = { pendente:'badge-red', pago:'badge-green', recorrida:'badge-yellow' };
  const sorted = [...db.fines].sort((a,b) => new Date(b.date) - new Date(a.date));
  el.innerHTML = `<div class="panel"><div class="panel-header"><span class="panel-title">Multas (${db.fines.length})</span></div>
    <div class="panel-body" style="padding:0">
    ${sorted.map(f => `<div class="record-item">
      <div class="record-stripe" style="background:${f.paymentStatus==='pendente'?'var(--danger)':f.paymentStatus==='pago'?'var(--success)':'var(--yellow)'}"></div>
      <div class="record-body">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
          <strong>${f.type}</strong>
          <span class="badge ${statusBadge[f.paymentStatus]}">${statusLabel[f.paymentStatus]}</span>
          ${f.points ? `<span class="badge badge-orange">${f.points} pts</span>` : ''}
        </div>
        <div class="record-meta">
          <span><strong>Veículo:</strong> ${f.vehiclePlate || '—'}</span>
          <span><strong>Motorista:</strong> ${f.driverName || 'Não identificado'}</span>
          <span><strong>Data:</strong> ${fmtDate(f.date)}</span>
          <span><strong>Valor:</strong> ${fmtCurrency(f.amount)}</span>
        </div>
      </div>
      <div class="record-actions">
        ${f.paymentStatus !== 'pago' ? `<button class="btn btn-ghost btn-sm" onclick="markFinePaid('${f.id}')">Marcar Paga</button>` : ''}
        <button class="btn btn-edit btn-sm" onclick="editFine('${f.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteFine('${f.id}')">Excluir</button>
      </div>
    </div>`).join('')}
    </div></div>`;
}

// ════════════════════════════════════════════════
// MÓDULO DE VIAGENS
// ════════════════════════════════════════════════
const TRIP_EXPENSE_CATEGORIES = ['Alimentação','Combustível','Estacionamento','Hospedagem','Passagens','Pedágios','Uber/Táxi','Manutenção','Outros'];
let currentTripId = null;

function populateTripSelects() {
  const tVeh = document.getElementById('t-vehicle');
  if (tVeh) {
    const cur = tVeh.value;
    tVeh.innerHTML = '<option value="">Selecione...</option>' + db.vehicles.map(v => {
      const ico = v.type === 'moto' ? '🏍️' : '🚗';
      return `<option value="${v.id}">${ico} ${v.plate} — ${v.brand} ${v.model}</option>`;
    }).join('');
    if (cur) tVeh.value = cur;
  }
  const tDrv = document.getElementById('t-driver');
  if (tDrv) {
    const cur = tDrv.value;
    tDrv.innerHTML = '<option value="">Selecione...</option>' + db.drivers.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
    if (cur) tDrv.value = cur;
  }
}

function resetTripForm() {
  document.getElementById('trip-form').reset();
  const btn = document.getElementById('t-submit-btn');
  delete btn.dataset.editId; btn.textContent = 'Programar Viagem';
}

function submitTrip(e) {
  e.preventDefault();
  const vehicle = db.vehicles.find(v => v.id === document.getElementById('t-vehicle').value);
  const driver  = db.drivers.find(d => d.id === document.getElementById('t-driver').value);
  const btn = document.getElementById('t-submit-btn');
  const editId = btn.dataset.editId;
  const oldTripRecord = editId ? db.trips.find(t => t.id === editId) : null;

  const record = {
    id: editId || uid(),
    number: document.getElementById('t-number').value.trim(),
    client: document.getElementById('t-client').value.trim(),
    os: document.getElementById('t-os').value.trim(),
    obra: document.getElementById('t-obra').value.trim(),
    departureDate: document.getElementById('t-departure').value,
    expectedReturnDate: document.getElementById('t-return').value || null,
    originCity: document.getElementById('t-origin-city').value.trim(),
    originState: document.getElementById('t-origin-state').value.trim().toUpperCase(),
    destCity: document.getElementById('t-dest-city').value.trim(),
    destState: document.getElementById('t-dest-state').value.trim().toUpperCase(),
    vehicleId: vehicle?.id || '', vehiclePlate: vehicle?.plate || '',
    driverId: driver?.id || '', driverName: driver?.name || '',
    technicians: document.getElementById('t-technicians').value.trim(),
    notes: document.getElementById('t-notes').value.trim(),
    status: editId ? (db.trips.find(t => t.id === editId)?.status || 'programada') : 'programada',
    equipment: editId ? (db.trips.find(t => t.id === editId)?.equipment || []) : [],
    expenses: editId ? (db.trips.find(t => t.id === editId)?.expenses || []) : [],
    lodging: editId ? (db.trips.find(t => t.id === editId)?.lodging || []) : [],
    checklist: editId ? (db.trips.find(t => t.id === editId)?.checklist || null) : null,
    approval: editId ? (db.trips.find(t => t.id === editId)?.approval || null) : {
      status: 'preenchimento', technician: null, financial: null, final: null,
    },
    empresaId: editId ? (oldTripRecord?.empresaId ?? currentEmpresaId()) : currentEmpresaId(),
    createdAt: editId ? (db.trips.find(t => t.id === editId)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
  };

  if (editId) {
    dbFull.trips = dbFull.trips.map(t => t.id === editId ? record : t);
    logAudit('update', 'trip', record.id, record.number, oldTripRecord, record);
    showToast('Viagem atualizada!', 'success');
  } else {
    dbFull.trips.push(record);
    logAudit('create', 'trip', record.id, record.number, null, record);
    showToast('Viagem programada!', 'success');
  }
  saveDB();
  resetTripForm();
  renderTripList();
  renderDashboard();
}

function editTrip(id) {
  const t = db.trips.find(t => t.id === id); if (!t) return;
  document.getElementById('t-number').value = t.number;
  document.getElementById('t-client').value = t.client;
  document.getElementById('t-os').value = t.os || '';
  document.getElementById('t-obra').value = t.obra || '';
  document.getElementById('t-departure').value = t.departureDate;
  document.getElementById('t-return').value = t.expectedReturnDate || '';
  document.getElementById('t-origin-city').value = t.originCity;
  document.getElementById('t-origin-state').value = t.originState;
  document.getElementById('t-dest-city').value = t.destCity;
  document.getElementById('t-dest-state').value = t.destState;
  document.getElementById('t-vehicle').value = t.vehicleId;
  document.getElementById('t-driver').value = t.driverId;
  document.getElementById('t-technicians').value = t.technicians || '';
  document.getElementById('t-notes').value = t.notes || '';
  const btn = document.getElementById('t-submit-btn');
  btn.dataset.editId = id; btn.textContent = 'Salvar Alterações';
  scrollMainContent(0);
}

function deleteTrip(id) {
  const target = db.trips.find(t => t.id === id);
  confirmDialog('Excluir esta viagem? Todos os equipamentos e despesas lançados serão perdidos.', () => {
    dbFull.trips = dbFull.trips.filter(t => t.id !== id);
    logAudit('delete', 'trip', id, target?.number, target, null);
    saveDB(); renderTripList(); renderDashboard();
    showToast('Viagem excluída.', 'success');
  });
}

function tripStatusLabel(s) {
  return { programada:'Programada', andamento:'Em Andamento', finalizada:'Finalizada', cancelada:'Cancelada' }[s] || s;
}
function approvalStatusLabel(s) {
  return { preenchimento:'Em Preenchimento', aguardando:'Aguardando Aprovação', aprovado:'Aprovado', reprovado:'Reprovado', corrigir:'Corrigir Prestação' }[s] || '—';
}

function startTrip(id) {
  openChecklistModal(id);
}
function actuallyStartTrip(id) {
  const t = db.trips.find(t => t.id === id);
  dbFull.trips = dbFull.trips.map(t => t.id === id ? { ...t, status:'andamento' } : t);
  logAudit('status-change', 'trip', id, t?.number, { status: t?.status }, { status: 'andamento' });
  saveDB(); renderTripList(); renderDashboard();
  if (currentTripId === id) openTripDetail(id);
  showToast('Checklist concluído e viagem iniciada!', 'success');
}
function finishTrip(id) {
  confirmDialog('Finalizar esta viagem?', () => {
    const t = db.trips.find(t => t.id === id);
    dbFull.trips = dbFull.trips.map(t => t.id === id ? { ...t, status:'finalizada' } : t);
    logAudit('status-change', 'trip', id, t?.number, { status: t?.status }, { status: 'finalizada' });
    saveDB(); renderTripList(); renderDashboard();
    if (currentTripId === id) openTripDetail(id);
    showToast('Viagem finalizada!', 'success');
  });
}
function cancelTrip(id) {
  confirmDialog('Cancelar esta viagem?', () => {
    const t = db.trips.find(t => t.id === id);
    dbFull.trips = dbFull.trips.map(t => t.id === id ? { ...t, status:'cancelada' } : t);
    logAudit('status-change', 'trip', id, t?.number, { status: t?.status }, { status: 'cancelada' });
    saveDB(); renderTripList(); renderDashboard();
    if (currentTripId === id) openTripDetail(id);
    showToast('Viagem cancelada.', 'success');
  });
}

function renderTripList() {
  const el = document.getElementById('trip-list');
  if (!db.trips.length) { el.innerHTML = emptyState('🧭','Nenhuma viagem programada','Preencha o formulário acima'); return; }
  const sorted = [...db.trips].sort((a,b) => new Date(b.departureDate) - new Date(a.departureDate));
  el.innerHTML = sorted.map(t => {
    const totals = calcTripTotals(t);
    return `<div class="trip-card">
      <div class="trip-card-header">
        <span class="trip-card-title">🧭 ${t.number} — ${t.client}</span>
        <span class="badge trip-status-${t.status}">${tripStatusLabel(t.status)}</span>
        ${t.approval?.status && t.approval.status !== 'preenchimento' ? `<span class="badge approval-status-${t.approval.status}">${approvalStatusLabel(t.approval.status)}</span>` : ''}
      </div>
      <div class="trip-card-route">${t.originCity}/${t.originState} → ${t.destCity}/${t.destState}</div>
      <div class="trip-card-meta">
        <span><strong>Saída:</strong> ${fmtDate(t.departureDate)}</span>
        <span><strong>Retorno Previsto:</strong> ${t.expectedReturnDate ? fmtDate(t.expectedReturnDate) : '—'}</span>
        <span><strong>Veículo:</strong> ${t.vehiclePlate || '—'}</span>
        <span><strong>Motorista:</strong> ${t.driverName || '—'}</span>
        <span><strong>Total Gasto:</strong> ${fmtCurrency(totals.grandTotal)}</span>
      </div>
      <div class="trip-card-actions">
        <button class="btn btn-edit btn-sm" onclick="openTripDetail('${t.id}')">Abrir Viagem</button>
        <button class="btn btn-ghost btn-sm" onclick="editTrip('${t.id}')">Editar Dados</button>
        ${t.status === 'programada' ? `<button class="btn btn-primary btn-sm" onclick="startTrip('${t.id}')">Iniciar</button>` : ''}
        ${t.status === 'andamento' ? `<button class="btn btn-primary btn-sm" onclick="finishTrip('${t.id}')">Finalizar</button>` : ''}
        ${t.status !== 'cancelada' && t.status !== 'finalizada' ? `<button class="btn btn-ghost btn-sm" onclick="cancelTrip('${t.id}')">Cancelar</button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteTrip('${t.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('');
}

function calcTripTotals(t) {
  const expenses = t.expenses || [];
  const grandTotal = expenses.reduce((s,e) => s + e.amount, 0);
  const byDay = {};
  const byCategory = {};
  expenses.forEach(e => {
    byDay[e.date] = (byDay[e.date] || 0) + e.amount;
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  });
  return { grandTotal, byDay, byCategory };
}

function openTripDetail(id) {
  currentTripId = id;
  document.getElementById('trips-list-view').style.display = 'none';
  document.getElementById('trips-detail-view').style.display = 'block';
  renderTripDetailHeader();
  switchTripTab('checklist', document.querySelector('#trip-tab-nav .tab-btn[data-tab="checklist"]'));
  scrollMainContent(0);
}
function closeTripDetail() {
  currentTripId = null;
  document.getElementById('trips-detail-view').style.display = 'none';
  document.getElementById('trips-list-view').style.display = 'block';
  renderTripList();
}

function renderTripDetailHeader() {
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  const totals = calcTripTotals(t);
  document.getElementById('trip-detail-header').innerHTML = `
    <div class="trip-detail-card">
      <div class="trip-detail-title-row">
        <span class="trip-detail-title">🧭 ${t.number} — ${t.client}</span>
        <span class="badge trip-status-${t.status}">${tripStatusLabel(t.status)}</span>
      </div>
      <div class="trip-detail-meta">
        <span><strong>Rota</strong>${t.originCity}/${t.originState} → ${t.destCity}/${t.destState}</span>
        <span><strong>Saída</strong>${fmtDate(t.departureDate)}</span>
        <span><strong>Retorno Previsto</strong>${t.expectedReturnDate ? fmtDate(t.expectedReturnDate) : '—'}</span>
        <span><strong>Obra / OS</strong>${t.obra || '—'} ${t.os ? '· '+t.os : ''}</span>
        <span><strong>Veículo</strong>${t.vehiclePlate || '—'}</span>
        <span><strong>Motorista</strong>${t.driverName || '—'}</span>
        <span><strong>Técnicos</strong>${t.technicians || '—'}</span>
        <span><strong>Total Gasto</strong>${fmtCurrency(totals.grandTotal)}</span>
      </div>
      <div class="trip-detail-actions">
        ${t.status === 'programada' ? `<button class="btn btn-primary btn-sm" onclick="startTrip('${t.id}')">Iniciar Viagem</button>` : ''}
        ${t.status === 'andamento' ? `<button class="btn btn-primary btn-sm" onclick="finishTrip('${t.id}')">Finalizar Viagem</button>` : ''}
        ${t.status !== 'cancelada' && t.status !== 'finalizada' ? `<button class="btn btn-ghost btn-sm" onclick="cancelTrip('${t.id}')">Cancelar Viagem</button>` : ''}
      </div>
    </div>`;
}

function switchTripTab(tab, btn) {
  document.querySelectorAll('#trip-tab-nav .tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('trip-tab-content-' + tab).classList.add('active');
  if (tab === 'checklist') renderTripChecklistTab();
  if (tab === 'equipment') renderTripEquipmentTab();
  if (tab === 'expenses')  renderTripExpensesTab();
  if (tab === 'approval')  renderTripApprovalTab();
}

// ── EQUIPAMENTOS ──
function renderTripEquipmentTab() {
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  const items = t.equipment || [];
  document.getElementById('trip-tab-content-equipment').innerHTML = `
    <div class="panel">
      <div class="panel-header"><span class="panel-title">Adicionar Equipamento / Carga</span></div>
      <div class="form-grid">
        <div class="field"><label>Equipamento *</label><input type="text" id="teq-name" placeholder="Ex: Catraca, Ferramenta..."></div>
        <div class="field"><label>Quantidade</label><input type="number" id="teq-qty" min="1" value="1"></div>
        <div class="field"><label>Número de Série</label><input type="text" id="teq-serial" placeholder="Opcional"></div>
        <div class="field fw"><label>Observações</label><input type="text" id="teq-notes" placeholder="Opcional"></div>
        <div class="field fa"><button type="button" class="btn btn-primary" onclick="addTripEquipment()">Adicionar</button></div>
      </div>
    </div>
    <div class="panel" style="margin-top:14px;">
      <div class="panel-header"><span class="panel-title">Itens da Viagem (${items.length})</span></div>
      <div class="panel-body" style="padding:0">
        ${!items.length ? `<div style="padding:24px;">${emptyState('📦','Nenhum equipamento lançado','Adicione itens acima')}</div>` : `
        <div style="overflow-x:auto;"><table class="data-table">
          <thead><tr><th>Equipamento</th><th>Qtd</th><th>Nº Série</th><th>Observações</th><th></th></tr></thead>
          <tbody>${items.map(i => `<tr>
            <td>${i.name}</td><td>${i.qty}</td><td>${i.serial || '—'}</td><td>${i.notes || '—'}</td>
            <td><button class="btn btn-danger btn-sm" onclick="removeTripEquipment('${i.id}')">Remover</button></td>
          </tr>`).join('')}</tbody>
        </table></div>`}
      </div>
    </div>`;
}
function addTripEquipment() {
  const name = document.getElementById('teq-name').value.trim();
  if (!name) { showToast('Informe o nome do equipamento.', 'error'); return; }
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  t.equipment = t.equipment || [];
  t.equipment.push({
    id: uid(), name,
    qty: parseInt(document.getElementById('teq-qty').value) || 1,
    serial: document.getElementById('teq-serial').value.trim(),
    notes: document.getElementById('teq-notes').value.trim(),
  });
  saveDB(); renderTripEquipmentTab();
  showToast('Equipamento adicionado!', 'success');
}
function removeTripEquipment(itemId) {
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  t.equipment = (t.equipment || []).filter(i => i.id !== itemId);
  saveDB(); renderTripEquipmentTab();
}

// ── PRESTAÇÃO DE CONTAS ──
function renderTripExpensesTab() {
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  const expenses = [...(t.expenses || [])].sort((a,b) => a.date.localeCompare(b.date));
  const totals = calcTripTotals(t);
  const readOnly = t.approval && ['aguardando','aprovado'].includes(t.approval.status);

  const pmLabel = { dinheiro:'Dinheiro', cartao_empresa:'Cartão Empresa', cartao_pessoal:'Cartão Pessoal' };

  document.getElementById('trip-tab-content-expenses').innerHTML = `
    ${readOnly ? `<div class="alert-page-item" style="margin-bottom:14px;"><div>⚠️ Esta prestação de contas está <strong>${approvalStatusLabel(t.approval.status)}</strong> e não pode ser editada. ${t.approval.status==='corrigir' ? 'Aguarde a liberação para correção.' : ''}</div></div>` : ''}
    ${!readOnly ? `
    <div class="panel">
      <div class="panel-header"><span class="panel-title">Lançar Despesa</span></div>
      <div class="form-grid">
        <div class="field"><label>Data *</label><input type="date" id="te-date"></div>
        <div class="field"><label>Categoria *</label><select id="te-category">${TRIP_EXPENSE_CATEGORIES.map(c=>`<option>${c}</option>`).join('')}</select></div>
        <div class="field fw"><label>Descrição</label><input type="text" id="te-desc" placeholder="Detalhe da despesa"></div>
        <div class="field"><label>Valor (R$) *</label><input type="text" inputmode="decimal" id="te-amount" placeholder="0,00" oninput="maskCurrencyInput(this)"></div>
        <div class="field"><label>Forma de Pagamento</label>
          <select id="te-payment" onchange="toggleInstallmentFields()">
            <option value="dinheiro">Dinheiro</option>
            <option value="cartao_empresa">Cartão da Empresa</option>
            <option value="cartao_pessoal">Cartão Pessoal</option>
          </select>
        </div>
        <div class="field" id="te-installments-wrap" style="display:none"><label>Qtd. Parcelas</label><input type="number" id="te-installments" min="1" value="1"></div>
        <div class="field" id="te-due-wrap" style="display:none"><label>Vencimento</label><input type="date" id="te-due"></div>
        <div class="field fw"><label>Observações</label><input type="text" id="te-notes" placeholder="Opcional"></div>
        <div class="field fa"><button type="button" class="btn btn-primary" onclick="addTripExpense()">Adicionar Despesa</button></div>
      </div>
    </div>` : ''}

    <div class="trip-totals-row" style="margin-top:14px;">
      <div class="trip-total-box"><div class="trip-total-label">Total Geral</div><div class="trip-total-value">${fmtCurrency(totals.grandTotal)}</div></div>
      ${Object.entries(totals.byCategory).map(([cat,val]) => `<div class="trip-total-box"><div class="trip-total-label">${cat}</div><div class="trip-total-value">${fmtCurrency(val)}</div></div>`).join('')}
    </div>

    <div class="panel">
      <div class="panel-header"><span class="panel-title">Despesas Lançadas (${expenses.length})</span></div>
      <div class="panel-body" style="padding:0">
        ${!expenses.length ? `<div style="padding:24px;">${emptyState('💰','Nenhuma despesa lançada','Lance despesas acima')}</div>` : `
        <div style="overflow-x:auto;"><table class="data-table">
          <thead><tr><th>Data</th><th>Categoria</th><th>Descrição</th><th>Valor</th><th>Pagamento</th><th>Obs.</th>${!readOnly ? '<th></th>' : ''}</tr></thead>
          <tbody>${expenses.map(e => `<tr>
            <td>${fmtDate(e.date)}</td><td>${e.category}</td><td>${e.description || '—'}</td>
            <td>${fmtCurrency(e.amount)}</td>
            <td><span class="badge pm-${e.paymentMethod}">${pmLabel[e.paymentMethod]}${e.paymentMethod==='cartao_pessoal' && e.installments>1 ? ' · '+e.installments+'x' : ''}</span></td>
            <td>${e.notes || '—'}</td>
            ${!readOnly ? `<td><button class="btn btn-danger btn-sm" onclick="removeTripExpense('${e.id}')">Remover</button></td>` : ''}
          </tr>`).join('')}</tbody>
        </table></div>`}
      </div>
    </div>

    ${Object.keys(totals.byDay).length ? `
    <div class="panel" style="margin-top:14px;">
      <div class="panel-header"><span class="panel-title">Resumo por Dia</span></div>
      <div class="panel-body" style="padding:0"><div style="overflow-x:auto;"><table class="data-table">
        <thead><tr><th>Data</th><th>Total do Dia</th></tr></thead>
        <tbody>${Object.entries(totals.byDay).sort((a,b)=>a[0].localeCompare(b[0])).map(([d,v]) => `<tr><td>${fmtDate(d)}</td><td>${fmtCurrency(v)}</td></tr>`).join('')}</tbody>
      </table></div></div>
    </div>` : ''}`;

  if (!readOnly) {
    document.getElementById('te-date').valueAsDate = new Date();
    toggleInstallmentFields();
  }
}
function toggleInstallmentFields() {
  const pm = document.getElementById('te-payment')?.value;
  const instWrap = document.getElementById('te-installments-wrap');
  const dueWrap  = document.getElementById('te-due-wrap');
  if (!instWrap || !dueWrap) return;
  const show = pm === 'cartao_pessoal';
  instWrap.style.display = show ? '' : 'none';
  dueWrap.style.display  = show ? '' : 'none';
}
function addTripExpense() {
  const date   = document.getElementById('te-date').value;
  const amount = parseCurrencyInput('te-amount');
  if (!date) { showToast('Informe a data da despesa.', 'error'); return; }
  if (!amount || amount <= 0) { showToast('Informe um valor válido.', 'error'); return; }
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  const paymentMethod = document.getElementById('te-payment').value;
  t.expenses = t.expenses || [];
  t.expenses.push({
    id: uid(), date,
    category: document.getElementById('te-category').value,
    description: document.getElementById('te-desc').value.trim(),
    amount, paymentMethod,
    installments: paymentMethod === 'cartao_pessoal' ? (parseInt(document.getElementById('te-installments').value) || 1) : null,
    installmentDueDate: paymentMethod === 'cartao_pessoal' ? (document.getElementById('te-due').value || null) : null,
    notes: document.getElementById('te-notes').value.trim(),
  });
  saveDB(); renderTripExpensesTab();
  showToast('Despesa lançada!', 'success');
}
function removeTripExpense(expId) {
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  t.expenses = (t.expenses || []).filter(e => e.id !== expId);
  saveDB(); renderTripExpensesTab();
}

// ── APROVAÇÃO FINANCEIRA ──
function renderTripApprovalTab() {
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  t.approval = t.approval || { status:'preenchimento', technician:null, financial:null, final:null };
  const a = t.approval;
  const totals = calcTripTotals(t);

  let stepsHtml = '';
  stepsHtml += `<div class="approval-step">
    <div class="approval-step-icon ${a.technician ? 'done' : ''}">${a.technician ? '✅' : '1️⃣'}</div>
    <div class="approval-step-body">
      <div class="approval-step-title">Assinatura do Técnico</div>
      <div class="approval-step-sub">${a.technician ? 'Assinado em ' + fmtDate(a.technician.date) : 'Aguardando envio da prestação de contas'}</div>
      ${a.technician?.comment ? `<div class="approval-step-comment">${a.technician.comment}</div>` : ''}
      ${a.technician?.signature ? `<img class="signature-img-preview" src="${a.technician.signature}" alt="Assinatura">` : ''}
    </div>
  </div>`;
  stepsHtml += `<div class="approval-step">
    <div class="approval-step-icon ${a.financial ? 'done' : ''}">${a.financial ? '✅' : '2️⃣'}</div>
    <div class="approval-step-body">
      <div class="approval-step-title">Análise Financeira</div>
      <div class="approval-step-sub">${a.financial ? 'Analisado em ' + fmtDate(a.financial.date) : 'Aguardando análise'}</div>
      ${a.financial?.comment ? `<div class="approval-step-comment">${a.financial.comment}</div>` : ''}
    </div>
  </div>`;
  stepsHtml += `<div class="approval-step">
    <div class="approval-step-icon ${a.final ? 'done' : ''}">${a.final ? '✅' : '3️⃣'}</div>
    <div class="approval-step-body">
      <div class="approval-step-title">Aprovação Final</div>
      <div class="approval-step-sub">${a.final ? 'Concluído em ' + fmtDate(a.final.date) : 'Aguardando aprovação final'}</div>
      ${a.final?.comment ? `<div class="approval-step-comment">${a.final.comment}</div>` : ''}
    </div>
  </div>`;

  let actionsHtml = '';
  if (a.status === 'preenchimento' || a.status === 'corrigir') {
    actionsHtml = `
      <div class="panel" style="margin-top:14px;">
        <div class="panel-header"><span class="panel-title">Enviar para Aprovação</span></div>
        <div class="panel-body">
          <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:12px;">Total da prestação de contas: <strong>${fmtCurrency(totals.grandTotal)}</strong>. Ao enviar, o técnico deve assinar digitalmente confirmando os lançamentos.</p>
          <button class="btn btn-primary" onclick="openSignatureModal()">✍️ Assinar e Enviar para Aprovação</button>
        </div>
      </div>`;
  } else if (a.status === 'aguardando') {
    actionsHtml = canApprove() ? `
      <div class="panel" style="margin-top:14px;">
        <div class="panel-header"><span class="panel-title">Ação do Financeiro</span></div>
        <div class="panel-body">
          <div class="field" style="margin-bottom:12px;"><label>Comentário</label><textarea id="fin-comment" placeholder="Comentários sobre a análise (opcional para aprovar, recomendado para reprovar/corrigir)"></textarea></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="financialAction('aprovado')">Aprovar</button>
            <button class="btn btn-ghost" onclick="financialAction('corrigir')">Solicitar Correção</button>
            <button class="btn btn-danger" onclick="financialAction('reprovado')">Reprovar</button>
          </div>
        </div>
      </div>` : `<div class="panel" style="margin-top:14px;"><div class="panel-body"><p class="role-locked-note">Apenas Gestor ou Administrador pode analisar esta prestação de contas.</p></div></div>`;
  } else if (a.status === 'aprovado' && !a.final) {
    actionsHtml = canApprove() ? `
      <div class="panel" style="margin-top:14px;">
        <div class="panel-header"><span class="panel-title">Aprovação Final</span></div>
        <div class="panel-body">
          <div class="field" style="margin-bottom:12px;"><label>Observações Finais</label><textarea id="final-comment" placeholder="Observações da aprovação final (opcional)"></textarea></div>
          <button class="btn btn-primary" onclick="finalizeApproval()">Concluir Aprovação Final</button>
        </div>
      </div>` : `<div class="panel" style="margin-top:14px;"><div class="panel-body"><p class="role-locked-note">Apenas Gestor ou Administrador pode concluir a aprovação final.</p></div></div>`;
  }

  document.getElementById('trip-tab-content-approval').innerHTML = `
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Status da Prestação de Contas</span>
        <span class="badge approval-status-${a.status}" style="margin-left:auto">${approvalStatusLabel(a.status)}</span>
      </div>
      <div class="panel-body">${stepsHtml}</div>
    </div>
    ${actionsHtml}`;
}

function financialAction(action) {
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  const comment = document.getElementById('fin-comment')?.value.trim() || '';
  t.approval.status = action;
  t.approval.financial = { comment, date: new Date().toISOString().substring(0,10) };
  logAudit('financial-' + action, 'trip-approval', t.id, t.number, null, { status: action, comment });
  saveDB(); renderTripApprovalTab();
  const msgs = { aprovado:'Prestação de contas aprovada!', corrigir:'Correção solicitada ao técnico.', reprovado:'Prestação de contas reprovada.' };
  showToast(msgs[action] || 'Análise registrada.', action === 'reprovado' ? 'warning' : 'success');
}

function finalizeApproval() {
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  const comment = document.getElementById('final-comment')?.value.trim() || '';
  t.approval.final = { comment, date: new Date().toISOString().substring(0,10) };
  logAudit('final-approve', 'trip-approval', t.id, t.number, null, { comment });
  saveDB(); renderTripApprovalTab();
  showToast('Aprovação final concluída!', 'success');
}

// ── ASSINATURA DIGITAL (canvas) ──
let sigCtx = null, sigDrawing = false, sigHasStroke = false;

function openSignatureModal() {
  document.getElementById('sig-comment').value = '';
  document.getElementById('signature-modal-overlay').classList.add('open');
  requestAnimationFrame(initSignatureCanvas);
}
function closeSignatureModal() {
  document.getElementById('signature-modal-overlay').classList.remove('open');
}
function initSignatureCanvas() {
  const canvas = document.getElementById('signature-canvas');
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  sigCtx = canvas.getContext('2d');
  sigCtx.scale(ratio, ratio);
  sigCtx.lineWidth = 2.2;
  sigCtx.lineCap = 'round';
  sigCtx.strokeStyle = '#0A0E1A';
  sigHasStroke = false;

  const getPos = (e) => {
    const r = canvas.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : e;
    return { x: point.clientX - r.left, y: point.clientY - r.top };
  };
  const start = (e) => { e.preventDefault(); sigDrawing = true; sigHasStroke = true; const p = getPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); };
  const move  = (e) => { if (!sigDrawing) return; e.preventDefault(); const p = getPos(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); };
  const end   = () => { sigDrawing = false; };

  canvas.onmousedown = start; canvas.onmousemove = move; canvas.onmouseup = end; canvas.onmouseleave = end;
  canvas.ontouchstart = start; canvas.ontouchmove = move; canvas.ontouchend = end;
}
function clearSignature() {
  const canvas = document.getElementById('signature-canvas');
  const ratio = window.devicePixelRatio || 1;
  sigCtx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
  sigHasStroke = false;
}
function confirmSignature() {
  if (!sigHasStroke) { showToast('Por favor, assine no campo antes de confirmar.', 'error'); return; }
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  const canvas = document.getElementById('signature-canvas');
  const signature = canvas.toDataURL('image/png');
  const comment = document.getElementById('sig-comment').value.trim();
  t.approval = t.approval || {};
  t.approval.status = 'aguardando';
  t.approval.technician = { comment, signature, date: new Date().toISOString().substring(0,10) };
  logAudit('technician-sign', 'trip-approval', t.id, t.number, null, { comment, signed: true });
  saveDB();
  closeSignatureModal();
  renderTripApprovalTab();
  showToast('Assinado e enviado para aprovação financeira!', 'success');
}

// ════════════════════════════════════════════════
// CHECKLIST DIGITAL DO VEÍCULO
// ════════════════════════════════════════════════
const CHECKLIST_ITEMS = [
  { id:'pneus',       label:'Pneus OK' },
  { id:'luzes',       label:'Luzes funcionando' },
  { id:'oleo',        label:'Óleo verificado' },
  { id:'radiador',    label:'Água do radiador' },
  { id:'combustivel', label:'Combustível suficiente' },
  { id:'ferramentas', label:'Ferramentas obrigatórias' },
  { id:'extintor',    label:'Extintor válido' },
  { id:'triangulo',   label:'Triângulo' },
  { id:'macaco',      label:'Macaco' },
  { id:'estepe',      label:'Estepe' },
];
let checklistTripId = null;
let checklistPhotos = [];
let chkSigCtx = null, chkSigDrawing = false, chkSigHasStroke = false;

function openChecklistModal(tripId) {
  checklistTripId = tripId;
  checklistPhotos = [];
  document.getElementById('chk-observations').value = '';
  document.getElementById('chk-photo-input').value = '';
  document.getElementById('chk-photo-preview').innerHTML = '';
  document.getElementById('checklist-items-grid').innerHTML = CHECKLIST_ITEMS.map(item => `
    <label class="checklist-item">
      <input type="checkbox" id="chk-${item.id}">
      <span>${item.label}</span>
    </label>`).join('');
  document.getElementById('checklist-modal-overlay').classList.add('open');
  requestAnimationFrame(initChecklistSignatureCanvas);
}
function closeChecklistModal() {
  document.getElementById('checklist-modal-overlay').classList.remove('open');
}

function handleChecklistPhotos(input) {
  [...input.files].forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxW = 800;
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        checklistPhotos.push(dataUrl);
        renderChecklistPhotoPreview();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
function renderChecklistPhotoPreview() {
  document.getElementById('chk-photo-preview').innerHTML = checklistPhotos.map((src, i) => `
    <div class="checklist-photo-thumb">
      <img src="${src}">
      <button type="button" onclick="removeChecklistPhoto(${i})">✕</button>
    </div>`).join('');
}
function removeChecklistPhoto(i) {
  checklistPhotos.splice(i, 1);
  renderChecklistPhotoPreview();
}

function initChecklistSignatureCanvas() {
  const canvas = document.getElementById('checklist-signature-canvas');
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  chkSigCtx = canvas.getContext('2d');
  chkSigCtx.scale(ratio, ratio);
  chkSigCtx.lineWidth = 2.2; chkSigCtx.lineCap = 'round'; chkSigCtx.strokeStyle = '#0A0E1A';
  chkSigHasStroke = false;

  const getPos = (e) => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
  const start = (e) => { e.preventDefault(); chkSigDrawing = true; chkSigHasStroke = true; const p = getPos(e); chkSigCtx.beginPath(); chkSigCtx.moveTo(p.x, p.y); };
  const move  = (e) => { if (!chkSigDrawing) return; e.preventDefault(); const p = getPos(e); chkSigCtx.lineTo(p.x, p.y); chkSigCtx.stroke(); };
  const end   = () => { chkSigDrawing = false; };

  canvas.onmousedown = start; canvas.onmousemove = move; canvas.onmouseup = end; canvas.onmouseleave = end;
  canvas.ontouchstart = start; canvas.ontouchmove = move; canvas.ontouchend = end;
}
function clearChecklistSignature() {
  const canvas = document.getElementById('checklist-signature-canvas');
  const ratio = window.devicePixelRatio || 1;
  chkSigCtx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
  chkSigHasStroke = false;
}

function confirmChecklist() {
  const missing = CHECKLIST_ITEMS.filter(item => !document.getElementById('chk-' + item.id).checked);
  if (missing.length) { showToast('Marque todos os itens do checklist antes de continuar.', 'error'); return; }
  if (!chkSigHasStroke) { showToast('É necessário assinar para confirmar o checklist.', 'error'); return; }

  const t = db.trips.find(t => t.id === checklistTripId); if (!t) return;
  const canvas = document.getElementById('checklist-signature-canvas');
  const checklist = {
    items: Object.fromEntries(CHECKLIST_ITEMS.map(item => [item.id, true])),
    observations: document.getElementById('chk-observations').value.trim(),
    photos: [...checklistPhotos],
    signature: canvas.toDataURL('image/png'),
    driverName: t.driverName || '',
    date: new Date().toISOString(),
  };
  t.checklist = checklist;
  logAudit('checklist-complete', 'trip-checklist', t.id, t.number, null, { observations: checklist.observations, photoCount: checklist.photos.length });
  saveDB();
  closeChecklistModal();
  const wasProgramada = t.status === 'programada';
  if (currentTripId === t.id) renderTripChecklistTab();
  if (wasProgramada) actuallyStartTrip(t.id);
  else showToast('Checklist salvo!', 'success');
}

function renderTripChecklistTab() {
  const t = db.trips.find(t => t.id === currentTripId); if (!t) return;
  const el = document.getElementById('trip-tab-content-checklist');
  if (!t.checklist) {
    el.innerHTML = `<div class="panel"><div class="panel-body">
      ${emptyState('✅', 'Checklist ainda não preenchido', t.status === 'programada' ? 'Ele será solicitado ao iniciar a viagem, ou preencha agora' : '')}
      ${t.status === 'programada' ? `<div style="text-align:center;"><button class="btn btn-primary btn-sm" onclick="openChecklistModal('${t.id}')">Preencher Checklist Agora</button></div>` : ''}
    </div></div>`;
    return;
  }
  const c = t.checklist;
  el.innerHTML = `<div class="panel">
    <div class="panel-header"><span class="panel-title">Checklist preenchido por ${c.driverName || 'motorista'} em ${new Date(c.date).toLocaleString('pt-BR')}</span></div>
    <div class="panel-body">
      <div class="checklist-grid" style="margin-bottom:14px;">
        ${CHECKLIST_ITEMS.map(item => `<div class="checklist-item-done">✅ ${item.label}</div>`).join('')}
      </div>
      ${c.observations ? `<p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:12px;"><strong>Observações:</strong> ${c.observations}</p>` : ''}
      ${c.photos?.length ? `<div class="checklist-photo-grid" style="margin-bottom:14px;">${c.photos.map(p => `<div class="checklist-photo-thumb"><img src="${p}"></div>`).join('')}</div>` : ''}
      <label style="display:block;margin-bottom:6px;font-size:0.8rem;color:var(--text-muted);">Assinatura do Motorista</label>
      <img class="signature-img-preview" src="${c.signature}" alt="Assinatura">
    </div>
  </div>`;
}

// ════════════════════════════════════════════════
// AUTENTICAÇÃO, PERMISSÕES E USUÁRIOS
// ════════════════════════════════════════════════
// AVISO: como o backend é um arquivo JSON compartilhado (sem sessão de servidor),
// este login protege o USO NORMAL do sistema (esconde telas/ações por perfil),
// mas não é uma barreira de segurança contra acesso direto à API.

const ROLE_LABELS = { admin_geral: 'Administrador Geral', admin: 'Administrador', gestor: 'Gestor', operador: 'Operador', colaborador: 'Colaborador' };

async function hashPassword(password) {
  // CryptoJS funciona em HTTP e HTTPS (crypto.subtle nativo exigiria contexto seguro/HTTPS).
  return CryptoJS.SHA256(password + '::frotactl_salt_v1').toString();
}

async function ensureDefaultAdmin() {
  if (!dbFull.users) dbFull.users = [];
  if (dbFull.users.length === 0) {
    const passwordHash = await hashPassword('admin123');
    // Primeiro acesso ao sistema: o usuário inicial é o Administrador Geral (acesso a todas as empresas).
    dbFull.users.push({
      id: uid(), name: 'Administrador', username: 'admin', passwordHash,
      role: 'admin_geral', empresaId: null, active: true, createdAt: new Date().toISOString(),
    });
    db = dbFull;
    saveDB();
  }
}

async function submitLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const hash = await hashPassword(password);

  const user = db.users.find(u => u.username.toLowerCase() === username && u.passwordHash === hash);
  if (!user) {
    errEl.textContent = 'Usuário ou senha inválidos.';
    errEl.style.display = 'block';
    return;
  }
  if (user.active === false) {
    errEl.textContent = 'Este usuário está desativado. Fale com um administrador.';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';
  currentUser = user;
  // Admin Geral começa vendo "Todas as empresas"; demais papéis nunca têm escolha (empresa fixa).
  activeCompanyId = user.role === 'admin_geral' ? null : (user.empresaId || null);
  rebuildView();
  localStorage.setItem('frotactl_session', user.id);
  logAudit('login', 'session', user.id, user.name, null, null);
  saveDB();
  document.body.classList.add('logged-in');
  boot();
}

function logout() {
  confirmDialog('Deseja realmente sair do sistema?', () => {
    logAudit('logout', 'session', currentUser.id, currentUser.name, null, null);
    saveDB();
    localStorage.removeItem('frotactl_session');
    location.reload();
  });
}

// Chamado pelo seletor de empresa no topo (visível apenas para Administrador Geral).
function switchActiveCompany(companyId) {
  if (!currentUser || currentUser.role !== 'admin_geral') return;
  activeCompanyId = companyId || null;
  rebuildView();
  renderCompanyBadge();
  applyRolePermissions();
  renderAllModules();
  showToast(activeCompanyId ? 'Visualizando: ' + (dbFull.companies.find(c => c.id === activeCompanyId)?.name || '') : 'Visualizando: Todas as Empresas', 'success');
}

function updateUserBadge() {
  document.getElementById('user-badge-name').textContent = currentUser.name;
  document.getElementById('user-badge-role').textContent = ROLE_LABELS[currentUser.role] || currentUser.role;
  const avatarEl = document.getElementById('user-badge-avatar');
  if (currentUser.photoDataUrl) {
    avatarEl.src = currentUser.photoDataUrl;
    avatarEl.style.display = '';
  } else {
    avatarEl.style.display = 'none';
  }
}
function toggleUserMenu() {
  document.getElementById('user-menu').classList.toggle('open');
}
document.addEventListener('click', (e) => {
  const badge = document.getElementById('user-badge');
  const menu = document.getElementById('user-menu');
  if (badge && menu && !badge.contains(e.target)) menu.classList.remove('open');
});

// ── GATE DE PERMISSÕES ──
// ── PERMISSÕES GRANULARES POR MÓDULO ──
const PERMISSION_MODULES = [
  { key:'alerts',           label:'Central de Alertas' },
  { key:'vehicles',         label:'Veículos' },
  { key:'drivers',          label:'Motoristas' },
  { key:'briefcases',       label:'Maletas' },
  { key:'trips',            label:'Viagens' },
  { key:'assignments',      label:'Atribuições' },
  { key:'fuel',             label:'Abastecimentos' },
  { key:'maintenance',      label:'Manutenções' },
  { key:'oil',              label:'Troca de Óleo' },
  { key:'fines',            label:'Multas' },
  { key:'briefcase-return', label:'Devolução Final da Maleta' },
  { key:'schedule',         label:'Agenda de Reservas' },
  { key:'inspection',       label:'Vistoria do Veículo' },
  { key:'weekly-terms',     label:'Termo da Maleta' },
  { key:'temp-items',       label:'Ferramentas de Uso Comum' },
  { key:'reports',          label:'Relatórios' },
  { key:'adv-reports',      label:'Análise Avançada' },
  { key:'personalizacao',   label:'Personalização' },
];
const ADMIN_ONLY_MODULES = ['users', 'audit', 'backup'];
const ADMIN_GERAL_ONLY_MODULES = ['companies']; // visível apenas para o Administrador Geral

// Padrão "de fábrica" de cada perfil (usado quando não há customização salva em dbFull.roleDefaults).
function factoryRoleDefault(role, pageId) {
  if (ADMIN_GERAL_ONLY_MODULES.includes(pageId)) return { view: role === 'admin_geral', edit: role === 'admin_geral' };
  if (role === 'admin_geral' || role === 'admin') return { view: true, edit: true };
  if (ADMIN_ONLY_MODULES.includes(pageId)) return { view: false, edit: false };
  // Personalização: por padrão só o Administrador vê, mas pode ser liberada para outros perfis/usuários
  // em Usuários > Perfis Padrão ou nas permissões personalizadas de um usuário específico.
  if (pageId === 'personalizacao') return { view: false, edit: false };
  // Colaborador: perfil restrito, só pode registrar/ver a atribuição de veículo (quem pegou o carro).
  if (role === 'colaborador') return { view: pageId === 'assignments', edit: pageId === 'assignments' };
  return { view: true, edit: true }; // gestor/operador: acesso total por padrão, exceto módulos admin-only
}

function roleDefaultPermission(role, pageId) {
  if (ADMIN_GERAL_ONLY_MODULES.includes(pageId)) return { view: role === 'admin_geral', edit: role === 'admin_geral' };
  if (role === 'admin_geral' || role === 'admin') return { view: true, edit: true };
  if (ADMIN_ONLY_MODULES.includes(pageId)) return { view: false, edit: false };
  // Perfil padrão customizado pelo Administrador em Usuários > Perfis Padrão, se existir.
  const custom = dbFull.roleDefaults?.[role]?.[pageId];
  if (custom) return custom;
  return factoryRoleDefault(role, pageId);
}

function hasPermission(pageId, action = 'view') {
  if (!currentUser) return false;
  if (currentUser.role === 'admin_geral') return true; // acesso total a todas as empresas
  if (currentUser.role === 'admin') return !ADMIN_GERAL_ONLY_MODULES.includes(pageId); // admin de empresa nunca é bloqueado, exceto telas exclusivas do Admin Geral
  if (pageId === 'dashboard') return true;
  const override = currentUser.permissionsOverride;
  if (override && override[pageId]) return !!override[pageId][action];
  return !!roleDefaultPermission(currentUser.role, pageId)[action];
}

function applyRolePermissions() {
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    const pageId = btn.dataset.page;
    btn.classList.toggle('role-hidden', !hasPermission(pageId, 'view'));
  });
}
function canApprove() { return currentUser && (currentUser.role === 'admin_geral' || currentUser.role === 'admin' || currentUser.role === 'gestor'); }
// Ações sensíveis do Termo da Maleta (escolher conferente, solicitar renovação, excluir termo assinado)
// ficam restritas ao Gestor e ao Administrador Geral — demais perfis apenas visualizam.
function canManageBriefcaseTerms() { return currentUser && (currentUser.role === 'gestor' || currentUser.role === 'admin_geral'); }

// ════════════════════════════════════════════════
// CRUD DE EMPRESAS (somente Administrador Geral)
// ════════════════════════════════════════════════
// "companies" é uma entidade global (não filtrada por empresa) — só é editável por quem
// enxerga todas as empresas, mas está disponível em dbFull para qualquer parte do app
// que precise resolver o nome de uma empresa a partir do id (ex.: badges, listas de usuários).
function submitCompany(e) {
  e.preventDefault();
  const btn = document.getElementById('c-submit-btn');
  const editId = btn.dataset.editId;
  const name = document.getElementById('c-name').value.trim();
  if (!name) { showToast('Informe o nome da empresa.', 'error'); return; }

  const oldRecord = editId ? dbFull.companies.find(c => c.id === editId) : null;
  const record = {
    id: editId || uid(),
    name,
    cnpj: document.getElementById('c-cnpj').value.trim(),
    active: oldRecord ? oldRecord.active : true,
    createdAt: oldRecord?.createdAt || new Date().toISOString(),
  };

  if (editId) {
    dbFull.companies = dbFull.companies.map(c => c.id === editId ? record : c);
    logAudit('update', 'company', record.id, record.name, oldRecord, record);
    showToast('Empresa atualizada!', 'success');
  } else {
    dbFull.companies.push(record);
    logAudit('create', 'company', record.id, record.name, null, record);
    showToast('Empresa cadastrada!', 'success');
  }
  saveDB(); resetCompanyForm(); renderCompanyList(); renderCompanyBadge(); populateUserFormEmpresaAndRole();
}

function resetCompanyForm() {
  const form = document.getElementById('company-form'); if (!form) return;
  form.reset();
  const btn = document.getElementById('c-submit-btn');
  delete btn.dataset.editId; btn.textContent = 'Cadastrar Empresa';
}

function editCompany(id) {
  const c = dbFull.companies.find(c => c.id === id); if (!c) return;
  document.getElementById('c-name').value = c.name;
  document.getElementById('c-cnpj').value = c.cnpj || '';
  const btn = document.getElementById('c-submit-btn');
  btn.dataset.editId = id; btn.textContent = 'Salvar Alterações';
  scrollMainContent(0);
}

function toggleCompanyActive(id) {
  const c = dbFull.companies.find(c => c.id === id); if (!c) return;
  c.active = c.active === false ? true : false;
  logAudit(c.active ? 'activate' : 'deactivate', 'company', c.id, c.name, null, { active: c.active });
  saveDB(); renderCompanyList();
}

function deleteCompany(id) {
  const target = dbFull.companies.find(c => c.id === id);
  const hasData = EMPRESA_SCOPED_KEYS.some(k => Array.isArray(dbFull[k]) && dbFull[k].some(r => r.empresaId === id))
    || dbFull.users.some(u => u.empresaId === id);
  if (hasData) {
    showToast('Não é possível excluir: existem dados ou usuários vinculados a esta empresa. Desative-a em vez disso.', 'error');
    return;
  }
  confirmDialog('Excluir esta empresa? Esta ação não pode ser desfeita.', () => {
    dbFull.companies = dbFull.companies.filter(c => c.id !== id);
    logAudit('delete', 'company', id, target?.name, target, null);
    saveDB(); renderCompanyList(); renderCompanyBadge(); populateUserFormEmpresaAndRole();
    showToast('Empresa excluída.', 'success');
  });
}

function renderCompanyList() {
  const el = document.getElementById('company-list'); if (!el) return;
  if (!dbFull.companies.length) { el.innerHTML = emptyState('🏢', 'Nenhuma empresa cadastrada', 'Cadastre a primeira empresa acima'); return; }
  el.innerHTML = '<div class="panel"><div class="record-list">' + dbFull.companies.map(c => {
    const vehicleCount = dbFull.vehicles.filter(v => v.empresaId === c.id).length;
    const userCount = dbFull.users.filter(u => u.empresaId === c.id).length;
    return `<div class="record-item">
      <div class="record-stripe" style="background:${c.active === false ? 'var(--text-muted)' : '#7C3AED'}"></div>
      <div class="record-body">
        <div class="record-title-row">
          <span class="record-name">${c.name}</span>
          ${c.active === false ? '<span class="badge badge-red">Inativa</span>' : '<span class="badge badge-green">Ativa</span>'}
        </div>
        <div class="record-meta">
          <span><strong>CNPJ:</strong> ${c.cnpj || '—'}</span>
          <span><strong>Veículos:</strong> ${vehicleCount}</span>
          <span><strong>Usuários:</strong> ${userCount}</span>
        </div>
      </div>
      <div class="record-actions">
        <button class="btn btn-edit btn-sm" onclick="editCompany('${c.id}')">Editar</button>
        <button class="btn btn-ghost btn-sm" onclick="toggleCompanyActive('${c.id}')">${c.active === false ? 'Reativar' : 'Desativar'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteCompany('${c.id}')">Excluir</button>
      </div>
    </div>`;
  }).join('') + '</div></div>';
}

// ── CRUD DE USUÁRIOS (somente Administrador) ──
function resetUserForm() {
  document.getElementById('user-form').reset();
  const btn = document.getElementById('u-submit-btn');
  delete btn.dataset.editId; btn.textContent = 'Cadastrar Usuário';
  document.getElementById('u-password').placeholder = 'Senha *';
  document.getElementById('u-password').required = true;
  document.getElementById('u-custom-perms').checked = false;
  populateUserFormEmpresaAndRole();
  renderPermissionMatrix(null);
  togglePermissionMatrix();
}

// Monta o campo "Empresa" e as opções de "Perfil" do formulário de usuário conforme quem está logado:
// - Administrador Geral: escolhe a empresa (obrigatório) e pode criar outro Administrador Geral.
// - Demais papéis: o campo Empresa fica travado na própria empresa (não aparece seletor).
function populateUserFormEmpresaAndRole() {
  const empresaWrap = document.getElementById('u-empresa-wrap');
  const roleSel = document.getElementById('u-role');
  if (roleSel) {
    const canCreateAdminGeral = currentUser.role === 'admin_geral';
    roleSel.innerHTML = `
      <option value="admin">Administrador</option>
      <option value="gestor">Gestor</option>
      <option value="operador">Operador</option>
      <option value="colaborador">Colaborador</option>
      ${canCreateAdminGeral ? '<option value="admin_geral">Administrador Geral</option>' : ''}`;
  }
  if (empresaWrap) {
    if (currentUser.role === 'admin_geral') {
      empresaWrap.style.display = '';
      const sel = document.getElementById('u-empresa');
      sel.innerHTML = '<option value="">Selecione a empresa...</option>' +
        dbFull.companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    } else {
      empresaWrap.style.display = 'none';
    }
  }
  toggleUserEmpresaField();
}

// Esconde o campo Empresa quando o perfil escolhido é Administrador Geral (que não pertence a nenhuma empresa).
function toggleUserEmpresaField() {
  const empresaWrap = document.getElementById('u-empresa-wrap');
  const roleSel = document.getElementById('u-role');
  if (!empresaWrap || !roleSel) return;
  if (currentUser.role !== 'admin_geral') { empresaWrap.style.display = 'none'; return; }
  empresaWrap.style.display = roleSel.value === 'admin_geral' ? 'none' : '';
}

function togglePermissionMatrix() {
  const enabled = document.getElementById('u-custom-perms').checked;
  document.getElementById('u-permission-matrix-wrap').style.display = enabled ? 'block' : 'none';
  if (enabled && !document.getElementById('u-permission-matrix').innerHTML) renderPermissionMatrix(null);
}

function renderPermissionMatrix(existingOverride, role) {
  role = role || document.getElementById('u-role').value;
  const el = document.getElementById('u-permission-matrix');
  el.innerHTML = `<table class="data-table perm-matrix-table"><thead><tr><th>Módulo</th><th>Ver</th><th>Editar</th></tr></thead><tbody>
    ${PERMISSION_MODULES.map(m => {
      const def = existingOverride?.[m.key] || roleDefaultPermission(role, m.key);
      return `<tr>
        <td>${m.label}</td>
        <td style="text-align:center"><input type="checkbox" class="perm-view" data-module="${m.key}" ${def.view ? 'checked' : ''} onchange="if(!this.checked) this.parentElement.nextElementSibling.querySelector('input').checked=false;"></td>
        <td style="text-align:center"><input type="checkbox" class="perm-edit" data-module="${m.key}" ${def.edit ? 'checked' : ''} onchange="if(this.checked) this.parentElement.previousElementSibling.querySelector('input').checked=true;"></td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

function collectPermissionOverride() {
  if (!document.getElementById('u-custom-perms').checked) return null;
  const override = {};
  PERMISSION_MODULES.forEach(m => {
    const view = document.querySelector(`.perm-view[data-module="${m.key}"]`)?.checked || false;
    const edit = document.querySelector(`.perm-edit[data-module="${m.key}"]`)?.checked || false;
    override[m.key] = { view, edit };
  });
  return override;
}

// ── PERFIS PADRÃO (permissões padrão editáveis por perfil, em vez de fixas no código) ──
function renderRoleDefaultsMatrix() {
  const el = document.getElementById('rd-matrix-wrap');
  if (!el) return;
  const role = document.getElementById('rd-role').value;
  el.innerHTML = `<table class="data-table perm-matrix-table"><thead><tr><th>Módulo</th><th>Ver</th><th>Editar</th></tr></thead><tbody>
    ${PERMISSION_MODULES.map(m => {
      const def = dbFull.roleDefaults?.[role]?.[m.key] || factoryRoleDefault(role, m.key);
      return `<tr>
        <td>${m.label}</td>
        <td style="text-align:center"><input type="checkbox" class="rd-view" data-module="${m.key}" ${def.view ? 'checked' : ''} onchange="if(!this.checked) this.parentElement.nextElementSibling.querySelector('input').checked=false;"></td>
        <td style="text-align:center"><input type="checkbox" class="rd-edit" data-module="${m.key}" ${def.edit ? 'checked' : ''} onchange="if(this.checked) this.parentElement.previousElementSibling.querySelector('input').checked=true;"></td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

function saveRoleDefaults() {
  const role = document.getElementById('rd-role').value;
  const perms = {};
  PERMISSION_MODULES.forEach(m => {
    const view = document.querySelector(`.rd-view[data-module="${m.key}"]`)?.checked || false;
    const edit = document.querySelector(`.rd-edit[data-module="${m.key}"]`)?.checked || false;
    perms[m.key] = { view, edit };
  });
  if (!dbFull.roleDefaults) dbFull.roleDefaults = {};
  dbFull.roleDefaults[role] = perms;
  saveDB();
  showToast(`Perfil padrão "${ROLE_LABELS[role]}" atualizado! Vale para todos os usuários sem permissões personalizadas.`, 'success');
}

function resetRoleDefaultsToFactory() {
  const role = document.getElementById('rd-role').value;
  confirmDialog(`Restaurar o perfil "${ROLE_LABELS[role]}" para o padrão de fábrica?`, () => {
    if (dbFull.roleDefaults) delete dbFull.roleDefaults[role];
    saveDB(); renderRoleDefaultsMatrix();
    showToast('Perfil padrão restaurado.', 'success');
  });
}

async function submitUser(e) {
  e.preventDefault();
  const btn = document.getElementById('u-submit-btn');
  const editId = btn.dataset.editId;
  const username = document.getElementById('u-username').value.trim();
  const password = document.getElementById('u-password').value;

  const dupUsername = db.users.some(u => u.username.toLowerCase() === username.toLowerCase() && u.id !== editId);
  if (dupUsername) { showToast('Já existe um usuário com esse login.', 'error'); return; }
  if (!editId && !password) { showToast('Informe uma senha para o novo usuário.', 'error'); return; }

  const existing = editId ? db.users.find(u => u.id === editId) : null;
  const passwordHash = password ? await hashPassword(password) : existing?.passwordHash;
  const role = document.getElementById('u-role').value;

  // Regra de empresa: Administrador Geral não tem empresa; os demais são obrigatoriamente
  // vinculados a uma empresa. Só o Administrador Geral pode escolher/alterar a empresa de um
  // usuário ou criar outro Administrador Geral — os demais papéis sempre criam dentro da própria empresa.
  if (role === 'admin_geral' && currentUser.role !== 'admin_geral') {
    showToast('Apenas o Administrador Geral pode criar outro Administrador Geral.', 'error'); return;
  }
  let empresaId;
  if (role === 'admin_geral') {
    empresaId = null;
  } else if (currentUser.role === 'admin_geral') {
    const empresaSel = document.getElementById('u-empresa');
    empresaId = empresaSel ? empresaSel.value : (existing?.empresaId || null);
    if (!empresaId) { showToast('Selecione a empresa do usuário.', 'error'); return; }
  } else {
    empresaId = currentUser.empresaId; // usuário comum só pode cadastrar/editar dentro da própria empresa
  }

  const record = {
    id: editId || uid(),
    name: document.getElementById('u-name').value.trim(),
    username, passwordHash,
    role, empresaId,
    permissionsOverride: collectPermissionOverride(),
    active: existing ? existing.active : true,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  if (editId) {
    dbFull.users = dbFull.users.map(u => u.id === editId ? record : u);
    if (currentUser.id === editId) currentUser = record; // atualiza sessão se for o próprio usuário
    logAudit('update', 'user', record.id, record.name, redactUser(existing), redactUser(record));
    showToast('Usuário atualizado!', 'success');
  } else {
    dbFull.users.push(record);
    logAudit('create', 'user', record.id, record.name, null, redactUser(record));
    showToast('Usuário cadastrado!', 'success');
  }
  rebuildView();
  saveDB(); resetUserForm(); renderUserList(); updateUserBadge();
}
function redactUser(u) { if (!u) return null; const { passwordHash, ...rest } = u; return rest; }

function editUser(id) {
  const u = db.users.find(u => u.id === id); if (!u) return;
  document.getElementById('u-name').value = u.name;
  document.getElementById('u-username').value = u.username;
  document.getElementById('u-role').value = u.role;
  const empresaSel = document.getElementById('u-empresa');
  if (empresaSel) empresaSel.value = u.empresaId || '';
  toggleUserEmpresaField();
  document.getElementById('u-password').value = '';
  document.getElementById('u-password').placeholder = 'Deixe em branco para manter a senha atual';
  document.getElementById('u-password').required = false;
  document.getElementById('u-custom-perms').checked = !!u.permissionsOverride;
  renderPermissionMatrix(u.permissionsOverride, u.role);
  togglePermissionMatrix();
  const btn = document.getElementById('u-submit-btn');
  btn.dataset.editId = id; btn.textContent = 'Salvar Alterações';
  scrollMainContent(0);
}

function toggleUserActive(id) {
  const u = db.users.find(u => u.id === id); if (!u) return;
  if (u.id === currentUser.id) { showToast('Você não pode desativar seu próprio usuário.', 'error'); return; }
  if (u.active !== false && (u.role === 'admin' || u.role === 'admin_geral') &&
      db.users.filter(x => x.role === u.role && x.active !== false).length <= 1) {
    showToast('Não é possível desativar o último administrador ativo' + (u.role === 'admin' ? ' da empresa' : ' geral') + '.', 'error'); return;
  }
  const before = u.active;
  u.active = u.active === false ? true : false;
  logAudit(u.active ? 'activate' : 'deactivate', 'user', u.id, u.name, { active: before }, { active: u.active });
  saveDB(); renderUserList();
  showToast(u.active ? 'Usuário reativado.' : 'Usuário desativado.', 'success');
}

function deleteUser(id) {
  if (id === currentUser.id) { showToast('Você não pode excluir seu próprio usuário.', 'error'); return; }
  const target = db.users.find(u => u.id === id);
  if (target && (target.role === 'admin' || target.role === 'admin_geral') &&
      db.users.filter(u => u.role === target.role).length <= 1) {
    showToast('Não é possível excluir o último administrador' + (target.role === 'admin' ? ' da empresa' : ' geral') + '.', 'error'); return;
  }
  confirmDialog('Excluir este usuário? Ele perderá acesso imediatamente.', () => {
    dbFull.users = dbFull.users.filter(u => u.id !== id);
    logAudit('delete', 'user', id, target?.name, redactUser(target), null);
    saveDB(); renderUserList();
    showToast('Usuário excluído.', 'success');
  });
}

function renderUserList() {
  const el = document.getElementById('user-list'); if (!el) return;
  if (!db.users.length) { el.innerHTML = emptyState('👤', 'Nenhum usuário cadastrado', ''); return; }
  el.innerHTML = `<div class="panel"><div class="panel-header"><span class="panel-title">Usuários (${db.users.length})</span></div>
    <div class="panel-body" style="padding:0">
    ${db.users.map(u => { const empresa = dbFull.companies.find(c => c.id === u.empresaId); return `<div class="record-item">
      <div class="record-stripe" style="background:${u.role==='admin_geral'?'#7C3AED':u.role==='admin'?'var(--danger)':u.role==='gestor'?'var(--accent)':'var(--text-muted)'}"></div>
      <div class="record-body">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
          <strong>${u.name}</strong>
          <span class="badge role-badge-${u.role}">${ROLE_LABELS[u.role]}</span>
          ${currentUser.role === 'admin_geral' ? `<span class="badge badge-blue">${empresa ? empresa.name : 'Todas as empresas'}</span>` : ''}
          ${u.active === false ? '<span class="badge badge-red">Desativado</span>' : ''}
          ${u.id === currentUser.id ? '<span class="badge badge-blue">Você</span>' : ''}
        </div>
        <div class="record-meta"><span><strong>Login:</strong> ${u.username}</span></div>
      </div>
      <div class="record-actions">
        <button class="btn btn-edit btn-sm" onclick="editUser('${u.id}')">Editar</button>
        <button class="btn btn-ghost btn-sm" onclick="toggleUserActive('${u.id}')">${u.active === false ? 'Reativar' : 'Desativar'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteUser('${u.id}')">Excluir</button>
      </div>
    </div>`; }).join('')}
    </div></div>`;
}

// ════════════════════════════════════════════════
// AUDITORIA
// ════════════════════════════════════════════════
const AUDIT_ACTION_LABELS = {
  create:'Criação', update:'Atualização', delete:'Exclusão',
  login:'Login', logout:'Logout', activate:'Reativação', deactivate:'Desativação',
  'status-change':'Mudança de Status', 'technician-sign':'Assinatura do Técnico',
  'financial-aprovado':'Aprovação Financeira', 'financial-corrigir':'Solicitação de Correção',
  'financial-reprovado':'Reprovação Financeira', 'final-approve':'Aprovação Final',
};
const AUDIT_ENTITY_LABELS = {
  vehicle:'Veículo', driver:'Motorista', trip:'Viagem', 'trip-approval':'Aprovação de Viagem',
  user:'Usuário', session:'Sessão', company:'Empresa',
};

function logAudit(action, entity, entityId, entityLabel, oldData, newData) {
  if (!db.auditLog) db.auditLog = [];
  dbFull.auditLog.push({
    id: uid(),
    userId: currentUser?.id || null,
    userName: currentUser?.name || 'Sistema',
    userRole: currentUser?.role || '-',
    empresaId: currentEmpresaId(),
    action, entity, entityId: entityId || null, entityLabel: entityLabel || '',
    oldData: oldData ? JSON.parse(JSON.stringify(oldData)) : null,
    newData: newData ? JSON.parse(JSON.stringify(newData)) : null,
    timestamp: new Date().toISOString(),
  });
  // Mantém no máximo 3000 registros para não inchar o arquivo JSON indefinidamente
  if (dbFull.auditLog.length > 3000) dbFull.auditLog = dbFull.auditLog.slice(-3000);
}

function populateAuditSelects() {
  const sel = document.getElementById('aud-user-filter');
  if (!sel) return;
  const cur = sel.value;
  const uniqueUsers = [...new Map(db.auditLog.map(l => [l.userId, l.userName])).entries()];
  sel.innerHTML = '<option value="">Todos os usuários</option>' + uniqueUsers.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
  if (cur) sel.value = cur;
}

function renderAuditLog() {
  const el = document.getElementById('audit-log-list'); if (!el) return;
  const userFilter = document.getElementById('aud-user-filter')?.value || '';
  const entityFilter = document.getElementById('aud-entity-filter')?.value || '';
  const fromEl = document.getElementById('aud-date-from'), toEl = document.getElementById('aud-date-to');
  const from = fromEl?.value ? new Date(fromEl.value + 'T00:00:00') : null;
  const to   = toEl?.value   ? new Date(toEl.value + 'T23:59:59') : null;

  let entries = [...(db.auditLog || [])].reverse();
  if (userFilter)   entries = entries.filter(l => l.userId === userFilter);
  if (entityFilter) entries = entries.filter(l => l.entity === entityFilter);
  if (from)         entries = entries.filter(l => new Date(l.timestamp) >= from);
  if (to)           entries = entries.filter(l => new Date(l.timestamp) <= to);
  entries = entries.slice(0, 300); // limita renderização por performance

  if (!entries.length) { el.innerHTML = emptyState('🕵️', 'Nenhum registro de auditoria encontrado', 'Ajuste os filtros ou aguarde novas ações no sistema'); return; }

  el.innerHTML = `<div class="panel"><div class="panel-header"><span class="panel-title">Registros (${entries.length}${entries.length === 300 ? '+' : ''})</span></div>
    <div class="panel-body" style="padding:0">${entries.map(l => `
      <div class="audit-entry">
        <div class="audit-entry-icon">${auditActionIcon(l.action)}</div>
        <div class="audit-entry-body">
          <div class="audit-entry-title">
            <strong>${l.userName}</strong> <span class="badge role-badge-${l.userRole}" style="margin-left:4px;">${ROLE_LABELS[l.userRole] || l.userRole}</span>
            — ${AUDIT_ACTION_LABELS[l.action] || l.action} em ${AUDIT_ENTITY_LABELS[l.entity] || l.entity}${l.entityLabel ? ' <em>(' + l.entityLabel + ')</em>' : ''}
          </div>
          <div class="audit-entry-meta">${new Date(l.timestamp).toLocaleString('pt-BR')}</div>
          ${(l.oldData || l.newData) ? `<button class="btn btn-ghost btn-sm" style="margin-top:6px;" onclick="toggleAuditDetail(this)">Ver detalhes</button>
          <div class="audit-entry-detail" style="display:none">
            ${l.oldData ? `<div><strong>Antes:</strong><pre>${escapeHtml(JSON.stringify(l.oldData, null, 2))}</pre></div>` : ''}
            ${l.newData ? `<div><strong>Depois:</strong><pre>${escapeHtml(JSON.stringify(l.newData, null, 2))}</pre></div>` : ''}
          </div>` : ''}
        </div>
      </div>`).join('')}
    </div></div>`;
}

function auditActionIcon(action) {
  const icons = { create:'➕', update:'✏️', delete:'🗑️', login:'🔓', logout:'🔒', activate:'✅', deactivate:'⛔',
    'status-change':'🔁', 'technician-sign':'✍️', 'financial-aprovado':'✅', 'financial-corrigir':'↩️',
    'financial-reprovado':'❌', 'final-approve':'🏁' };
  return icons[action] || '📄';
}
function toggleAuditDetail(btn) {
  const detail = btn.nextElementSibling;
  const open = detail.style.display !== 'none';
  detail.style.display = open ? 'none' : 'block';
  btn.textContent = open ? 'Ver detalhes' : 'Ocultar detalhes';
}
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function resetAuditFilters() {
  document.getElementById('aud-user-filter').value = '';
  document.getElementById('aud-entity-filter').value = '';
  document.getElementById('aud-date-from').value = '';
  document.getElementById('aud-date-to').value = '';
  renderAuditLog();
}

// ════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════
async function init() {
  await loadDB();
  applyBranding();
  await ensureDefaultAdmin();

  const savedId = localStorage.getItem('frotactl_session');
  let savedUser = savedId ? db.users.find(u => u.id === savedId && u.active !== false) : null;

  // ⚠️ MODO DE TESTE — ver aviso na constante SKIP_LOGIN_FOR_TESTING no topo do arquivo.
  if (!savedUser && SKIP_LOGIN_FOR_TESTING) {
    savedUser = db.users.find(u => u.role === 'admin_geral' && u.active !== false)
             || db.users.find(u => u.active !== false);
  }

  if (savedUser) {
    currentUser = savedUser;
    activeCompanyId = savedUser.role === 'admin_geral'
      ? (localStorage.getItem('frotactl_active_company') || null)
      : (savedUser.empresaId || null);
    rebuildView();
    document.body.classList.add('logged-in');
    boot();
  }
  // Se não há sessão válida, a tela de login (visível por padrão) aguarda submitLogin()
}

function boot() {
  updateUserBadge();
  applyRolePermissions();

  // Nav
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('role-hidden')) return;
      switchPage(btn.dataset.page, btn);
      document.getElementById('sidebar').classList.remove('mobile-open');
      document.getElementById('overlay').classList.remove('active');
    });
  });

  // Date topbar
  document.getElementById('topbar-date').textContent = new Date()
    .toLocaleDateString('pt-BR', { weekday:'short', day:'2-digit', month:'short', year:'numeric' })
    .toUpperCase();

  // Default dates
  ['a-date','f-date','m-date','o-date','br-date','t-departure','fn-date','ti-checkout-date'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.valueAsDate = new Date();
  });

  // Default datetime for inspection
  const insDatetime = document.getElementById('ins-datetime');
  if (insDatetime) {
    const now = new Date();
    insDatetime.value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0,16);
  }

  // Sidebar + theme
  initSidebar();
  initTheme();

  renderCompanyBadge();
  renderAllModules();
  startAutoRefresh();

  // ESC closes modal
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

// Renderiza todas as listas/painéis do app — usada no boot() e sempre que a empresa ativa muda.
function renderAllModules() {
  populateAllSelects();
  renderVehicleList();
  renderDriverList();
  renderAssignmentList();
  renderFuelList();
  renderMaintenanceList();
  renderScheduledMaintenanceList();
  renderOilList();
  renderBriefcaseList();
  renderBriefcaseToolList();
  renderBriefcaseReturnList();
  renderInspectionList();
  renderScheduleList();
  renderTripList();
  renderUserList();
  renderFineList();
  renderWeeklyTermsPage();
  renderTempItemList();
  renderToolList();
  renderDashboard();
  renderAlertsPage();
  if (typeof renderCompanyList === 'function') renderCompanyList();
}

// ── EMPRESA ATIVA (badge no topo + seletor para Administrador Geral) ──
function renderCompanyBadge() {
  const el = document.getElementById('company-badge');
  if (!el || !currentUser) return;

  // Enquanto o Administrador Geral estiver vendo "Todas as Empresas", os formulários de
  // cadastro ficam bloqueados — não faz sentido criar um registro sem saber a qual empresa ele pertence.
  document.body.classList.toggle('company-readonly', currentUser.role === 'admin_geral' && !activeCompanyId);

  if (currentUser.role === 'admin_geral') {
    const options = ['<option value="">Todas as Empresas</option>']
      .concat(dbFull.companies.map(c => `<option value="${c.id}" ${c.id === activeCompanyId ? 'selected' : ''}>${c.name}</option>`));
    el.innerHTML = `<select id="company-switcher" onchange="onCompanySwitcherChange(this.value)" title="Empresa em visualização">${options.join('')}</select>`;
  } else {
    const company = dbFull.companies.find(c => c.id === currentUser.empresaId);
    el.innerHTML = `<span class="badge badge-blue">${company ? company.name : 'Sem empresa'}</span>`;
  }
}
function onCompanySwitcherChange(companyId) {
  localStorage.setItem('frotactl_active_company', companyId || '');
  switchActiveCompany(companyId || null);
}

document.addEventListener('DOMContentLoaded', init);
