export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;

export function shouldPaginate(input = {}) {
  const flag = firstValue(input.paginated ?? input.pagination);
  if (flag !== undefined) {
    return flag === true || ['1', 'true', 'yes', 'on'].includes(String(flag).toLowerCase());
  }

  return ['page', 'pageSize', 'page_size', 'limit', 'offset'].some(
    (key) => firstValue(input[key]) !== undefined,
  );
}

export function normalizePagination(input = {}, options = {}) {
  const defaultPageSize = positiveInteger(options.defaultPageSize, DEFAULT_PAGE_SIZE);
  const maxPageSize = positiveInteger(options.maxPageSize, MAX_PAGE_SIZE);
  const pageSize = Math.min(
    readPositiveInteger(input, ['pageSize', 'page_size', 'limit'], defaultPageSize),
    maxPageSize,
  );
  const offset = readNonNegativeInteger(input, ['offset'], null);
  const defaultPage = offset === null ? 1 : Math.floor(offset / pageSize) + 1;
  const page = readPositiveInteger(input, ['page'], defaultPage);

  return { page, pageSize };
}

export function buildPaginationMeta({ page, pageSize, totalItems }) {
  const safePageSize = positiveInteger(pageSize, DEFAULT_PAGE_SIZE);
  const safeTotalItems = Math.max(0, Number(totalItems) || 0);
  const totalPages = Math.max(1, Math.ceil(safeTotalItems / safePageSize));
  const safePage = Math.min(Math.max(1, positiveInteger(page, 1)), totalPages);

  return {
    page: safePage,
    pageSize: safePageSize,
    totalItems: safeTotalItems,
    totalPages,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
  };
}

function readPositiveInteger(input, keys, defaultValue) {
  for (const key of keys) {
    const value = positiveInteger(firstValue(input[key]), null);
    if (value !== null) {
      return value;
    }
  }

  return defaultValue;
}

function readNonNegativeInteger(input, keys, defaultValue) {
  for (const key of keys) {
    const value = Number.parseInt(firstValue(input[key]), 10);
    if (Number.isInteger(value) && value >= 0) {
      return value;
    }
  }

  return defaultValue;
}

function positiveInteger(value, defaultValue) {
  const number = Number.parseInt(firstValue(value), 10);
  return Number.isInteger(number) && number > 0 ? number : defaultValue;
}

function firstValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value === '' || value === undefined || value === null ? undefined : value;
}
