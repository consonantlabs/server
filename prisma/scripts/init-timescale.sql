-- =============================================================================
-- TIMESCALEDB INITIALIZATION SCRIPT
-- =============================================================================
--
-- This script converts regular PostgreSQL tables to TimescaleDB hypertables
-- for optimal time-series data storage and query performance.
--
-- WHAT ARE HYPERTABLES?
-- Hypertables are TimescaleDB's abstraction for time-series data. They
-- automatically partition data by time into "chunks" which can be:
-- - Compressed to save 90%+ storage space
-- - Dropped automatically when data ages out (retention policies)
-- - Queried efficiently with time-based filters
--
-- WHEN TO RUN THIS:
-- Run this script AFTER running Prisma migrations to create the base tables.
-- The script is idempotent - it's safe to run multiple times.
--
-- USAGE:
--   psql $DATABASE_URL -f scripts/init-timescale.sql
--   or
--   npm run setup:timescale

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- =============================================================================
-- CONVERT LOGS TABLE TO HYPERTABLE
-- =============================================================================
--
-- The logs table stores stdout/stderr from running agents. It grows quickly
-- and has heavy write traffic. Hypertables give us:
-- - Automatic time-based partitioning (1-day chunks)
-- - Compression (saves 90%+ space after 7 days)
-- - Fast time-range queries
-- - Automatic data retention (delete logs older than 90 days)

-- Check if logs is already a hypertable
SELECT CASE 
  WHEN EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables 
    WHERE hypertable_name = 'logs'
  )
  THEN 'Logs table is already a hypertable'
  ELSE (
    -- Convert to hypertable with 1-day chunks
    SELECT format('Converted logs table to hypertable: %s', 
      create_hypertable(
        'logs',
        'timestamp',
        chunk_time_interval => INTERVAL '1 day',
        if_not_exists => TRUE
      )
    )
  )
END AS result;

-- Enable compression on logs older than 7 days
-- This saves massive amounts of storage space
ALTER TABLE logs SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'execution_id',
  timescaledb.compress_orderby = 'timestamp DESC'
);

-- Add compression policy
SELECT add_compression_policy(
  'logs',
  INTERVAL '7 days',
  if_not_exists => TRUE
);

-- Add retention policy: delete logs older than 90 days
SELECT add_retention_policy(
  'logs',
  INTERVAL '90 days',
  if_not_exists => TRUE
);

-- =============================================================================
-- CONVERT TRACES TABLE TO HYPERTABLE
-- =============================================================================
--
-- The traces table stores OpenTelemetry spans showing detailed execution
-- timelines. Similar characteristics to logs - high write volume, time-series
-- nature, good compression potential.

SELECT CASE 
  WHEN EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables 
    WHERE hypertable_name = 'traces'
  )
  THEN 'Traces table is already a hypertable'
  ELSE (
    SELECT format('Converted traces table to hypertable: %s', 
      create_hypertable(
        'traces',
        'timestamp',
        chunk_time_interval => INTERVAL '1 day',
        if_not_exists => TRUE
      )
    )
  )
END AS result;

-- Enable compression
ALTER TABLE traces SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'execution_id,trace_id',
  timescaledb.compress_orderby = 'timestamp DESC'
);

SELECT add_compression_policy(
  'traces',
  INTERVAL '7 days',
  if_not_exists => TRUE
);

-- Retention: 90 days
SELECT add_retention_policy(
  'traces',
  INTERVAL '90 days',
  if_not_exists => TRUE
);

-- =============================================================================
-- CONVERT METRICS TABLE TO HYPERTABLE
-- =============================================================================
--
-- The metrics table stores resource usage measurements collected during
-- execution. Much higher write frequency than logs/traces (every few seconds)
-- so we use smaller 1-hour chunks for better insertion performance.

SELECT CASE 
  WHEN EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables 
    WHERE hypertable_name = 'metrics'
  )
  THEN 'Metrics table is already a hypertable'
  ELSE (
    SELECT format('Converted metrics table to hypertable: %s', 
      create_hypertable(
        'metrics',
        'timestamp',
        chunk_time_interval => INTERVAL '1 hour',
        if_not_exists => TRUE
      )
    )
  )
END AS result;

-- Enable compression
ALTER TABLE metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'execution_id,name',
  timescaledb.compress_orderby = 'timestamp DESC'
);

-- Compress after 24 hours (metrics accessed more frequently than logs)
SELECT add_compression_policy(
  'metrics',
  INTERVAL '24 hours',
  if_not_exists => TRUE
);

-- Retention: 30 days (less than logs/traces as they're less critical)
SELECT add_retention_policy(
  'metrics',
  INTERVAL '30 days',
  if_not_exists => TRUE
);

-- =============================================================================
-- CREATE CONTINUOUS AGGREGATES (OPTIONAL PERFORMANCE OPTIMIZATION)
-- =============================================================================
--
-- Continuous aggregates are materialized views that TimescaleDB automatically
-- keeps up to date. They're perfect for dashboard queries that need to show
-- aggregated metrics (e.g., "executions per day", "average duration by agent").

-- Daily execution statistics
CREATE MATERIALIZED VIEW IF NOT EXISTS execution_stats_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', created_at) AS day,
  agent_id,
  status,
  COUNT(*) AS execution_count,
  AVG(duration_ms) AS avg_duration_ms,
  MIN(duration_ms) AS min_duration_ms,
  MAX(duration_ms) AS max_duration_ms
FROM executions
WHERE created_at >= NOW() - INTERVAL '90 days'
GROUP BY day, agent_id, status;

-- Refresh policy for continuous aggregate
SELECT add_continuous_aggregate_policy(
  'execution_stats_daily',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- =============================================================================
-- INDEXES FOR COMMON QUERIES
-- =============================================================================
--
-- These indexes speed up common time-series queries.
-- TimescaleDB creates some automatically, but we add a few more.

-- Fast log searching by level and time
CREATE INDEX IF NOT EXISTS idx_logs_level_timestamp 
  ON logs (level, timestamp DESC) 
  WHERE level IN ('error', 'warn');

-- Fast trace searching by trace ID
CREATE INDEX IF NOT EXISTS idx_traces_trace_id_timestamp 
  ON traces (trace_id, timestamp DESC);

-- Fast metric aggregation
CREATE INDEX IF NOT EXISTS idx_metrics_name_timestamp 
  ON metrics (name, timestamp DESC);

-- =============================================================================
-- VERIFICATION
-- =============================================================================

-- Show all hypertables and their configuration
SELECT 
  hypertable_name,
  num_dimensions,
  num_chunks,
  compression_enabled,
  compression_status,
  retention_policy
FROM timescaledb_information.hypertables;

-- Show storage savings from compression
SELECT 
  pg_size_pretty(before_compression_total_bytes) AS uncompressed_size,
  pg_size_pretty(after_compression_total_bytes) AS compressed_size,
  round(100 - (after_compression_total_bytes::numeric / before_compression_total_bytes::numeric * 100), 2) AS compression_ratio
FROM timescaledb_information.compression_settings;

\echo '✓ TimescaleDB initialization complete'