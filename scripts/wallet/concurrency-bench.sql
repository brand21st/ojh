-- One pgbench transaction: hold Rs 0.50 (keys collide across clients on
-- purpose), then capture, release or race a recharge fulfilment.
\set k random(1, 400)
\set action random(1, 10)
\set ord random(1, 20)
select coalesce((wallet_reserve('30000000-0000-4000-8000-000000000001','whatsapp',500000,'bench:' || :k))->>'reservationId', 'none') as rid \gset
select case
  when :action <= 6 and ':rid' <> 'none' then (wallet_capture(nullif(':rid','none')::uuid, 400000))->>'status'
  when :action <= 8 and ':rid' <> 'none' then (wallet_release(nullif(':rid','none')::uuid, 'bench'))->>'status'
  else (wallet_fulfill_recharge('order_' || :ord, 'pay_' || :ord, 1180, null, null))->>'status'
end;
