-- AutoPack is on by default for every workspace. Merchants can still turn it off.

alter table public.automation_settings
  alter column auto_package_selection set default true;

update public.automation_settings
  set auto_package_selection = true
  where auto_package_selection is distinct from true;

comment on column public.automation_settings.auto_package_selection is
  'When true, AutoPack applies a verified past box for an exact variant + quantity match on unbooked draft shipments. Default on. Merchants can turn it off.';
