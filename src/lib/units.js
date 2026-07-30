const CENT_SCALE = 2;
const INT_SCALE = 4;

function decimalToScaled(value, scale) {
  if (value === null || value === undefined || value === '') {
    throw new TypeError('Decimal value is required.');
  }

  const normalized = String(value).trim().replace(/,/g, '');
  const match = normalized.match(/^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);
  if (!match) {
    throw new TypeError(`Invalid decimal value: ${value}`);
  }

  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] || '0';
  const fraction = match[3] ?? match[4] ?? '';
  const base = BigInt(10 ** scale);
  const wholePart = BigInt(whole) * base;
  const paddedFraction = (fraction + '0'.repeat(scale)).slice(0, scale);
  let scaled = wholePart + BigInt(paddedFraction || '0');

  const roundDigit = fraction[scale];
  if (roundDigit && Number(roundDigit) >= 5) {
    scaled += 1n;
  }

  return Number(scaled) * sign;
}

function scaledToDecimal(value, scale) {
  if (!Number.isFinite(value)) {
    throw new TypeError('Scaled integer value must be finite.');
  }

  return Number((value / 10 ** scale).toFixed(scale));
}

export function moneyToCents(value) {
  return decimalToScaled(value, CENT_SCALE);
}

export function centsToMoney(value) {
  return scaledToDecimal(value, CENT_SCALE);
}

export function navToInt(value) {
  return decimalToScaled(value, INT_SCALE);
}

export function intToNav(value) {
  return scaledToDecimal(value, INT_SCALE);
}

export function sharesToInt(value) {
  return decimalToScaled(value, INT_SCALE);
}

export function intToShares(value) {
  return scaledToDecimal(value, INT_SCALE);
}

export function ppmToPercent(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError('PPM value must be finite.');
  }

  return Number((value / 10000).toFixed(4));
}

export function centsToNavInt(cents, sharesInt) {
  if (!sharesInt) {
    return null;
  }

  return Math.round((cents * 1000000) / sharesInt);
}

export function sharesIntFromAmountAndNav(amountCents, navInt) {
  if (!navInt || navInt <= 0) {
    throw new RangeError('NAV must be greater than zero.');
  }

  return Math.round((amountCents * 1000000) / navInt);
}

export function amountCentsFromSharesAndNav(sharesInt, navInt) {
  if (!navInt || navInt <= 0) {
    throw new RangeError('NAV must be greater than zero.');
  }

  return Math.round((sharesInt * navInt) / 1000000);
}
