-- Individual passwords, replacing the single shared one.
--
-- A shared password cannot protect the thing this game actually depends on.
-- Bets are hidden until a market locks, and that rule is enforced in SQL -- but
-- it is worthless if Chad can pick "Kevin Malina" from a dropdown, type the
-- password everyone knows, and read Kevin's picks. The identity has to be
-- something only that person knows.
--
-- Passwords are stored as scrypt hashes with a per-user salt. Never plaintext:
-- these are friends who will reuse a password from somewhere else, and a
-- fantasy football side project has no business holding that in readable form.

alter table bettors
  add column if not exists password_hash text,
  add column if not exists password_set_at timestamptz,
  add column if not exists is_commissioner boolean not null default false;

-- The commissioner can reset passwords and approve re-ups. Stored in the
-- database rather than an env var so it survives a redeploy and can be moved
-- without one.
update bettors set is_commissioner = true where slug = 'chris-nicholson';
