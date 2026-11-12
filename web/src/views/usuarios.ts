import type { Ctx } from '../main';
import { addMember, getRolePermissions, listMembers, listPosUsers, removeMember, type Member, type PosUser, type RolePermissions } from '../api';
import { askConfirm, esc, fmtDate, icon, paintIcons, toast } from '../ui';
import { askResetPassword } from './cuentas-ui';

// Mismas etiquetas que la pantalla de Permisos de la app (PERM_LABELS en src/index.html)
const PERM_LABELS: Record<string, string> = {
  settings: 'Personalización / configuración general',
  catalogs: 'Catálogos (categorías, unidades, proveedores)',
  products: 'Agregar y editar productos',
  movements: 'Entradas, salidas y mermas',
  counts: 'Conteos de inventario',
  cashcut: 'Abrir caja y hacer cortes X/Z',
};
const ROLE_LABEL: Record<string, string> = { admin: 'Administrador', encargado: 'Encargado', cajero: 'Cajero' };
const MEMBER_LABEL: Record<string, string> = { owner: 'Dueño', gestor: 'Gestor (solo consulta)' };

export async function renderUsuarios(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Quién usa la caja y quién entra a este panel';
  el.innerHTML = '<div class="card empty">Cargando…</div>';
  let users: PosUser[] = [];
  let perms: RolePermissions | null = null;
  try {
    [users, perms] = await Promise.all([listPosUsers(ctx.business.id), getRolePermissions(ctx.business.id)]);
  } catch (e) {
    el.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
    return;
  }
  const roles = ['encargado', 'cajero'];
  el.innerHTML = `
    <div class="section-title" style="margin-top:0">${icon('users')} Usuarios de la caja</div>
    ${users.length ? `<ul class="list card">${users.map((u) => `<li>
        <div class="grow"><div><b>${esc(u.display_name || 'Sin nombre')}</b></div></div>
        <span class="pill ${u.role === 'admin' ? 'ok' : 'off'}">${esc(ROLE_LABEL[u.role ?? ''] ?? u.role ?? '—')}</span>
        ${u.active === false ? '<span class="pill bad">Inactivo</span>' : ''}</li>`).join('')}</ul>`
      : '<div class="card empty small">La caja aún no ha enviado sus usuarios.</div>'}
    <p class="small muted">Los usuarios y contraseñas de la caja se cambian en la caja (Configuración → Usuarios).</p>

    <div class="section-title">${icon('shield-check')} Permisos por rol</div>
    ${perms ? `<div class="card table-wrap"><table class="table">
        <thead><tr><th>Puede, sin pedir autorización</th>${roles.map((r) => `<th class="center">${ROLE_LABEL[r]}</th>`).join('')}</tr></thead>
        <tbody>${Object.entries(PERM_LABELS).map(([k, label]) => `<tr><td>${esc(label)}</td>${roles.map((r) =>
          `<td class="center">${perms![r]?.[k] ? `<span class="pill ok">${icon('check')} Sí</span>` : '<span class="pill off">No</span>'}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
        <p class="small muted">El administrador siempre tiene acceso completo. Todos los roles pueden cobrar.</p>`
      : '<div class="card empty small">La caja aún no ha enviado sus permisos.</div>'}

    ${ctx.canManageDevices ? '<div class="section-title">' + icon('key-round') + ' Accesos a este panel</div><div id="members"><div class="card empty small">Cargando…</div></div>' : ''}`;
  paintIcons();
  if (ctx.canManageDevices) await drawMembers(ctx, el.querySelector('#members')!);
}

async function drawMembers(ctx: Ctx, box: HTMLElement) {
  let members: Member[] = [];
  try {
    members = await listMembers(ctx.business.id);
  } catch (e) {
    box.innerHTML = `<div class="card empty small">No se pudo cargar: ${esc((e as Error).message)}</div>`;
    return;
  }
  const isSuper = ctx.role === 'superadmin';
  // El dueño solo puede quitar gestores; el superadmin, a cualquiera
  const canRemove = (m: Member) => isSuper || m.role === 'gestor';
  box.innerHTML = `
    ${members.length ? `<ul class="list card">${members.map((m) => `<li>
        <div class="grow"><div><b>${esc(m.email)}</b></div><div class="small muted">Desde ${fmtDate(m.created_at)}</div></div>
        ${isSuper
          ? `<select data-role="${m.user_id}" aria-label="Acceso de ${esc(m.email)}">${(['gestor', 'owner'] as const).map((r) =>
              `<option value="${r}"${m.role === r ? ' selected' : ''}>${MEMBER_LABEL[r]}</option>`).join('')}</select>`
          : `<span class="pill ${m.role === 'owner' ? 'ok' : 'off'}">${MEMBER_LABEL[m.role]}</span>`}
        ${isSuper ? `<button class="icon-btn" data-reset="${m.user_id}" aria-label="Restablecer contraseña" title="Restablecer contraseña">${icon('key-round')}</button>` : ''}
        ${canRemove(m) ? `<button class="icon-btn" data-remove="${m.user_id}" aria-label="Quitar acceso" title="Quitar acceso">${icon('trash-2')}</button>` : ''}
      </li>`).join('')}</ul>` : '<div class="card empty small">Nadie más tiene acceso todavía.</div>'}
    <form class="card pad" id="add" style="margin-top:12px">
      <div style="font-weight:600;margin-bottom:6px">${icon('user-plus')} Dar acceso</div>
      <p class="small muted" style="margin:0 0 10px">${isSuper ? 'Si la persona aún no tiene cuenta, créala en Tiendas → Crear cuenta.' : 'La persona ya debe tener cuenta; las crea el administrador del sistema.'}</p>
      <div class="filters" style="margin:0">
        <label class="grow-field">Correo<input type="email" id="m-email" required placeholder="correo@ejemplo.com" autocomplete="off"></label>
        <label>Acceso<select id="m-role">
          <option value="gestor">${MEMBER_LABEL.gestor}</option>
          ${isSuper ? `<option value="owner">${MEMBER_LABEL.owner}</option>` : ''}</select></label>
        <button class="btn primary" type="submit">${icon('user-plus')} Dar acceso</button>
      </div>
      <p class="small muted" style="margin:10px 0 0">El gestor ve ventas, cortes, inventario, movimientos y reportes, pero no aprueba cajas ni da accesos.${isSuper ? ' El dueño además aprueba cajas y da accesos a gestores.' : ''}</p>
    </form>`;
  paintIcons();
  box.querySelector<HTMLFormElement>('#add')!.onsubmit = async (e) => {
    e.preventDefault();
    const email = box.querySelector<HTMLInputElement>('#m-email')!.value.trim();
    const role = box.querySelector<HTMLSelectElement>('#m-role')!.value as 'owner' | 'gestor';
    if (!await askConfirm(`¿Dar acceso de ${MEMBER_LABEL[role]} a ${email} en "${ctx.business.name || ctx.business.license_key}"?`)) return;
    try {
      await addMember(ctx.business.id, email, role);
      toast('Acceso agregado');
      await drawMembers(ctx, box);
    } catch (err) {
      const text = (err as Error).message;
      toast(text.includes('aún no tiene cuenta') ? 'Ese correo aún no tiene cuenta. Las cuentas las crea el administrador del sistema.' : text);
    }
  };
  box.querySelectorAll<HTMLButtonElement>('[data-reset]').forEach((b) => {
    b.onclick = () => {
      const m = members.find((x) => x.user_id === b.dataset.reset)!;
      void askResetPassword(m.user_id, m.email);
    };
  });
  // Cambiar de gestor a dueño o al revés (solo el superadmin ve el selector)
  box.querySelectorAll<HTMLSelectElement>('[data-role]').forEach((s) => {
    s.onchange = async () => {
      const m = members.find((x) => x.user_id === s.dataset.role)!;
      const role = s.value as Member['role'];
      if (!await askConfirm(`¿Cambiar a ${m.email} de ${MEMBER_LABEL[m.role]} a ${MEMBER_LABEL[role]}?`)) { s.value = m.role; return; }
      s.disabled = true;
      try {
        await addMember(ctx.business.id, m.email, role);
        toast('Acceso cambiado');
        await drawMembers(ctx, box);
      } catch (err) {
        s.value = m.role;
        s.disabled = false;
        toast((err as Error).message);
      }
    };
  });
  box.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) => {
    b.onclick = async () => {
      const m = members.find((x) => x.user_id === b.dataset.remove)!;
      if (!await askConfirm(`¿Quitar el acceso de ${m.email}?\n\nYa no podrá ver este negocio en el panel. Su cuenta no se borra.`)) return;
      try {
        await removeMember(ctx.business.id, m.user_id);
        toast('Acceso quitado');
        await drawMembers(ctx, box);
      } catch (err) {
        toast((err as Error).message);
      }
    };
  });
}
