export function createAdminSqlService(db) {
  function executeSql(input = {}) {
    const sql = readSql(input);
    const startedAt = performance.now();

    try {
      db.exec(sql);
      return {
        executed: true,
        elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      };
    } catch (error) {
      throw {
        status: 400,
        code: 'SQL_EXECUTION_FAILED',
        message: error?.message ?? String(error),
      };
    }
  }

  return {
    executeSql,
  };
}

function readSql(input) {
  const sql = input?.sql;
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw {
      status: 400,
      code: 'BAD_REQUEST',
      message: 'sql is required and must be a non-empty string.',
    };
  }

  return sql;
}
