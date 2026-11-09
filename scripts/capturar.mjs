// Captura diaria de valoraciones Google (Perfumarte)
// Lee config/tiendas.json, consulta Google Places API (New) y agrega
// una fila por tienda y por día a historico.json / historico.csv.
// Uso: GOOGLE_PLACES_KEY=xxx OUT_DIR=data-branch node scripts/capturar.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.GOOGLE_PLACES_KEY;
const TIENDAS_FILE = process.env.TIENDAS_FILE || 'config/tiendas.json';
const OUT = process.env.OUT_DIR || 'data-branch';

if (!KEY) {
  console.error('ERROR: falta la variable GOOGLE_PLACES_KEY (secret de GitHub).');
  process.exit(1);
}

// Fecha del día en hora de Lima (YYYY-MM-DD)
const HOY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
const AHORA = new Date().toISOString();

const esperar = ms => new Promise(r => setTimeout(r, ms));

async function leerJSON(file, porDefecto) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return porDefecto; }
}

// Solo se usa la primera vez por tienda: encuentra su place_id.
async function buscarPlaceId(t) {
  const consultas = t.searchQueries?.length ? t.searchQueries : [
    `${t.name} ${t.address}`,
    `${t.address} ${t.name}`,
    `${t.name.replace('Perfumarte - ', 'Perfumarte ')} ${t.address}`
  ];
  for (const q of consultas) {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress'
      },
      body: JSON.stringify({ textQuery: q, languageCode: 'es', regionCode: 'PE', pageSize: 1 })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Text Search ${r.status}: ${j.error?.message ?? 'error'}`);
    if (j.places?.length) return j.places[0];
  }
  return null;
}

// Consulta diaria: rating y número de reseñas de un place_id.
async function detalle(placeId) {
  const r = await fetch(`https://places.googleapis.com/v1/places/${placeId}?languageCode=es`, {
    headers: {
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,businessStatus'
    }
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Place Details ${r.status}: ${j.error?.message ?? 'error'}`);
  return j;
}

const csvCampo = v => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const tiendas = await leerJSON(TIENDAS_FILE, null);
  if (!Array.isArray(tiendas)) {
    console.error(`ERROR: no se pudo leer ${TIENDAS_FILE}`);
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  const cacheFile = path.join(OUT, 'place_ids.json');
  const histFile  = path.join(OUT, 'historico.json');
  const csvFile   = path.join(OUT, 'historico.csv');
  const estadoFile = path.join(OUT, 'ultima_captura.json');

  const cache = await leerJSON(cacheFile, {});
  const historico = await leerJSON(histFile, []);

  const filas = [];
  const errores = [];

  for (const t of tiendas) {
    if (t.activa === false) continue;
    try {
      let pid = t.placeId || cache[t.storeCode]?.placeId;
      if (!pid) {
        const p = await buscarPlaceId(t);
        if (!p) { errores.push(`${t.name}: no se encontró en Google`); continue; }
        pid = p.id;
        cache[t.storeCode] = {
          placeId: pid,
          nombreGoogle: p.displayName?.text ?? null,
          direccionGoogle: p.formattedAddress ?? null,
          resueltoEl: HOY
        };
        console.log(`NUEVO place_id ${t.name} -> ${pid} (${p.displayName?.text ?? ''})`);
      }
      const d = await detalle(pid);
      filas.push({
        fecha: HOY,
        codigo: t.storeCode,
        tienda: t.name,
        place_id: pid,
        rating: d.rating ?? null,
        resenas: d.userRatingCount ?? 0,
        estado: d.businessStatus ?? null,
        capturado: AHORA
      });
      console.log(`OK  ${t.name}: ${d.rating ?? '-'} estrellas | ${d.userRatingCount ?? 0} reseñas`);
    } catch (e) {
      errores.push(`${t.name}: ${e.message}`);
    }
    await esperar(200);
  }

  for (const e of errores) console.log(`::warning::${e}`);

  if (filas.length === 0) {
    console.error('ERROR: ninguna tienda devolvió datos. Revisa la API key, la facturación y que Places API (New) esté habilitada.');
    process.exit(1);
  }

  // Si se corre dos veces el mismo día, se reemplaza la foto de ese día.
  const claves = new Set(filas.map(f => `${f.fecha}|${f.codigo}`));
  const final = historico
    .filter(f => !claves.has(`${f.fecha}|${f.codigo}`))
    .concat(filas)
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.tienda.localeCompare(b.tienda));

  // JSON con una fila por línea (diffs legibles en GitHub)
  await writeFile(histFile, '[\n' + final.map(f => '  ' + JSON.stringify(f)).join(',\n') + '\n]\n');

  // CSV para Excel / Power BI
  const cols = ['fecha', 'codigo', 'tienda', 'place_id', 'rating', 'resenas', 'estado'];
  const csv = [cols.join(',')]
    .concat(final.map(f => cols.map(c => csvCampo(f[c])).join(',')))
    .join('\n') + '\n';
  await writeFile(csvFile, csv);

  await writeFile(cacheFile, JSON.stringify(cache, null, 2) + '\n');
  await writeFile(estadoFile, JSON.stringify({
    fecha: HOY, capturado: AHORA, tiendasOk: filas.length, errores
  }, null, 2) + '\n');

  console.log(`Listo: ${filas.length} tiendas guardadas para ${HOY}; ${errores.length} con error.`);
}

main().catch(e => { console.error(e); process.exit(1); });
