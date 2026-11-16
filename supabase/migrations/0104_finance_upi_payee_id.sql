-- Finance: the payee's UPI ID on a UPI row, shown beside the name on the UPI page.
-- Paytm rows already carry it in `counterparty` (the export's "Other Transaction Details"); BHIM rows carry the payee's name
-- there, and the BHIM app masks most IDs, so the ID is kept apart rather than replacing the name. Null when not known.
alter table fin_upi_lines add column payee_upi_id text;
