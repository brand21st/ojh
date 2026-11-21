-- Rs 100 to spend, plus 20 recharge orders of Rs 10 net each that every client races to fulfil.
select wallet_admin_adjust('30000000-0000-4000-8000-000000000001','MANUAL_CREDIT',100000000,
  'Concurrency test opening','10000000-0000-4000-8000-000000000001',null,'seed');
insert into wallet_recharge_orders(wallet_id,organization_id,razorpay_order_id,amount_paise,taxable_paise,tax_paise,credit_micros)
select w.id, w.organization_id, 'order_' || g, 1180, 1000, 180, 10000000
from wallets w, generate_series(1,20) g;
