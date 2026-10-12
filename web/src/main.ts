import './styles.css';
import { sb } from './supabase';
import { listBusinesses, listDevices, myRole, watchBusiness, type Business, type Role } from './api';
import { esc, icon, paintIcons } from './ui';
import { renderLogin } from './views/login';
import { renderInicio } from './views/inicio';
import { renderVentas } from './views/ventas';
import { renderCortes } from './views/cortes';
import { renderCajas } from './views/cajas';

export interface Ctx {
  business: Business;
  role: Role | null;
  canManageDevices: boolean;
  // las vistas se suscriben para refrescarse cuando cambia algo en la nube
  onChange(fn: (table: string) => void): void;
  // tarea periódica de la vista actual (se detiene al cambiar de sección)
  every(ms: number, fn: () => void): void;
  refreshBadge(): void;
}
export type View = (ctx: Ctx, el: HTMLElement) => Promise<void> | void;

const ROUTES: Record<string, { title: string; icon: string; view: View }> = {
  inicio: { title: 'Inicio', icon: 'house', view: renderInicio },
  ventas: { title: 'Ventas', icon: 'receipt', view: renderVentas },
  cortes: { title: 'Cortes', icon: 'calculator', view: renderCortes },
  cajas: { title: 'Cajas', icon: 'monitor-smartphone', view: renderCajas },
};

const app = document.getElementById('app')!;
const BIZ_KEY = 'panel.business';
let businesses: Business[] = [];
let email = '';
let ctx: Ctx | null = null;
let listeners: ((table: string) => void)[] = [];
let timers: number[] = [];
const clearView = () => { listeners = []; timers.forEach(clearInterval); timers = []; };
let stopWatch: (() => void) | null = null;

function route(): string {
  const r = location.hash.replace(/^#\/?/, '').split('/')[0];
  return ROUTES[r] ? r : 'inicio';
}

async function boot() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return renderLogin(app, boot);
  email = data.session.user.email ?? '';
  try {
    businesses = await listBusinesses();
  } catch (e) {
    app.innerHTML = `<div class="login-wrap"><div class="card login"><h1>${icon('triangle-alert')} Sin conexión</h1>
      <p>${esc((e as Error).message)}</p><button class="btn primary" id="retry">Reintentar</button></div></div>`;
    paintIcons();
    document.getElementById('retry')!.onclick = boot;
    return;
  }
  if (!businesses.length) {
    app.innerHTML = `<div class="login-wrap"><div class="card login"><h1>${icon('store')} Sin negocios</h1>
      <p>Tu usuario todavía no tiene negocios asignados. Pide al administrador que te agregue.</p>
      <button class="btn" id="out">Cerrar sesión</button></div></div>`;
    paintIcons();
    document.getElementById('out')!.onclick = logout;
    return;
  }
  const saved = localStorage.getItem(BIZ_KEY);
  await selectBusiness(businesses.find((b) => b.id === saved) ?? businesses[0]);
}

async function selectBusiness(business: Business) {
  localStorage.setItem(BIZ_KEY, business.id);
  stopWatch?.();
  clearView();
  const role = await myRole(business.id).catch(() => null);
  ctx = {
    business,
    role,
    canManageDevices: role === 'superadmin' || role === 'owner',
    onChange: (fn) => listeners.push(fn),
    every: (ms, fn) => timers.push(window.setInterval(fn, ms)),
    refreshBadge: () => void refreshBadge(),
  };
  stopWatch = watchBusiness(business.id, (table) => {
    listeners.forEach((fn) => fn(table));
    if (table === 'pos_devices') void refreshBadge();
  });
  render();
}

// Si dos negocios se llaman igual (p. ej. el nombre de fabrica del POS), se agrega la licencia
function bizLabel(b: Business): string {
  const name = b.name || b.license_key;
  const twins = businesses.filter((x) => (x.name || x.license_key) === name).length > 1;
  return twins ? `${name} · ${b.license_key}` : name;
}

function shell(current: string): string {
  const nav = Object.entries(ROUTES).map(([key, r]) =>
    `<a class="nav${key === current ? ' on' : ''}" href="#/${key}">${icon(r.icon)}<span>${r.title}</span>${key === 'cajas' ? '<span class="count" id="badge" hidden></span>' : ''}</a>`,
  ).join('');
  const options = businesses.map((b) =>
    `<option value="${b.id}"${b.id === ctx!.business.id ? ' selected' : ''}>${esc(bizLabel(b))}</option>`).join('');
  return `<div class="layout">
    <nav class="side" aria-label="Secciones">
      <div class="brand">${icon('store')} Tienda POS</div>
      ${nav}
      <div class="side-foot">${esc(email)}<br><button id="logout">${icon('log-out')} Salir</button></div>
    </nav>
    <main class="main">
      <div class="top">
        <div><h1>${esc(bizLabel(ctx!.business))}</h1><div class="sub" id="sub"></div></div>
        ${businesses.length > 1 ? `<select class="biz-select" id="biz" aria-label="Negocio">${options}</select>` : ''}
      </div>
      <div id="view"></div>
    </main>
  </div>`;
}

function render() {
  if (!ctx) return;
  clearView();
  const current = route();
  app.innerHTML = shell(current);
  paintIcons();
  document.getElementById('logout')!.onclick = logout;
  const biz = document.getElementById('biz') as HTMLSelectElement | null;
  if (biz) biz.onchange = () => selectBusiness(businesses.find((b) => b.id === biz.value)!);
  void refreshBadge();
  void ROUTES[current].view(ctx, document.getElementById('view')!);
}

// Globo con el número de cajas esperando aprobación
async function refreshBadge() {
  if (!ctx) return;
  const pending = (await listDevices(ctx.business.id).catch(() => [])).filter((d) => d.status === 'pendiente').length;
  const b = document.getElementById('badge');
  if (b) { b.textContent = String(pending); b.hidden = pending === 0; }
}

async function logout() {
  stopWatch?.();
  clearView();
  await sb.auth.signOut();
  ctx = null;
  location.hash = '';
  void boot();
}

window.addEventListener('hashchange', render);
sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') { ctx = null; renderLogin(app, boot); }
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

void boot();
