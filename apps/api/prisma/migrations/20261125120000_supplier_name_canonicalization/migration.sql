-- Make PostgreSQL the canonical source for supplier-name normalization.
-- Existing rows are normalized before the stronger invariant is installed.

UPDATE "suppliers"
SET
    "name_normalized" = upper(btrim(normalize("name", NFKC))),
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "name_normalized" IS DISTINCT FROM
    upper(btrim(normalize("name", NFKC)));

ALTER TABLE "suppliers"
    DROP CONSTRAINT "suppliers_name_normalized_check";

ALTER TABLE "suppliers"
    ADD CONSTRAINT "suppliers_name_normalized_check"
    CHECK (
        "name_normalized" = upper(btrim(normalize("name", NFKC)))
        AND length(btrim("name_normalized")) > 0
    );
