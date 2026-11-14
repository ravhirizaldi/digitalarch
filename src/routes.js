const routes = {
  home: { path: '/capture', permission: 'batches:create' },
  batches: { path: '/batches', permission: 'batches:read' },
  scanner: { path: '/scanner', permission: 'batches:create' },
  ocr: { path: '/ocr', permission: 'ocr:read' },
  qc: { path: '/qc', permission: 'qc:read' },
  document: { path: '/documents', permission: null },
  users: { path: '/admin/users', permission: 'users:read' },
  assignments: { path: '/admin/batches', permission: 'batches:reassign' },
  audit: { path: '/admin/audit', permission: 'audit:read' },
  system: { path: '/admin/system', permission: 'system:read' },
  settings: { path: '/settings', permission: 'settings:read' },
  future: { path: '/workspace', permission: null },
};

export function matchRoute(pathname) {
  if (pathname === '/' || pathname === '/index.html') return { view: null, batchId: null };
  const view = Object.keys(routes).find((key) => routes[key].path === pathname);
  if (view) return { view, batchId: null };
  const job = pathname.match(
    /^\/ocr\/jobs\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i,
  );
  if (job) return { view: 'ocr', batchId: null, jobId: job[1] };
  const document = pathname.match(/^\/(?:qc|documents)\/([a-f0-9-]{36})$/i);
  if (document) return { view: 'document', batchId: null, documentBatchId: document[1] };
  const batch = pathname.match(
    /^\/scanner\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i,
  );
  return batch ? { view: 'scanner', batchId: batch[1] } : null;
}

export function routePath(view, batchId = null) {
  if (view === 'ocr' && batchId) return `/ocr/jobs/${batchId}`;
  if (view === 'document' && batchId) return `/documents/${batchId}`;
  return view === 'scanner' && batchId ? `/scanner/${batchId}` : routes[view]?.path || '/';
}

export function permittedRoute(user, requested) {
  const permission = routes[requested?.view]?.permission;
  if (requested?.view && (permission === null || user.permissions.includes(permission)))
    return requested;
  return {
    view: user.permissions.includes('batches:create')
      ? 'home'
      : user.permissions.includes('users:read')
        ? 'users'
        : user.permissions.includes('qc:read')
          ? 'qc'
          : 'future',
    batchId: null,
  };
}
