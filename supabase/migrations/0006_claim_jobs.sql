-- 0006: safe job claiming so more than one worker can run at once.
--
-- claim_webhook_jobs() atomically leases up to p_limit due jobs (same backoff as the worker:
-- attempt n waits 20s·n² after created_at) using FOR UPDATE SKIP LOCKED, so two workers never
-- get the same row. A lease (locked_until) expires on its own if a worker dies mid-job.
--
-- Security: webhook_logs stays service-role only (anon/authenticated have no grants, 0001).
-- The function is SECURITY INVOKER and executable only by service_role. RLS is unchanged.
-- Until this is applied the worker falls back to its old single-instance query.

alter table public.webhook_logs
  add column if not exists locked_until timestamptz;

create index if not exists webhook_logs_pending_idx
  on public.webhook_logs (created_at) where processed = false;

create or replace function public.claim_webhook_jobs(p_limit int, p_max_attempts int, p_lease_seconds int)
returns setof public.webhook_logs
language sql
security invoker
set search_path = public
as $$
  update public.webhook_logs w
     set locked_until = now() + make_interval(secs => p_lease_seconds)
   where w.id in (
     select id from public.webhook_logs
      where processed = false
        and attempts < p_max_attempts
        and (locked_until is null or locked_until < now())
        and now() >= created_at + make_interval(secs => 20 * attempts * attempts)
      order by created_at
      limit p_limit
      for update skip locked
   )
  returning w.*;
$$;

revoke all on function public.claim_webhook_jobs(int, int, int) from public, anon, authenticated;
grant execute on function public.claim_webhook_jobs(int, int, int) to service_role;
