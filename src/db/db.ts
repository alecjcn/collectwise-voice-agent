import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number TEXT NOT NULL UNIQUE,
  debtor_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  last4_ssn TEXT NOT NULL CHECK (length(last4_ssn) = 4),
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('delinquent', 'in_dispute', 'settled', 'paid', 'closed')),
  client_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS verification_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  plan_type TEXT NOT NULL CHECK (plan_type IN ('pay_in_full', 'installments', 'settlement')),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  num_installments INTEGER NOT NULL CHECK (num_installments BETWEEN 1 AND 24),
  installment_cents INTEGER NOT NULL CHECK (installment_cents > 0),
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'promise_to_pay_full', 'payment_plan_agreed', 'settlement_agreed',
    'wrong_person', 'verification_failed', 'account_not_found',
    'dispute', 'escalated', 'callback_requested', 'no_agreement', 'incomplete'
  )),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_phone ON accounts(phone_number);
CREATE INDEX IF NOT EXISTS idx_outcomes_call ON call_outcomes(call_id);
`;

/**
 * Open (creating directories and schema as needed) a SQLite database.
 *
 * There are no migrations (POC): "IF NOT EXISTS" leaves an existing file's
 * tables untouched, so after any SCHEMA change, delete the local database
 * file — it reseeds automatically on the next start.
 */
export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
