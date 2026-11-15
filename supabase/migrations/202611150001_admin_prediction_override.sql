-- Admin-controlled prediction overrides with server-side role enforcement and immutable audit history.
create or replace function public.admin_save_prediction(p_game_id text, p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_payload jsonb;
  v_records jsonb;
  v_old jsonb;
  v_new jsonb;
  v_now timestamptz := now();
  v_found boolean := false;
  v_item jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (select 1 from public.profiles p where p.id = v_user and p.role = 'admin') then
    raise exception 'Administrator permission required' using errcode = '42501';
  end if;

  if p_game_id is null or length(trim(p_game_id)) = 0
     or p_record is null or p_record->>'gameId' <> p_game_id then
    raise exception 'Invalid prediction payload' using errcode = '22023';
  end if;

  select d.payload into v_payload
  from public.member_datasets d
  where d.dataset_key = 'prediction-ledger'
  for update;

  if v_payload is null then
    v_payload := jsonb_build_object('records', '[]'::jsonb);
  end if;

  v_records := coalesce(v_payload->'records', '[]'::jsonb);
  for v_item in select value from jsonb_array_elements(v_records)
  loop
    if v_item->>'gameId' = p_game_id then
      v_old := v_item;
      v_found := true;
      exit;
    end if;
  end loop;

  v_new := p_record || jsonb_build_object(
    'adminOverride',
    jsonb_build_object('active', true, 'updatedAt', v_now, 'updatedBy', v_user, 'source', 'admin')
  );

  if v_found then
    v_before := jsonb_build_object(
      'homeWin', v_old->'homeWin', 'awayWin', v_old->'awayWin',
      'projectedMargin', v_old->'projectedMargin', 'projectedTotal', v_old->'projectedTotal',
      'spreadPick', v_old->'spreadPick', 'totalPick', v_old->'totalPick',
      'adminRationale', v_old->'adminRationale'
    );
    v_after := jsonb_build_object(
      'homeWin', v_new->'homeWin', 'awayWin', v_new->'awayWin',
      'projectedMargin', v_new->'projectedMargin', 'projectedTotal', v_new->'projectedTotal',
      'spreadPick', v_new->'spreadPick', 'totalPick', v_new->'totalPick',
      'adminRationale', v_new->'adminRationale'
    );
    v_new := jsonb_set(
      v_new,
      '{analysisChangeHistory}',
      coalesce(v_old->'analysisChangeHistory', '[]'::jsonb) ||
      jsonb_build_array(jsonb_build_object(
        'at', v_now,
        'changedFields', jsonb_build_array('homeWin','awayWin','projectedMargin','projectedTotal','spreadPick','totalPick','adminOverride'),
        'from', v_before,
        'to', v_after,
        'reason', '管理員手動調整分析；系統已依調整後方向重新產生選擇理由'
      )),
      true
    );
    v_records := (
      select coalesce(jsonb_agg(case when value->>'gameId' = p_game_id then v_new else value end), '[]'::jsonb)
      from jsonb_array_elements(v_records)
    );
  else
    v_new := v_new || jsonb_build_object(
      'analysisChangeHistory',
      jsonb_build_array(jsonb_build_object(
        'at', v_now,
        'changedFields', jsonb_build_array('predictionCreated','adminOverride'),
        'from', '{}'::jsonb,
        'to', jsonb_build_object('homeWin',v_new->'homeWin','awayWin',v_new->'awayWin','projectedMargin',v_new->'projectedMargin','projectedTotal',v_new->'projectedTotal','spreadPick',v_new->'spreadPick','totalPick',v_new->'totalPick','adminRationale',v_new->'adminRationale'),
        'reason', '管理員建立本場分析；系統已依設定方向自動產生選擇理由'
      ))
    );
    v_records := v_records || jsonb_build_array(v_new);
  end if;

  update public.member_datasets
  set payload = jsonb_set(v_payload, '{records}', v_records, true),
      updated_at = v_now
  where dataset_key = 'prediction-ledger';

  if not found then
    insert into public.member_datasets(dataset_key, payload, updated_at)
    values ('prediction-ledger', jsonb_set(v_payload, '{records}', v_records, true), v_now);
  end if;

  return v_new;
end;
$$;

revoke all on function public.admin_save_prediction(text, jsonb) from public, anon;
grant execute on function public.admin_save_prediction(text, jsonb) to authenticated;
