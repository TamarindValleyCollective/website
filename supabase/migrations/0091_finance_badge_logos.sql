-- Finance: the logos for the source badges (public/finance-badges/). Apply AFTER the deploy that carries the files, so the
-- live ledger never points at an image that is not there yet. Paypro has no logo supplied and keeps its text badge, as does
-- the generic 'bank' badge. To swap a logo later: put the file under public/finance-badges/ and update the row.

update fin_source_badges set logo_url = '/finance-badges/axis.svg' where key = 'axis';
update fin_source_badges set logo_url = '/finance-badges/bhim.png' where key = 'bhim';
update fin_source_badges set logo_url = '/finance-badges/paytm.svg' where key = 'paytm';
update fin_source_badges set logo_url = '/finance-badges/razorpay.png' where key = 'razorpay';
