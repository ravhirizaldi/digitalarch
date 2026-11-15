const tables = {
  registration: 'viewer_registration_audit',
  access: 'viewer_access_audit',
  activity: 'viewer_activity_audit',
  download: 'viewer_download_audit',
};

export const isViewer = (user) => user?.roles?.includes('archive_viewer');

export async function viewerAudit(
  client,
  category,
  user,
  action,
  { subjectId = null, batchId = null, documentId = null, downloadId = null, metadata = {} } = {},
) {
  if (!Object.hasOwn(tables, category)) throw new Error('Unknown viewer audit category');
  await client.query(
    `INSERT INTO ${tables[category]}(actor_id,subject_user_id,batch_id,document_id,action,metadata,correlation_id${category === 'download' ? ',download_id' : ''})
      VALUES($1,$2,$3,$4,$5,$6,$7${category === 'download' ? ',$8' : ''})`,
    [
      user?.id || null,
      subjectId,
      batchId,
      documentId,
      `viewer_${category}.${action}`,
      metadata,
      user?.correlationId || null,
      ...(category === 'download' ? [downloadId] : []),
    ],
  );
}
