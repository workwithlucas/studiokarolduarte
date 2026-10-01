-- Task 9 (1/3): new payment methods. Enum values live in their own migration; they are used from the next file on.
-- credit_balance = "Crédito da cliente" (paid out of the client credit, no cash).
-- adjustment = "Saldo anterior" (opening balance, no cash).
alter type pay_method add value if not exists 'credit_balance';
alter type pay_method add value if not exists 'adjustment';
