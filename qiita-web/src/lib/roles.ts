// System roles that pass the server's wet_lab_admin-or-higher gates (ENA import,
// listing every user's work tickets). The server enforces these; the UI only
// uses this to decide which controls to show.
const ADMIN_ROLES = new Set(['wet_lab_admin', 'system_admin']);

export function isAdminRole(systemRole: string | undefined): boolean {
  return !!systemRole && ADMIN_ROLES.has(systemRole);
}

/** system_admin only — the role the admin console's actions require (the server
 *  enforces it; this decides whether to show the console). */
export function isSystemAdmin(systemRole: string | undefined): boolean {
  return systemRole === 'system_admin';
}
