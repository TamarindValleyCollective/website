# Context

The language used in this repo. Terms are added here as they are settled; see `docs/adr/` for decisions.

## Finance

The finance module replaces the Google Sheets that run TVC's money (`docs/finance/DESIGN.md`).

**Bank line**
One row of a bank statement, imported once and never edited. A fact about what the bank did.
_Avoid_: transaction, entry (an entry is an allocation).

**Allocation**
An explanation of (part of) a bank line: who, which category, how much, which period, what for. A line's
allocations add up to its amount; a bulk salary debit has one per person. A correction or refund is a new
allocation that reverses an earlier one, never an edit.
_Avoid_: split, posting.

**Period**
The month a cost belongs to, which can differ from the date the bank moved the money (March salary paid in
April). Reports say whether they group by date (cash view) or by period (period view).
_Avoid_: month (alone), accounting date.

**Nature**
A plain-language statement of what an expense was for ("onion", "gas stove repair"), kept on each allocation
because auditors ask for it on listed payments.
_Avoid_: description, memo.

**Category**
The head an allocation is filed under. It carries the type (opex, capex, project, revenue, and so on), so the
type is never a property of a single row.
_Avoid_: account, head.

**Bucket**
Which budget a spend belongs to: Project if the allocation names a project, otherwise the type of its category
(Opex, Capex, revenue ...). Budget vs actual is reported per bucket.

**Project**
An explicit, community-approved plan with an owner (a name) and a breakdown of planned amounts, outside regular Opex
and one-off Capex. Reported on budget vs actual per project and per component.
_Avoid_: event (events are profit-and-loss only).

**Event**
A paid event tracked for profit and loss only: receipts against costs, with no approval or breakdown.

**Party**
Anyone money moves to or from: a member, vendor, employee, customer, bank, government body or director.
Its bank or UPI details are separate records that stay unverified until an approver confirms them.
_Avoid_: payee (when it could also be a payer), contact.

**Voucher**
The bill or receipt that supports a payment, scanned when the money is spent and attached to an allocation or a
payment request.
_Avoid_: invoice (a voucher may be a receipt or a photo), attachment.

**Circle**
The UPI spending circle: payments tagged "Pocket Money" in the Paytm export, capped at 15,000 rupees per
calendar month. A payment from the circle to the farm manager's own name is allowed but always flagged for review.
_Avoid_: pocket money (that is only the tag), wallet.

**Maker, checker**
The person who prepares or raises something and the person who approves it. They must be different people;
the server enforces it.

**Auditor**
A person with a read-only finance grant that has an end date. Every page they open is written to the audit log.

**Admin, staff**
"Admin" runs the internal tools under `/internal`; "staff" means the people TVC employs on the farm. Existing
code identifiers such as `StaffLayout` and `requireStaff` keep their names.
