-- Freedom: 通用 SQL 执行函数（供 Supabase JS 客户端经 HTTPS 调用）
-- 由后端 db.js 通过 supabase.rpc('exec_sql', { sql, params }) 调用。
-- 作用：把现有 SQLite 风格 SQL（已翻译为 Postgres 的 $1..$n 占位符）透传到 Postgres 执行，
--        绕开直连主机(db.*.supabase.co)无法公网解析的问题（走 Supabase REST/rpc 的 443 端口）。
--
-- 安全：本函数以 SECURITY DEFINER 运行（作为库 owner），可建表/读写所有表。
--       已授权 service_role 与 anon；anon 仅用于后端（密钥留在服务端，绝不下发前端）。
--       若需更严格，可改为仅 GRANT service_role，并在部署变量中改用 SUPABASE_SERVICE_ROLE_KEY。

CREATE OR REPLACE FUNCTION exec_sql(sql text, params jsonb DEFAULT '[]')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  lits text[] := '{}';
  i int;
  n int;
  v jsonb;
  converted text;
  upper_sql text;
  is_returning boolean;
  rc int;
  result jsonb;
BEGIN
  -- 去掉结尾的分号（rpc 单条调用不应带分隔符）
  sql := rtrim(sql, '; ');

  IF params IS NULL OR jsonb_typeof(params) <> 'array' THEN
    n := 0;
  ELSE
    n := jsonb_array_length(params);
  END IF;

  -- 按 JSON 原始类型构造正确的 SQL 字面量：字符串用 quote_literal 防注入，
  -- 布尔/数字不加引号，null -> NULL。这样即使参数含单引号/特殊字符也安全。
  FOR i IN 0 .. n - 1 LOOP
    v := params -> i;
    IF v IS NULL OR v::text = 'null' THEN
      lits := array_append(lits, 'NULL');
    ELSIF jsonb_typeof(v) = 'boolean' THEN
      lits := array_append(lits, CASE WHEN v::text = 'true' THEN 'true' ELSE 'false' END);
    ELSIF jsonb_typeof(v) = 'number' THEN
      lits := array_append(lits, v#>>'{}');
    ELSIF jsonb_typeof(v) = 'string' THEN
      lits := array_append(lits, quote_literal(v#>>'{}'));
    ELSE
      lits := array_append(lits, quote_literal(v::text));
    END IF;
  END LOOP;

  -- 把 $1..$n 占位符替换为对应的字面量（从大到小替换，避免 $1 误伤 $10）
  converted := sql;
  FOR i IN REVERSE coalesce(array_length(lits, 1), 0) .. 1 LOOP
    converted := regexp_replace(converted, '\$' || i, lits[i], 'g');
  END LOOP;

  upper_sql := upper(regexp_replace(sql, '\s+', ' ', 'g'));
  is_returning := upper_sql ~* '\mRETURNING\M';

  -- 返回结果集的语句（SELECT / WITH / 含 RETURNING）统一用 CTE 包裹后聚合为 jsonb 数组；
  -- 其余 DML 返回受影响的行数。
  -- 注意：INSERT...RETURNING 不能作为 FROM 子查询，必须包进 CTE（WITH _q AS (...)）才能取行。
  IF upper_sql LIKE 'SELECT %' OR upper_sql LIKE 'WITH %' OR is_returning THEN
    EXECUTE 'WITH _q AS (' || converted || ') SELECT coalesce(jsonb_agg(to_jsonb(_q)), ''[]''::jsonb) FROM _q' INTO result;
    RETURN result;
  ELSE
    EXECUTE converted;
    GET DIAGNOSTICS rc = ROW_COUNT;
    RETURN jsonb_build_object('rowCount', rc);
  END IF;
END;
$$;

-- 仅授权后端使用的 service_role / postgres / anon（anon 仅用于后端 server-side 调用，不下发前端）
REVOKE EXECUTE ON FUNCTION exec_sql(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_sql(text, jsonb) TO postgres, service_role, anon;
