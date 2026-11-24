-- Catalogue records are archived through audited state changes, not deleted.
REVOKE DELETE ON TABLE
    "categories", "brands", "products", "product_variants", "product_identifiers", "product_prices"
FROM serviceflow_app;

-- Price history may only close an open price interval. Amount, currency,
-- ownership and historical timestamps are immutable after insertion.
CREATE FUNCTION public.protect_product_price_history()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Product price history cannot be deleted.'
            USING ERRCODE = '42501';
    END IF;

    IF OLD.valid_to IS NOT NULL
       OR NEW.valid_to IS NULL
       OR NEW.valid_to <= OLD.valid_from
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
       OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'A price can only be closed once without changing its historical value.'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER "product_prices_history_immutable"
    BEFORE UPDATE OR DELETE ON "product_prices"
    FOR EACH ROW EXECUTE FUNCTION public.protect_product_price_history();

REVOKE UPDATE, DELETE ON TABLE "product_prices" FROM serviceflow_app;
GRANT SELECT, INSERT ON TABLE "product_prices" TO serviceflow_app;
GRANT UPDATE ("valid_to") ON TABLE "product_prices" TO serviceflow_app;
