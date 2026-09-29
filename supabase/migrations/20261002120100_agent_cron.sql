-- Task 4: scheduled calls to the Edge Functions (pg_cron + pg_net + Vault).
-- Everything degrades to a notice when an extension is missing, and jobs do nothing while the Vault
-- entries functions_base_url / cron_secret are absent.

do $$
begin
  begin
    create extension if not exists pg_net;
  exception when others then
    raise notice 'pg_net unavailable (%): agent cron calls disabled here.', sqlerrm;
  end;
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable (%): agent jobs not scheduled here.', sqlerrm;
  end;
end $$;

create function _vault_secret(p_name text) returns text
language plpgsql stable security definer set search_path = public
as $$
declare v text;
begin
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v using p_name;
  return v;
exception when others then
  return null;
end $$;

create function _cron_call(p_function text) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_base text := _vault_secret('functions_base_url');
  v_secret text := _vault_secret('cron_secret');
begin
  if v_base is null or v_secret is null then return; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  execute 'select net.http_post(url := $1, headers := $2, body := $3)'
    using rtrim(v_base, '/') || '/' || p_function,
          jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
          '{}'::jsonb;
end $$;

-- wa-sweep: only when a pending inbound is older than 60s or a human_until has passed.
create function _cron_wa_sweep() returns void
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from wa_conversations c
             where (c.pending_since is not null and c.last_inbound_at < now() - interval '60 seconds')
                or (c.mode = 'human' and c.human_until is not null and c.human_until < now())) then
    perform _cron_call('wa-sweep');
  end if;
end $$;

create function _cron_send_confirmations() returns void
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce((select value from studio_settings where key = 'confirmation_enabled'), 'false'::jsonb) = 'true'::jsonb then
    perform _cron_call('send-confirmations');
  end if;
end $$;

revoke execute on function _vault_secret(text), _cron_call(text), _cron_wa_sweep(), _cron_send_confirmations()
  from public, anon, authenticated;

do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron not installed: skipping schedules (wa-sweep, send-confirmations, agent_purge_old).';
    return;
  end if;
  perform cron.schedule('wa-sweep', '* * * * *', 'select public._cron_wa_sweep()');
  perform cron.schedule('send-confirmations', '*/15 * * * *', 'select public._cron_send_confirmations()');
  -- 03:30 America/Sao_Paulo = 06:30 UTC (no DST in Brazil since 2019); pg_cron runs in UTC.
  perform cron.schedule('agent-purge-old', '30 6 * * *', 'select public.agent_purge_old()');
exception when others then
  raise notice 'could not schedule agent jobs: %', sqlerrm;
end $$;
