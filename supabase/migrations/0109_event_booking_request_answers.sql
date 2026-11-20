-- Answers to an event's own extra booking-form questions (content field
-- `bookingQuestions`), as a JSON object of question text -> answer. Null for
-- events that ask nothing extra. event-booking.mts only sends this column when
-- there are answers, so other events keep working until this is applied.
alter table public.event_booking_requests
  add column if not exists answers jsonb;
