-- Enforce creator-only withdrawal and direct draft cancellation at the
-- database boundary, independently of the application service.

CREATE FUNCTION public.guard_purchase_order_creator_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_actor UUID;
BEGIN
    v_actor := NULLIF(current_setting('app.user_id', true), '')::uuid;

    IF OLD."status" = 'PENDING_APPROVAL'
       AND NEW."status" = 'WITHDRAWN'
       AND OLD."created_by_user_id" IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'Only the original purchase order creator can withdraw it.'
            USING ERRCODE = '42501';
    END IF;

    IF OLD."status" = 'DRAFT'
       AND NEW."status" = 'CANCELLED'
       AND OLD."created_by_user_id" IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'Only the original purchase order creator can cancel a draft.'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$function$;

-- PostgreSQL executes same-timing triggers alphabetically. This guard runs
-- before purchase_orders_protect_lifecycle.
CREATE TRIGGER "purchase_orders_creator_lifecycle_guard"
    BEFORE UPDATE ON "purchase_orders"
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_purchase_order_creator_lifecycle();
