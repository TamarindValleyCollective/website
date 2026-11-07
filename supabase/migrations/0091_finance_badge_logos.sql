-- Finance: the logos for the source badges (public/finance-badges/). Applied before the PR merged, as the repo requires
-- (the 'Migrations applied' check), so for the few minutes before the deploy carries the files the live badges fall back to
-- their label text. Paypro has no logo supplied and keeps its text badge, as does the generic 'bank' badge. To swap a logo later: put the file under public/finance-badges/ and update the row.

update fin_source_badges set logo_url = '/finance-badges/axis.svg' where key = 'axis';
update fin_source_badges set logo_url = '/finance-badges/bhim.png' where key = 'bhim';
update fin_source_badges set logo_url = '/finance-badges/paytm.svg' where key = 'paytm';
update fin_source_badges set logo_url = '/finance-badges/razorpay.png' where key = 'razorpay';
