-- Strengthen serial adjustment reconciliation:
-- the exact serial identifiers and actions must match the approved proposal.

CREATE OR REPLACE FUNCTION public.assert_inventory_serial_adjustment_count(
    p_tenant_id UUID,
    p_adjustment_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
    v_adjustment RECORD;
    v_added_count BIGINT;
    v_removed_count BIGINT;
    v_track_serials BOOLEAN;
    v_expected_count BIGINT;
    v_distinct_json_serial_count BIGINT;
BEGIN
    SELECT *
      INTO v_adjustment
      FROM "inventory_adjustments"
     WHERE "tenant_id" = p_tenant_id
       AND "id" = p_adjustment_id;

    IF NOT FOUND OR v_adjustment.status <> 'APPROVED' THEN
        RETURN;
    END IF;

    SELECT "track_serials"
      INTO v_track_serials
      FROM "products"
     WHERE "tenant_id" = p_tenant_id
       AND "id" = v_adjustment.product_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Adjustment product does not exist.'
            USING ERRCODE = '23514';
    END IF;

    SELECT
        COUNT(*) FILTER (
            WHERE "added_by_adjustment_id" = p_adjustment_id
        ),
        COUNT(*) FILTER (
            WHERE "removed_by_adjustment_id" = p_adjustment_id
        )
      INTO v_added_count, v_removed_count
      FROM "inventory_serial_units"
     WHERE "tenant_id" = p_tenant_id
       AND (
           "added_by_adjustment_id" = p_adjustment_id
           OR "removed_by_adjustment_id" = p_adjustment_id
       );

    IF NOT v_track_serials THEN
        IF jsonb_array_length(v_adjustment.serial_changes) <> 0
           OR v_added_count <> 0
           OR v_removed_count <> 0 THEN
            RAISE EXCEPTION
                'Non-serial-tracked adjustments cannot contain serial changes.'
                USING ERRCODE = '23514';
        END IF;

        RETURN;
    END IF;

    v_expected_count := abs(v_adjustment.quantity_delta::bigint);

    IF jsonb_array_length(v_adjustment.serial_changes) <> v_expected_count THEN
        RAISE EXCEPTION
            'Serial change list length does not match adjustment quantity (%).',
            v_expected_count
            USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(DISTINCT item.value->>'serial')
      INTO v_distinct_json_serial_count
      FROM jsonb_array_elements(v_adjustment.serial_changes) AS item(value);

    IF v_distinct_json_serial_count <> v_expected_count THEN
        RAISE EXCEPTION
            'Serial change list contains duplicate or invalid identifiers.'
            USING ERRCODE = '23514';
    END IF;

    IF v_adjustment.quantity_delta > 0 THEN
        IF v_added_count <> v_expected_count OR v_removed_count <> 0 THEN
            RAISE EXCEPTION
                'Serial additions (%) do not match adjustment quantity (%).',
                v_added_count,
                v_expected_count
                USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
            SELECT 1
              FROM jsonb_array_elements(v_adjustment.serial_changes) AS item(value)
             WHERE (item.value->>'action') IS DISTINCT FROM 'ADD'
                OR NULLIF(btrim(item.value->>'serial'), '') IS NULL
                OR length(item.value->>'serial') > 160
                OR (item.value->>'serial')
                    IS DISTINCT FROM upper(btrim(item.value->>'serial'))
                OR NOT EXISTS (
                    SELECT 1
                      FROM "inventory_serial_units" AS serial
                     WHERE serial."tenant_id" = p_tenant_id
                       AND serial."branch_id" = v_adjustment.branch_id
                       AND serial."product_id" = v_adjustment.product_id
                       AND serial."variant_id" = v_adjustment.variant_id
                       AND serial."serial_normalized" = item.value->>'serial'
                       AND serial."added_by_adjustment_id" = p_adjustment_id
                )
        ) THEN
            RAISE EXCEPTION
                'Approved serial additions do not match the submitted serial identifiers.'
                USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
            SELECT 1
              FROM "inventory_serial_units" AS serial
             WHERE serial."tenant_id" = p_tenant_id
               AND serial."added_by_adjustment_id" = p_adjustment_id
               AND NOT EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(v_adjustment.serial_changes) AS item(value)
                    WHERE item.value->>'action' = 'ADD'
                      AND item.value->>'serial' = serial."serial_normalized"
               )
        ) THEN
            RAISE EXCEPTION
                'An added serial is not present in the approved adjustment proposal.'
                USING ERRCODE = '23514';
        END IF;

    ELSE
        IF v_removed_count <> v_expected_count OR v_added_count <> 0 THEN
            RAISE EXCEPTION
                'Serial removals (%) do not match adjustment quantity (%).',
                v_removed_count,
                v_expected_count
                USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
            SELECT 1
              FROM jsonb_array_elements(v_adjustment.serial_changes) AS item(value)
             WHERE (item.value->>'action') IS DISTINCT FROM 'REMOVE'
                OR NULLIF(btrim(item.value->>'serial'), '') IS NULL
                OR length(item.value->>'serial') > 160
                OR (item.value->>'serial')
                    IS DISTINCT FROM upper(btrim(item.value->>'serial'))
                OR NOT EXISTS (
                    SELECT 1
                      FROM "inventory_serial_units" AS serial
                     WHERE serial."tenant_id" = p_tenant_id
                       AND serial."branch_id" = v_adjustment.branch_id
                       AND serial."product_id" = v_adjustment.product_id
                       AND serial."variant_id" = v_adjustment.variant_id
                       AND serial."serial_normalized" = item.value->>'serial'
                       AND serial."removed_by_adjustment_id" = p_adjustment_id
                )
        ) THEN
            RAISE EXCEPTION
                'Approved serial removals do not match the submitted serial identifiers.'
                USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
            SELECT 1
              FROM "inventory_serial_units" AS serial
             WHERE serial."tenant_id" = p_tenant_id
               AND serial."removed_by_adjustment_id" = p_adjustment_id
               AND NOT EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(v_adjustment.serial_changes) AS item(value)
                    WHERE item.value->>'action' = 'REMOVE'
                      AND item.value->>'serial' = serial."serial_normalized"
               )
        ) THEN
            RAISE EXCEPTION
                'A removed serial is not present in the approved adjustment proposal.'
                USING ERRCODE = '23514';
        END IF;
    END IF;
END;
$function$;
