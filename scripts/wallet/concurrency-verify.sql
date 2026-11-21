-- Every line must print t.
select 'balance = ledger' as check_name,
  (select balance_micros from wallets) = (select sum(amount_micros) from wallet_ledger) as ok
union all select 'reserved = open holds',
  (select reserved_micros from wallets) = coalesce((select sum(amount_micros) from wallet_reservations where status='HELD'),0)
union all select 'available never negative',
  (select balance_micros - reserved_micros from wallets) >= 0
union all select 'each recharge credited at most once',
  not exists (select 1 from wallet_ledger where entry_type='RECHARGE' group by reference_id having count(*) > 1)
union all select 'paid orders = recharge entries',
  (select count(*) from wallet_recharge_orders where status='PAID') = (select count(*) from wallet_ledger where entry_type='RECHARGE')
union all select 'one hold per key',
  not exists (select 1 from wallet_reservations group by idempotency_key having count(*) > 1)
union all select 'one charge per hold',
  not exists (select 1 from wallet_ledger where reservation_id is not null group by reservation_id having count(*) > 1)
union all select 'reconcile finds nothing', wallet_reconcile(null) = 0;
select count(*) filter (where status='CAPTURED') captured, count(*) filter (where status='RELEASED') released,
  count(*) filter (where status='HELD') held from wallet_reservations;
select balance_micros, reserved_micros from wallets;
