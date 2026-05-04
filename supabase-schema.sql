-- =============================================
-- Lumin Lending Deals - Supabase Schema
-- Run this entire file in the Supabase SQL Editor
-- =============================================

CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Borrower Info
  name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,

  -- Pipeline
  status TEXT NOT NULL DEFAULT 'Client',
  pipeline_group TEXT NOT NULL DEFAULT 'LEADS',

  -- Team
  loan_officer TEXT,
  processor TEXT,
  processor_status TEXT,

  -- Loan Details
  loan_type TEXT,
  loan_amount NUMERIC,
  estimated_value NUMERIC,
  revenue NUMERIC,
  rate NUMERIC,
  investor TEXT,
  property_address TEXT,
  occupancy TEXT,

  -- Lock Info
  locked TEXT DEFAULT 'No',
  lock_expiration DATE,

  -- Appraisal
  appraisal_status TEXT DEFAULT 'Need to order',

  -- Source
  source TEXT,
  broker_corr TEXT,
  lead_source_agg TEXT,

  -- File Numbers
  arive_file_no TEXT,
  investor_file_no TEXT,

  -- Notes
  lo_notes TEXT,
  client_notes TEXT,

  -- Flags
  subbed BOOLEAN DEFAULT false,

  -- Dates
  signing_date DATE,
  paid_date DATE,
  funded_date DATE,
  last_contacted DATE,

  -- GHL Integration
  ghl_contact_id TEXT,

  -- Links
  document_upload_link TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_deals_updated_at
  BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Index for fast GHL lookups
CREATE INDEX IF NOT EXISTS deals_ghl_contact_id_idx ON deals(ghl_contact_id);
CREATE INDEX IF NOT EXISTS deals_status_idx ON deals(status);
CREATE INDEX IF NOT EXISTS deals_loan_officer_idx ON deals(loan_officer);
CREATE INDEX IF NOT EXISTS deals_pipeline_group_idx ON deals(pipeline_group);
CREATE INDEX IF NOT EXISTS deals_created_at_idx ON deals(created_at DESC);

-- Disable Row Level Security for internal app (all users are trusted team members)
ALTER TABLE deals DISABLE ROW LEVEL SECURITY;
