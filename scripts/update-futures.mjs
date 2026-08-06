import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const OUTPUT = resolve('data/futures.json');
const COLUMNS = ['SECID', 'SHORTNAME', 'LASTTRADEDATE', 'MINSTEP', 'STEPPRICE', 'INITIALMARGIN', 'PREVSETTLEPRICE', 'ASSETCODE'];
const ENDPOINT = 'https://iss.moex.com/iss/engines/futures/markets/forts/boards/RFUD/securities.json';
const asNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;

async function fetchPage(start, attempt = 1) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('iss.meta', 'off');
  url.searchParams.set('iss.only', 'securities,securities.cursor');
  url.searchParams.set('securities.columns', COLUMNS.join(','));
  url.searchParams.set('start', String(start));
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Aristocks futures calculator/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`MOEX returned HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise(resolvePromise => setTimeout(resolvePromise, attempt * 1_000));
    return fetchPage(start, attempt + 1);
  }
}

function rowsToObjects(block) {
  const positions = Object.fromEntries(block.columns.map((column, index) => [column, index]));
  return block.data.map(row => Object.fromEntries(COLUMNS.map(column => [column, row[positions[column]]])));
}

async function loadAllRows() {
  const rows = [];
  let start = 0;
  let pages = 0;
  for (;;) {
    if (++pages > 10) throw new Error('MOEX pagination safety limit exceeded');
    const payload = await fetchPage(start);
    if (!payload.securities?.columns || !Array.isArray(payload.securities.data)) throw new Error('MOEX response has no securities table');
    const page = rowsToObjects(payload.securities);
    rows.push(...page);
    const cursor = payload['securities.cursor'];
    if (pages === 1) console.log(`MOEX cursor: ${JSON.stringify(cursor)}`);
    const cursorRow = cursor?.data?.[0];
    const at = name => cursor?.columns?.indexOf(name) ?? -1;
    const currentIndex = cursorRow && at('INDEX') >= 0 ? asNumber(cursorRow[at('INDEX')]) : start;
    const total = cursorRow && at('TOTAL') >= 0 ? asNumber(cursorRow[at('TOTAL')]) : null;
    const pageSize = cursorRow && at('PAGESIZE') >= 0 ? asNumber(cursorRow[at('PAGESIZE')]) : page.length;
    if (!page.length || (total !== null && currentIndex + page.length >= total)) break;
    const nextStart = currentIndex + (pageSize || page.length);
    if (nextStart <= start) throw new Error('MOEX pagination did not advance');
    start = nextStart;
  }
  return rows;
}

function normalize(rows) {
  const today = new Date().toISOString().slice(0, 10);
  const unique = new Map();
  for (const row of rows) {
    const contract = {
      secid: String(row.SECID || '').trim(),
      name: String(row.SHORTNAME || row.SECID || '').trim(),
      assetCode: String(row.ASSETCODE || '').trim(),
      expiry: String(row.LASTTRADEDATE || '').slice(0, 10),
      minStep: asNumber(row.MINSTEP),
      stepPrice: asNumber(row.STEPPRICE),
      margin: asNumber(row.INITIALMARGIN),
      price: asNumber(row.PREVSETTLEPRICE),
    };
    if (!contract.secid || !contract.expiry || contract.expiry < today) continue;
    if (contract.minStep <= 0 || contract.stepPrice <= 0) continue;
    unique.set(contract.secid, contract);
  }
  return [...unique.values()].sort((a, b) => a.expiry.localeCompare(b.expiry, 'ru') || a.secid.localeCompare(b.secid, 'ru'));
}

async function previousDocument() {
  try { return JSON.parse(await readFile(OUTPUT, 'utf8')); }
  catch { return null; }
}

const contracts = normalize(await loadAllRows());
if (contracts.length < 20) throw new Error(`Refusing to replace data: only ${contracts.length} valid contracts received`);
const previous = await previousDocument();
const changed = JSON.stringify(previous?.contracts || []) !== JSON.stringify(contracts);
const previousTime = new Date(previous?.updatedAt || 0).getTime();
const heartbeatDue = !Number.isFinite(previousTime) || Date.now() - previousTime >= 20 * 60 * 60 * 1000;
if (!changed && !heartbeatDue) {
  console.log(`${contracts.length} contracts verified; file is already current.`);
  process.exit(0);
}
const document = { source: 'MOEX ISS', updatedAt: new Date().toISOString(), count: contracts.length, contracts };
await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`${contracts.length} contracts written; data ${changed ? 'changed' : 'verified'}.`);
