export function pageName(page) {
  if (!page) return 'Page unavailable';
  if (page.page_label) return page.page_label;
  if (page.page_number != null) return `Page ${page.page_number}`;
  return `${page.replacement_candidate ? 'Replacement scan' : 'Removed scan'} ${page.capture_order}`;
}
