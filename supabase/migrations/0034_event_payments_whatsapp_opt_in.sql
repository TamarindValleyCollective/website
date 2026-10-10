-- Whether the guest ticked "Send my booking updates on WhatsApp" on the booking
-- form (EventBookingForm.astro), carried through the Payment Link's
-- notes.whatsappOptIn ("yes"/"no") and recorded by razorpay-webhook.mts.
--
-- true  = explicitly opted in: WhatsApp confirmation, reminder and any refund /
--         cancellation messages are sent.
-- false = explicitly declined: no WhatsApp message of any kind (email only).
-- null  = booked before this existed, or paid through a link/page that never
--         carried the field. Refund and cancellation messages keep going out as
--         before (grandfathered); the NEW confirmation and reminder messages
--         require an explicit true.
--
-- NOT auto-applied: apply to the "TVC ERP" project before deploying the code.
alter table event_payments
  add column whatsapp_opt_in boolean;
