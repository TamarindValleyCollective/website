-- Finance session 08: payment requests and spend logs, and the vouchers (bills, payment screenshots) attached to them.
--
--   * fin_payment_requests holds two kinds of record with one set of fields (docs/finance/sessions/08):
--       request  raised before paying and approved by someone other than whoever raised it (maker is not checker)
--       log      a spend already made (a UPI Circle or a direct UPI payment), recorded afterwards; needs no approval
--     The purpose written here is what the UPI page and the ledger show for the payment it is matched to, until a person writes a
--     payment note (fin_payment_notes, 0089), which stays the manual override. Nothing about the payment is copied anywhere else.
--   * A record is joined to a UPI row (upi_line_id) and/or a bank line (bank_line_id). An exact 12-digit UPI reference joins them
--     at read time with no stored link; a link is stored only when a person accepts a suggested match (matched_by/matched_at) or
--     the one-time history load found the exact reference. A line belongs to at most one live record.
--   * source 'history' is the one-time load of the old transfer-request sheet (an operator script, not a screen); those rows
--     have no requester and are always already paid.
--   * fin_vouchers (0083) gains request_id and kind: a file in the private R2 bucket (finance/vouchers/<id>.<ext>), a bill or a
--     screenshot of the payment, attached to a request or log.
--
-- Same posture as the other fin_ tables (0077): RLS on with no policies, anon/authenticated revoked, service role only.
-- Public repository: nothing here is a real name, number or UPI id.

create table fin_payment_requests (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  kind text not null check (kind in ('request', 'log')),
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'paid', 'rejected', 'cancelled')),
  source text not null default 'app' check (source in ('app', 'history')),
  -- Who raised the request, or who logged the spend (and so who paid it). Null for the history load.
  requester_id uuid references staff_users (id),
  -- The payee: a saved party, or, when none fits (a log, the history), the name as it was written.
  party_id uuid references fin_parties (id),
  recipient_text text check (recipient_text is null or length(recipient_text) between 2 and 120),
  amount_paise bigint not null check (amount_paise > 0 and amount_paise <= 10000000000),
  mode text not null check (mode in ('neft', 'upi', 'imps', 'rtgs')),
  purpose text not null check (length(purpose) between 2 and 300),
  needed_by date,
  -- A reimbursement (cash the requester spent) must have a bill: the screen and the function both require one.
  reimbursement boolean not null default false,
  -- A log: when it was paid, how (the delegate field of the brief: who paid is requester_id), and the 12-digit UPI reference.
  paid_on date,
  paid_via text check (paid_via is null or paid_via in ('direct', 'delegate')),
  upi_ref text check (upi_ref is null or upi_ref ~ '^[0-9]{12}$'),
  -- The decision on a request (approve, reject, or cancel) and the reason.
  decided_by uuid references staff_users (id),
  decided_at timestamptz,
  decision_reason text check (decision_reason is null or length(decision_reason) between 3 and 200),
  -- Where it was found in the statements.
  upi_line_id uuid references fin_upi_lines (id),
  bank_line_id uuid references fin_bank_lines (id),
  matched_by uuid references staff_users (id),
  matched_at timestamptz,
  -- Why a person should look at it (a payment to the requester's own party).
  review_flag text check (review_flag is null or review_flag in ('own_party')),
  reviewed_by uuid references staff_users (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'request' or status = 'paid'),
  check (kind = 'request' or paid_on is not null),
  check (party_id is not null or recipient_text is not null),
  check (source = 'history' or requester_id is not null),
  check (reimbursement = false or kind = 'request')
);
create index fin_payment_requests_status_idx on fin_payment_requests (status, created_at desc);
create index fin_payment_requests_ref_idx on fin_payment_requests (upi_ref) where upi_ref is not null;
create index fin_payment_requests_requester_idx on fin_payment_requests (requester_id, created_at desc);
-- One live record per reference, and a statement line explains at most one live record.
create unique index fin_payment_requests_ref_uniq on fin_payment_requests (upi_ref) where upi_ref is not null and status not in ('rejected', 'cancelled');
create unique index fin_payment_requests_upi_line_uniq on fin_payment_requests (upi_line_id) where upi_line_id is not null and status not in ('rejected', 'cancelled');
create unique index fin_payment_requests_bank_line_uniq on fin_payment_requests (bank_line_id) where bank_line_id is not null and status not in ('rejected', 'cancelled');

-- fin_vouchers exists since 0083 (r2_key, page_count, mime, extracted, created_by, an optional allocation). A voucher may now
-- belong to a request instead: a bill, or a screenshot of the payment. It must belong to one or the other.
alter table fin_vouchers
  add column request_id uuid references fin_payment_requests (id),
  add column kind text not null default 'bill' check (kind in ('bill', 'payment_screenshot'));
alter table fin_vouchers add constraint fin_vouchers_owner check (allocation_id is not null or request_id is not null);
create index fin_vouchers_request_idx on fin_vouchers (request_id) where request_id is not null;

alter table fin_payment_requests enable row level security;
revoke all on fin_payment_requests from anon, authenticated;
