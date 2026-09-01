import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { type Account, Repository } from './repository.ts';

export const SEED_ACCOUNTS: Omit<Account, 'id'>[] = [
  {
    accountNumber: 'ATL-1001',
    debtorName: 'Maria Gonzalez',
    phoneNumber: '+15550104821',
    last4Ssn: '7301',
    balanceCents: 248975, // $2,489.75
    status: 'delinquent',
    clientName: 'Alpha Bank',
  },
  {
    accountNumber: 'ATL-1002',
    debtorName: 'David Chen',
    phoneNumber: '+15550103390',
    last4Ssn: '5544',
    balanceCents: 96050, // $960.50
    status: 'delinquent',
    clientName: 'Alpha Bank',
  },
  {
    accountNumber: 'ATL-1003',
    debtorName: 'Sarah Whitmore',
    phoneNumber: '+15550107712',
    last4Ssn: '9012',
    balanceCents: 1240000, // $12,400.00
    status: 'delinquent',
    clientName: 'Alpha Bank',
  },
  {
    accountNumber: 'ATL-1004',
    debtorName: 'James Patel',
    phoneNumber: '+15550106655',
    last4Ssn: '3376',
    balanceCents: 43200, // $432.00
    status: 'in_dispute',
    clientName: 'Alpha Bank',
  },
  {
    accountNumber: 'ATL-1005',
    debtorName: 'Linda Okafor',
    phoneNumber: '+15550102218',
    last4Ssn: '8845',
    balanceCents: 0,
    status: 'paid',
    clientName: 'Alpha Bank',
  },
];

/** Insert seed accounts if the accounts table is empty. Returns rows inserted. */
export function seedIfEmpty(repo: Repository): number {
  if (repo.countAccounts() > 0) return 0;
  for (const account of SEED_ACCOUNTS) {
    repo.insertAccount(account);
  }
  return SEED_ACCOUNTS.length;
}

export const DEFAULT_DB_PATH = process.env.DB_PATH ?? 'data/collectwise.db';

// CLI entrypoint: `pnpm db:seed`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repo = new Repository(openDb(DEFAULT_DB_PATH));
  const inserted = seedIfEmpty(repo);
  if (inserted > 0) {
    console.log(`Seeded ${inserted} accounts into ${DEFAULT_DB_PATH}`);
  } else {
    console.log(`Database at ${DEFAULT_DB_PATH} already has accounts; nothing to do.`);
  }
}
