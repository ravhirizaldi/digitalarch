-- Keep batch predicates pushable below the numbering window on large archives.
CREATE OR REPLACE VIEW document_pages AS
SELECT p.*,
  CASE WHEN NOT is_excluded AND NOT replacement_candidate THEN
    (count(*) FILTER(WHERE NOT is_excluded AND NOT replacement_candidate)
      OVER(PARTITION BY batch_id,document_id ORDER BY display_order,capture_order ROWS UNBOUNDED PRECEDING))::integer
  END AS page_number
FROM pages p;
