import {
  createIcons, ArrowLeftRight, Ban, Calculator, ChartColumn, Check, ChevronRight, Download, House, Info, KeyRound,
  LayoutGrid, LogIn, LogOut, MonitorSmartphone, Package, Receipt, Search, Settings, ShieldAlert, Store, Trash2,
  TriangleAlert, UserPlus, Users, X,
} from 'lucide';

// Solo los iconos que se usan (importar todos pesaba ~900 KB)
const icons = {
  ArrowLeftRight, Ban, Calculator, ChartColumn, Check, ChevronRight, Download, House, Info, KeyRound,
  LayoutGrid, LogIn, LogOut, MonitorSmartphone, Package, Receipt, Search, Settings, ShieldAlert, Store, Trash2,
  TriangleAlert, UserPlus, Users, X,
};

// ---------- formato ----------

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
export const fmtMoney = (v: number | null | undefined) => money.format(v ?? 0);
export const fmtQty = (v: number | null | undefined) => (v ?? 0).toLocaleString('es-MX', { maximumFractionDigits: 3 });

export const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
export const fmtDateTime = (iso: string | null) => (iso ? `${fmtDate(iso)}, ${fmtTime(iso)}` : '—');
export const fmtToday = () =>
  new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });

export function ago(iso: string | null): string {
  if (!iso) return 'nunca';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

// Rango de un día local [inicio, fin)
export function dayRange(isoDate: string): [Date, Date] {
  const [y, m, d] = isoDate.split('-').map(Number);
  return [new Date(y, m - 1, d), new Date(y, m - 1, d + 1)];
}
export function todayIso(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

// ---------- html ----------

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export const icon = (name: string) => `<i data-lucide="${name}"></i>`;
export function paintIcons() { createIcons({ icons }); }

export function toast(msg: string) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

// Hoja lateral para ver un detalle. Se cierra tocando fuera, con la X o con Escape.
export function openSheet(title: string, bodyHtml: string): HTMLElement {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" aria-label="Cerrar">${icon('x')}</button></div>
    <div class="sheet-body">${bodyHtml}</div></div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelector('.icon-btn')!.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(bg);
  paintIcons();
  return bg.querySelector('.sheet-body') as HTMLElement;
}

// Mismo criterio que la app (codeKey en src/index.html, norm_code en main.rs): solo letras y números, sin ceros a la izquierda
export const codeKey = (v: unknown) => String(v ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase().replace(/^0+/, '');

// Fecha local "YYYY-MM-DD" de hace N días
export function daysAgoIso(days: number): string {
  const t = new Date();
  t.setDate(t.getDate() - days);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
// Rango local [desde 00:00, hasta el día siguiente 00:00)
export function rangeOf(fromIso: string, toIso: string): [Date, Date] {
  return [dayRange(fromIso)[0], dayRange(toIso)[1]];
}

// Descarga un CSV que Excel abre con acentos (BOM UTF-8)
export function downloadCsv(name: string, header: string[], rows: unknown[][]) {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '\ufeff' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
