-- Every client charges Rs 0.50 at once until the wallet runs dry.
\set k random(1, 1000000000)
select (wallet_debit('30000000-0000-4000-8000-000000000001','ai',500000,'drain:' || :client_id || ':' || :k))->>'status';
