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
-- 固定 search_path：SECURITY DEFINER 函数若不固定，可能被调用方改写 search_path 劫持，
-- Supabase 的安全检查（Security Advisor）也会就此告警。
SET search_path = public, pg_temp
AS $$
DECLARE
  lits text[] := '{}';
  i int;
  n int;
  v jsonb;
  converted text;
  rest text;
  m text[];
  tok text;
  pos int;
  idx int;
  upper_sql text;
  is_returning boolean;
  rc int;
  result jsonb;
BEGIN
  -- 去掉首尾空白与结尾分号（rpc 单条调用不应带分隔符；
  -- 行首空白会让 upper_sql 以空白开头，导致 LIKE 'SELECT %' 失配、落入 ELSE 返回对象而非数组）
  sql := regexp_replace(sql, '^\s+', '');
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

  -- 把 $1..$n 占位符替换为对应字面量：单趟从左到右扫描，已替换的内容【不再参与后续匹配】。
  --
  -- 【务必不要改回 replace/regexp_replace 逐参数全局替换】——那样有两个致命缺陷：
  --   1) 参数值本身可能含 "$数字" 文本，最典型的就是 bcrypt 哈希 $2b$10$xxxx。
  --      先替换 $2 把哈希写进 SQL 后，后一轮替换 $1 会命中哈希里 "$10$" 中的 $1，
  --      把 SQL 撕成 '$2b$'admin'0$xxxx'，报 syntax error at or near "admin"。
  --      （倒序替换只能解决 $1 误伤 $10 这种占位符间的前缀冲突，救不了这种情况。）
  --   2) regexp_replace 的替换串里 \1、& 有特殊含义，值含这些字符会被悄悄篡改。
  converted := '';
  rest := sql;
  LOOP
    m := regexp_match(rest, '\$([0-9]+)');
    EXIT WHEN m IS NULL;
    tok := '$' || m[1];
    -- 正则取的是最左匹配，故 strpos 定位到的就是该匹配位置
    pos := strpos(rest, tok);
    idx := m[1]::int;
    converted := converted
              || substr(rest, 1, pos - 1)
              || CASE
                   WHEN idx >= 1 AND idx <= coalesce(array_length(lits, 1), 0) THEN lits[idx]
                   ELSE tok   -- 越界的 $n 原样保留，避免把非占位符文本吃掉
                 END;
    rest := substr(rest, pos + length(tok));
  END LOOP;
  converted := converted || rest;

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

-- 【必须执行】通知 PostgREST 重新加载 schema 缓存。
-- 不执行的话，即使函数已创建，rpc 调用仍会报
--   "Could not find the function public.exec_sql(params, sql) in the schema cache"
-- （PostgREST 缓存不会立即感知新函数，自动刷新可能要等较久）。
NOTIFY pgrst, 'reload schema';

-- 自检：下面这句应返回 [{"ok":1}]，返回即表示函数已就绪。
-- SELECT exec_sql('SELECT 1 AS ok', '[]'::jsonb);
