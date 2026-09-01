const DEFAULT_SEED = 0xC0FFEE01;
const DEFAULT_TOTAL = 14_000;
const FJORD_TOTAL = 340;
const FJORD_UNSOLD = 170;
const OTHER_SUPPLIERS = Object.freeze([
  'Aster',
  'Boreal',
  'Cinder',
  'Dune',
  'Ember',
  'Grove',
]);

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function dateAt(start, span, offset) {
  const day = new Date(`${start}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + (offset % span));
  return day.toISOString().slice(0, 10);
}

export function generateCatalogue({ seed = DEFAULT_SEED, total = DEFAULT_TOTAL } = {}) {
  if (!Number.isInteger(seed)) {
    throw new TypeError('seed must be an integer');
  }
  if (!Number.isInteger(total) || total < 0) {
    throw new TypeError('total must be a non-negative integer');
  }

  const random = mulberry32(seed);
  const fjordCount = Math.min(FJORD_TOTAL, total);
  const unsoldCount = Math.min(FJORD_UNSOLD, fjordCount);
  const rows = [];

  for (let index = 0; index < total; index += 1) {
    const ordinal = index + 1;
    const fjord = index < fjordCount;
    const supplier = fjord
      ? 'Fjord'
      : OTHER_SUPPLIERS[Math.floor(random() * OTHER_SUPPLIERS.length)];
    const priceCents = 199 + Math.floor(random() * 99_801);
    let lastSoldAt;

    if (fjord && index < unsoldCount) {
      lastSoldAt = dateAt('2025-01-01', 516, index * 17 + Math.floor(random() * 31));
    } else if (fjord) {
      lastSoldAt = dateAt('2026-06-01', 76, index * 11 + Math.floor(random() * 13));
    } else {
      lastSoldAt = dateAt('2025-01-01', 592, index * 7 + Math.floor(random() * 29));
    }

    rows.push({
      id: `record-${String(ordinal).padStart(5, '0')}`,
      sku: `SKU-${String(ordinal).padStart(5, '0')}`,
      name: `${supplier} Item ${String(ordinal).padStart(5, '0')}`,
      supplier,
      lastSoldAt,
      priceCents,
      status: 'active',
      _version: 0,
    });
  }

  return rows;
}
