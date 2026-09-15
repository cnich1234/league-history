-- Phone notifications.
--
-- One row per device that has said yes. The endpoint is the browser's push
-- URL and is unique per device; a person with a phone and a laptop has two
-- rows. A row is deleted the moment the push service says the subscription
-- is gone (410), so the table is a list of phones that will actually ring.
create table if not exists push_subscriptions (
  id          bigserial primary key,
  bettor      text not null references bettors(slug),
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  failed_at   timestamptz
);
create index if not exists push_subscriptions_bettor on push_subscriptions (bettor);
