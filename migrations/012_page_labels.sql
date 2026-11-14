ALTER TABLE pages ADD COLUMN page_label TEXT
  CHECK(page_label IS NULL OR (length(page_label) BETWEEN 1 AND 120 AND page_label=btrim(page_label)));

-- Number the included document, not its retained capture history or a filtered UI window.
CREATE VIEW document_pages AS
SELECT p.*,
  CASE WHEN NOT is_excluded AND NOT replacement_candidate THEN
    (count(*) FILTER(WHERE NOT is_excluded AND NOT replacement_candidate)
      OVER(PARTITION BY document_id ORDER BY display_order,capture_order ROWS UNBOUNDED PRECEDING))::integer
  END AS page_number
FROM pages p;
