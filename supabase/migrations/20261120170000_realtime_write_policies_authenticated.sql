-- Realtime evaluates each table's RLS policies for every subscriber, including
-- browsers that join a channel before their session is set (role anon).
-- These write policies applied to every role and call has_org_role(), which anon
-- cannot execute. Once 20261120160000 published india_post_connections, a change
-- on that table failed the whole realtime poll with
-- "permission denied for function has_org_role".
--
-- Limit them to authenticated. Signed-in users get exactly the same check;
-- anon simply has no write policy instead of an error.

do $$
declare
  target record;
begin
  for target in
    select * from (values
      ('india_post_connections', 'india_post_connections_write'),
      ('print_agents', 'print_agents_write'),
      ('print_jobs', 'print_jobs_write'),
      ('support_conversations', 'support_conversations_write'),
      ('support_messages', 'support_messages_write'),
      ('support_tickets', 'support_tickets_write')
    ) as t(table_name, policy_name)
  loop
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = target.table_name
        and policyname = target.policy_name
    ) then
      execute format('alter policy %I on public.%I to authenticated', target.policy_name, target.table_name);
    end if;
  end loop;
end $$;
