const sql = require("mssql");
const { getConnection } = require("./db");

const run3 = async (label, sqlText, build = null) => {
  const pool = await getConnection();
  const req = pool.request();
  if (build) build(req);
  const t0 = Date.now();
  try {
    const r = await req.query(sqlText);
    console.log(`[${label}] time=${((Date.now() - t0) / 1000).toFixed(2)}s`, JSON.stringify(r.recordset));
  } catch (e) {
    console.log(`[${label}] FAILED ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
  }
};

const t3 = async () => {
  const p = await getConnection();
  const D = sql.Decimal(18, 3);

  await run3("TagHistory rows", "SELECT COUNT(*) AS c FROM POTJ2526.dbo.TagHistory");
  await run3("TagImages rows", "SELECT COUNT(*) AS c FROM POTI2526.dbo.TagImages");
  await run3("TagHistory indexes",
    "SELECT i.name, i.type_desc, STUFF((SELECT ', ' + c.name FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id ORDER BY ic.key_ordinal FOR XML PATH('')),1,2,'') AS cols FROM sys.indexes i WHERE i.object_id=OBJECT_ID('POTJ2526.dbo.TagHistory') AND i.type>0");
  await run3("TagImages indexes",
    "SELECT i.name, i.type_desc, STUFF((SELECT ', ' + c.name FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id ORDER BY ic.key_ordinal FOR XML PATH('')),1,2,'') AS cols FROM sys.indexes i WHERE i.object_id=OBJECT_ID('POTI2526.dbo.TagImages') AND i.type>0");

  const base = `
    SELECT TOP(50) FTH.TagNo, FTH.NetWt, SP.SubProName, P.ProName, M.MetalName, TI.Value
    FROM POTJ2526.dbo.TagHistory FTH
    LEFT JOIN POTJMaster.dbo.SubProduct SP ON FTH.SubCode = SP.SubCode
    LEFT JOIN POTJMaster.dbo.Product P ON FTH.ProCode = P.ProCode
    LEFT JOIN POTJMaster.dbo.Metal M ON FTH.MetalCode = M.MetalCode
    LEFT JOIN POTI2526.dbo.TagImages TI ON TI.OrgRowsign = FTH.RowSign
    WHERE 1=1 AND LEN(TI.Value) > 1`;

  await run3("baseline(noImg)", base);
  await run3("fromWt>=20", base + " AND FTH.NetWt >= @f", (r) => r.input("f", D, 20));
  await run3("range 10-30", base + " AND FTH.NetWt BETWEEN @f AND @t", (r) => { r.input("f", D, 10); r.input("t", D, 30); });
  await run3("toWt<=25", base + " AND FTH.NetWt <= @t", (r) => r.input("t", D, 25));
  await run3("name=GOLD+range", base + " AND (SP.SubProName LIKE @n OR P.ProName LIKE @n) AND FTH.NetWt BETWEEN @f AND @t", (r) => { r.input("n", sql.VarChar, "%GOLD%"); r.input("f", D, 10); r.input("t", D, 30); });
  process.exit(0);
};

t3().catch((e) => { console.log("FATAL", e); process.exit(1); });