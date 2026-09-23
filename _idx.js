const { getConnection } = require("./db");

const t = async () => {
  const p = await getConnection();

  const idx = async (name, sqlText) => {
    const chk = await p.request().query(`SELECT 1 AS e FROM sys.indexes WHERE name='${name}' AND object_id IN (OBJECT_ID('POTJ2526.dbo.TagHistory'), OBJECT_ID('POTI2526.dbo.TagImages'))`);
    if (chk.recordset.length) {
      console.log(`exists: ${name}`);
      return;
    }
    const t0 = Date.now();
    await p.request().query(sqlText);
    console.log(`created ${name} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  };

  await idx("IX_TH_NetWt", `
    CREATE NONCLUSTERED INDEX IX_TH_NetWt
    ON POTJ2526.dbo.TagHistory (NetWt)
    INCLUDE (RowSign, TagNo, SubCode, ProCode, MetalCode)`);

  await idx("IX_TI_OrgRowsign", `
    CREATE NONCLUSTERED INDEX IX_TI_OrgRowsign
    ON POTI2526.dbo.TagImages (OrgRowsign)`);

  process.exit(0);
};
t().catch((e) => { console.error("FATAL", e); process.exit(1); });