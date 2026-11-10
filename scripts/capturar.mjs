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

// Día al que corresponde el total: la captura de las 6:00 a.m. refleja el cierre del día anterior.
const diaAnterior = f => new Date(Date.parse(f + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
const FECHA_CORTE = diaAnterior(HOY);

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

  // Ejecución de respaldo: si ya hay captura completa de hoy, no hace nada.
  if (process.env.SOLO_SI_FALTA === 'true') {
    const activas = tiendas.filter(t => t.activa !== false).length;
    const deHoy = historico.filter(f => f.fecha === HOY).length;
    if (deHoy >= activas) {
      console.log(`Ya existe la captura de hoy (${HOY}, ${deHoy} tiendas). Respaldo sin cambios.`);
      return;
    }
  }

  const filas = [];
  const errores = [];
  const usados = new Map(); // place_id -> tienda que ya lo usa

  // Primero las tiendas con placeId fijado a mano, luego las ya resueltas y al final las nuevas,
  // para que una búsqueda nueva nunca le "robe" el place_id a una tienda confirmada.
  const prioridad = t => t.placeId ? 0 : (cache[t.storeCode]?.placeId ? 1 : 2);
  const ordenadas = tiendas.filter(t => t.activa !== false).sort((a, b) => prioridad(a) - prioridad(b));

  for (const t of ordenadas) {
    try {
      let pid = t.placeId || cache[t.storeCode]?.placeId;
      // Un place_id guardado automáticamente que choca con otra tienda se descarta y se busca de nuevo.
      if (pid && !t.placeId && usados.has(pid)) {
        delete cache[t.storeCode];
        pid = null;
      }
      if (pid && usados.has(pid)) {
        errores.push(`${t.name}: comparte place_id con ${usados.get(pid)}. Fija el placeId correcto en config/tiendas.json`);
        continue;
      }
      if (!pid) {
        const p = await buscarPlaceId(t);
        if (!p) { errores.push(`${t.name}: no se encontró en Google`); continue; }
        if (usados.has(p.id)) {
          errores.push(`${t.name}: Google devolvió el local de ${usados.get(p.id)}. Fija el placeId correcto en config/tiendas.json`);
          continue;
        }
        pid = p.id;
        cache[t.storeCode] = {
          placeId: pid,
          nombreGoogle: p.displayName?.text ?? null,
          direccionGoogle: p.formattedAddress ?? null,
          resueltoEl: HOY
        };
        console.log(`NUEVO place_id ${t.name} -> ${pid} (${p.displayName?.text ?? ''})`);
      }
      usados.set(pid, t.name);
      const d = await detalle(pid);
      filas.push({
        fecha: HOY,
        fecha_corte: FECHA_CORTE,
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

  // Si se corre dos veces el mismo día, la foto de ese día se reemplaza completa.
  const final = historico
    .filter(f => f.fecha !== HOY)
    .map(f => f.fecha_corte ? f : { fecha: f.fecha, fecha_corte: diaAnterior(f.fecha), ...f })
    .concat(filas)
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.tienda.localeCompare(b.tienda));

  // JSON con una fila por línea (diffs legibles en GitHub)
  await writeFile(histFile, '[\n' + final.map(f => '  ' + JSON.stringify(f)).join(',\n') + '\n]\n');

  // CSV para Excel / Power BI
  const cols = ['fecha', 'fecha_corte', 'codigo', 'tienda', 'place_id', 'rating', 'resenas', 'estado'];
  const csv = [cols.join(',')]
    .concat(final.map(f => cols.map(c => csvCampo(f[c])).join(',')))
    .join('\n') + '\n';
  await writeFile(csvFile, csv);

  await writeFile(cacheFile, JSON.stringify(cache, null, 2) + '\n');
  await writeFile(estadoFile, JSON.stringify({
    fecha: HOY, fecha_corte: FECHA_CORTE, capturado: AHORA, tiendasOk: filas.length, errores
  }, null, 2) + '\n');

  console.log(`Listo: ${filas.length} tiendas guardadas para ${HOY}; ${errores.length} con error.`);
}

main().catch(e => { console.error(e); process.exit(1); });
