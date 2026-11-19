-- Optional product box in centimetres. Copied onto new order lines.
-- Booked shipments are not rewritten. A partial box is not stored.

alter table public.products
  add column if not exists length_cm numeric(10,3),
  add column if not exists width_cm numeric(10,3),
  add column if not exists height_cm numeric(10,3);

alter table public.products
  drop constraint if exists products_box_cm_chk;

alter table public.products
  add constraint products_box_cm_chk check (
    (length_cm is null and width_cm is null and height_cm is null)
    or (
      length_cm > 0 and length_cm <= 150
      and width_cm > 0 and width_cm <= 150
      and height_cm > 0 and height_cm <= 150
    )
  );

comment on column public.products.length_cm is
  'Product box length in centimetres. Not the shipment parcel size. Copied onto new order lines.';
comment on column public.products.width_cm is
  'Product box width in centimetres. Stored only with length and height.';
comment on column public.products.height_cm is
  'Product box height in centimetres. Stored only with length and width.';
