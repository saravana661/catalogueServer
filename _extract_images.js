// One-time: extract ~1000 product images from POTI2526.dbo.TagImages (VARBINARY JPEG)
// into public/images/products/<TagNo>.jpg and seed dbo.ProductImages registry.
// Safe to re-run: existing files are NOT overwritten; registry rows are merged.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { sql, getConnection } = require("./db");

const OUT_DIR = path.join(__dirname, "public", "images", "products");

// Per-category quotas (~1000 total). Picks the FIRST rows by RowSign per category.
const QUOTAS = {
  NECKLACE: 160,
  BANGLE: 160,
  RING: 150,
  EARRING: 150,
  PENDANT: 150,
  CHAIN: 120,
  OTHER: 110,
};

const safeFileName = (tag) =>
  String(tag || "").replace(/[^A-Za-z0-9._-]/g, "_");

// Normalize BLOB values: plain Buffer, tedious long-value object, or Uint8Array
const toBuffer = (v) => {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === "string") return Buffer.from(v, "latin1");
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v.type === "Buffer" && Array.isArray(v.data)) return Buffer.from(v.data);
  if (typeof v.toBuffer === "function") return Buffer.from(v.toBuffer());
  return null;
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pool = await getConnection();

  // 1) Sample TagNos per category (weight > 0, image exists)
  const catExpr = `
    CASE
      WHEN P.ProName LIKE '%NECKLACE%' OR SP.SubProName LIKE '%NECKLACE%' THEN 'NECKLACE'
      WHEN P.ProName LIKE '%BANGLE%' OR SP.SubProName LIKE '%BANGLE%' THEN 'BANGLE'
      WHEN (P.ProName LIKE '%RING%' OR SP.SubProName LIKE '%RING%')
        AND (P.ProName NOT LIKE '%EARRING%' AND (SP.SubProName IS NULL OR SP.SubProName NOT LIKE '%EARRING%')) THEN 'RING'
      WHEN P.ProName LIKE '%EARRING%' OR SP.SubProName LIKE '%EARRING%' OR SP.SubProName LIKE '%EAR RING%' THEN 'EARRING'
      WHEN P.ProName LIKE '%PENDANT%' OR SP.SubProName LIKE '%PENDANT%' THEN 'PENDANT'
      WHEN P.ProName LIKE '%CHAIN%' OR SP.SubProName LIKE '%CHAIN%' THEN 'CHAIN'
      ELSE 'OTHER'
    END`;

  const perCat = Object.entries(QUOTAS)
    .map(([cat, n]) => `(Cat='${cat}' AND rn <= ${n})`)
    .join(" OR ");

  const sampleSql = `
    WITH Mixed AS (
      SELECT
        FTH.RowSign, FTH.TagNo, FTH.NetWt,
        SP.SubProName, P.ProName, M.MetalName,
        ${catExpr} AS Cat,
        ROW_NUMBER() OVER (PARTITION BY ${catExpr} ORDER BY FTH.RowSign) AS rn
      FROM POTJ2526.dbo.TagHistory FTH
      LEFT JOIN POTJMaster.dbo.SubProduct SP ON FTH.SubCode = SP.SubCode
      LEFT JOIN POTJMaster.dbo.Product P ON FTH.ProCode = P.ProCode
      LEFT JOIN POTJMaster.dbo.Metal M ON FTH.MetalCode = M.MetalCode
      WHERE FTH.NetWt > 0
        AND EXISTS (SELECT 1 FROM POTI2526.dbo.TagImages TI WHERE TI.OrgRowsign = FTH.RowSign)
    )
    SELECT RowSign, TagNo, NetWt, SubProName, ProName, MetalName
    FROM Mixed
    WHERE ${perCat}`;

  console.log("Querying sample tags...");
  const rows = (await pool.request().query(sampleSql)).recordset;
  console.log(`Sample tags: ${rows.length}`);
  if (!rows.length) {
    console.log("Nothing to extract. Aborting.");
    return;
  }

  // 2) Fetch the actual image blobs for those row signs
  console.log("Fetching image blobs...");
  const tagNos = new Set();
  const blobRows = [];
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const req = pool.request();
    const ph = chunk.map((r, j) => {
      req.input("r" + j, sql.VarChar, String(r.RowSign));
      return "@r" + j;
    });
    const imgs = await req.query(
      `SELECT OrgRowsign, Value FROM POTI2526.dbo.TagImages WHERE OrgRowsign IN (${ph.join(",")})`
    );
    for (const im of imgs.recordset) {
      if (im.Value && im.Value.length > 10) {
        blobRows.push({ RowSign: im.OrgRowsign, Value: im.Value });
      }
    }
  }
  const blobMap = new Map();
  let lob = 0;
  for (const b of blobRows) {
    const buf = toBuffer(b.Value);
    if (!buf || buf.length < 10) continue;
    if (!Buffer.isBuffer(b.Value)) lob++;
    blobMap.set(String(b.RowSign), buf);
  }
  console.log(`Blobs fetched: ${blobMap.size} (non-Buffer normalized: ${lob})`);

  // 3) Write image files (skip existing)
  let written = 0;
  let skipped = 0;
  const toSeed = [];
  for (const r of rows) {
    const blob = blobMap.get(String(r.RowSign));
    if (!blob) continue;
    const fileName = safeFileName(r.TagNo) + ".jpg";
    const outPath = path.join(OUT_DIR, fileName);
    if (!fs.existsSync(outPath)) {
      fs.writeFileSync(outPath, blob);
      written++;
    } else {
      skipped++;
    }
    toSeed.push({ r, fileName });
  }
  console.log(`Files written: ${written}, skipped (already exist): ${skipped}`);

  // 3.5) Ensure the registry table exists
  await pool.request().query(`
    IF OBJECT_ID('dbo.ProductImages') IS NULL
    CREATE TABLE dbo.ProductImages (
      Id INT IDENTITY(1,1) PRIMARY KEY,
      TagNo NVARCHAR(50) NOT NULL UNIQUE,
      SubProName NVARCHAR(200) NULL,
      ProName NVARCHAR(200) NULL,
      MetalName NVARCHAR(50) NULL,
      NetWt DECIMAL(18,3) NULL,
      FileName NVARCHAR(200) NULL,
      IsActive BIT NOT NULL DEFAULT 1,
      CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
      UpdatedAt DATETIME NOT NULL DEFAULT GETDATE()
    )
  `);

  // 4) Seed / merge registry rows (batched MERGE)
  console.log("Seeding dbo.ProductImages...");
  let seeded = 0;
  for (let i = 0; i < toSeed.length; i += 100) {
    const chunk = toSeed.slice(i, i + 100);
    const values = chunk
      .map(
        (_, j) =>
          `(@t${j}, @s${j}, @p${j}, @m${j}, @w${j}, @f${j})`
      )
      .join(",");
    const req = pool.request();
    chunk.forEach(({ r, fileName }, j) => {
      req.input(`t${j}`, sql.NVarChar(50), String(r.TagNo));
      req.input(`s${j}`, sql.NVarChar(200), r.SubProName || null);
      req.input(`p${j}`, sql.NVarChar(200), r.ProName || null);
      req.input(`m${j}`, sql.NVarChar(50), r.MetalName || null);
      req.input(
        `w${j}`,
        sql.Decimal(18, 3),
        r.NetWt != null ? parseFloat(r.NetWt) : null
      );
      req.input(`f${j}`, sql.NVarChar(200), fileName);
    });
    await req.query(`
      MERGE dbo.ProductImages AS T
      USING (VALUES ${values}) AS S(TagNo, SubProName, ProName, MetalName, NetWt, FileName)
      ON T.TagNo = S.TagNo
      WHEN MATCHED THEN UPDATE SET
        SubProName = S.SubProName, ProName = S.ProName, MetalName = S.MetalName,
        NetWt = S.NetWt, FileName = S.FileName, UpdatedAt = GETDATE()
      WHEN NOT MATCHED THEN INSERT (TagNo, SubProName, ProName, MetalName, NetWt, FileName, IsActive)
        VALUES (S.TagNo, S.SubProName, S.ProName, S.MetalName, S.NetWt, S.FileName, 1);
    `);
    seeded += chunk.length;
  }
  console.log(`Registry seeded/merged: ${seeded}`);
  console.log("DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});