-- Finance session 08: a request loaded from the old sheet has no payment method. The sheet never recorded one, and the first
-- load filled in 'neft' for the whole tab, which is a guess shown as fact. The method is now optional for history rows only
-- (an app request or a log always has one), and the placeholder is removed. How a request was actually paid is read from the
-- payment it is matched to (a UPI row names its app; a bank line starts with NEFT, IMPS, RTGS or UPI).

alter table fin_payment_requests alter column mode drop not null;
alter table fin_payment_requests add constraint fin_payment_requests_mode_known check (mode is not null or (source = 'history' and kind = 'request'));
update fin_payment_requests set mode = null where source = 'history' and kind = 'request';
