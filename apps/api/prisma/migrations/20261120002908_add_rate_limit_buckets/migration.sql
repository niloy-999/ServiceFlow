-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key_hash" CHAR(64) NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "hit_count" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key_hash","window_start")
);

-- CreateIndex
CREATE INDEX "rate_limit_buckets_expires_at_idx" ON "rate_limit_buckets"("expires_at");

-- Enforce rate-limit bucket invariants.

ALTER TABLE "rate_limit_buckets"
    ADD CONSTRAINT "rate_limit_buckets_hit_count_check"
    CHECK ("hit_count" > 0);

ALTER TABLE "rate_limit_buckets"
    ADD CONSTRAINT "rate_limit_buckets_expiry_check"
    CHECK ("expires_at" > "window_start");

ALTER TABLE "rate_limit_buckets"
    ADD CONSTRAINT "rate_limit_buckets_key_hash_check"
    CHECK ("key_hash" ~ '^[0-9a-f]{64}$');
