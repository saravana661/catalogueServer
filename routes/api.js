
const express = require("express");
const router = express.Router();
const { sql, getConnection } = require("../db");

// Best-effort perf indexes for the catalogue search (missing -> created once).
// Speeds up weight-range + image-join over the multi-million-row tables.
const ensureSearchIndexes = async () => {
  try {
    const pool = await getConnection();
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_TH_NetWt' AND object_id=OBJECT_ID('POTJ2526.dbo.TagHistory'))
      CREATE NONCLUSTERED INDEX IX_TH_NetWt
      ON POTJ2526.dbo.TagHistory (NetWt)
      INCLUDE (RowSign, TagNo, SubCode, ProCode, MetalCode)
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_TI_OrgRowsign' AND object_id=OBJECT_ID('POTI2526.dbo.TagImages'))
      CREATE NONCLUSTERED INDEX IX_TI_OrgRowsign
      ON POTI2526.dbo.TagImages (OrgRowsign)
    `);
    console.log("✅ Catalogue search indexes ensured");
  } catch (err) {
    console.warn("⚠️ Search index ensure skipped (continuing):", err.message);
  }
};
ensureSearchIndexes();

/* ================= AUTH (Users table) ================= */

// Passwords are stored as-is (plain text) so they can be managed directly
// in the backend table. NO hashing by design.

// Create Users table (if missing) + seed the admin account
const ensureAuth = async () => {
  const pool = await getConnection();
  await pool.request().query(`
    IF OBJECT_ID('dbo.Users') IS NULL
    CREATE TABLE dbo.Users (
      Id INT IDENTITY(1,1) PRIMARY KEY,
      Name NVARCHAR(100) NULL,
      Email NVARCHAR(100) NOT NULL UNIQUE,
      Password NVARCHAR(255) NOT NULL,
      Role NVARCHAR(20) NOT NULL DEFAULT 'customer',
      Provider NVARCHAR(20) NOT NULL DEFAULT 'manual',
      CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
    )
  `);
  // Seed default admin (email: admin, password: admin123) if not present
  const existing = await pool
    .request()
    .input("email", "admin")
    .query("SELECT Id FROM dbo.Users WHERE LOWER(Email) = LOWER(@email)");
  if (existing.recordset.length === 0) {
    await pool
      .request()
      .input("name", "Administrator")
      .input("email", "admin")
      .input("pw", "admin123")
      .input("role", "admin")
      .query(
        "INSERT INTO dbo.Users (Name, Email, Password, Role, Provider) VALUES (@name, @email, @pw, @role, 'manual')"
      );
  }
};

// 👉 Register a new customer
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password || password.length < 4) {
      return res.status(400).json({ error: "Name, valid email and password (min 4) required" });
    }
    await ensureAuth();
    const pool = await getConnection();
    const chk = await pool
      .request()
      .input("email", email)
      .query("SELECT Id FROM dbo.Users WHERE LOWER(Email) = LOWER(@email)");
    if (chk.recordset.length > 0) {
      return res.status(409).json({ error: "Email is already registered" });
    }
    await pool
      .request()
      .input("name", name)
      .input("email", email)
      .input("pw", password)
      .input("role", "customer")
      .query(
        "INSERT INTO dbo.Users (Name, Email, Password, Role, Provider) VALUES (@name, @email, @pw, @role, 'manual')"
      );
    const row = await pool
      .request()
      .input("email", email)
      .query("SELECT Id, Name, Email, Role FROM dbo.Users WHERE LOWER(Email) = LOWER(@email)");
    res.status(201).json(row.recordset[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 👉 Normal login (customer / admin)
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }
    await ensureAuth();
    const pool = await getConnection();
    const r = await pool
      .request()
      .input("email", email)
      .query("SELECT Id, Name, Email, Password, Role FROM dbo.Users WHERE LOWER(Email) = LOWER(@email)");
    if (r.recordset.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const u = r.recordset[0];
    if (String(u.Password) !== String(password)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    res.json({ id: u.Id, name: u.Name, email: u.Email, role: u.Role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 👉 Admin-only login
router.post("/adminLogin", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }
    await ensureAuth();
    const pool = await getConnection();
    const r = await pool
      .request()
      .input("email", email)
      .query("SELECT Id, Name, Email, Password, Role FROM dbo.Users WHERE LOWER(Email) = LOWER(@email)");
    if (r.recordset.length === 0) {
      return res.status(401).json({ error: "Invalid admin credentials" });
    }
    const u = r.recordset[0];
    if (u.Role !== "admin" || String(u.Password) !== String(password)) {
      return res.status(401).json({ error: "Invalid admin credentials" });
    }
    res.json({ id: u.Id, name: u.Name, email: u.Email, role: u.Role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= CATALOGUE ================= */

// ProductImages = app-controlled image registry (one row per product TagNo).
// Search maps a product to its folder image via this table (IsActive = 1).
let imageTableReady = false;
const ensureImageTable = async () => {
  if (imageTableReady) return;
  const pool = await getConnection();
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
  imageTableReady = true;
};

// Attach folder-based image URLs to result rows (by active ProductImages row)
const attachImageUrls = async (pool, rows) => {
  if (!rows || !rows.length) return rows;
  const tagNos = [...new Set(rows.map((r) => String(r.TagNo)))];
  const req = pool.request();
  const ph = tagNos.map((t, i) => {
    req.input("t" + i, sql.VarChar, t);
    return "@t" + i;
  });
  const imgs = await req.query(
    `SELECT TagNo, FileName FROM dbo.ProductImages WHERE IsActive = 1 AND TagNo IN (${ph.join(",")})`
  );
  const map = new Map(imgs.recordset.map((p) => [String(p.TagNo), p.FileName]));
  rows.forEach((r) => {
    const f = map.get(String(r.TagNo));
    r.imageUrl = f ? "/images/products/" + f : null;
  });
  return rows;
};

// 👉 GET ALL CATEGORIES (designs)
router.get("/categoryGroup", async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
      select distinct Catname from CatMaster order by Catname asc
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// 👉 Metal + Product filter data
router.get("/metalFilters", async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
      SELECT DISTINCT m.ProName, d.MetalName
      FROM POTJMaster.dbo.Product m
      INNER JOIN POTJMaster.dbo.Category c ON c.CatCode = m.CatCode
      INNER JOIN POTJMaster.dbo.Metal d ON d.MetalCode = c.MetalCode
      WHERE m.ProName IS NOT NULL AND d.MetalName IS NOT NULL
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// 👉 Search products
router.get("/goldProducts/search", async (req, res) => {
  try {
    const { product, fromWt, toWt, name, pro, nopro, tag, metal, noImg } = req.query;
    const pool = await getConnection();

    // ---------- INITIAL FETCH (no filters): mixed jewellery, weight > 0, image available ----------
    const hasNoFilters = !(product || fromWt || toWt || name || pro || nopro || tag || metal);
    if (hasNoFilters) {
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

      const mixSql = `
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
            AND EXISTS (SELECT 1 FROM dbo.ProductImages IM WHERE IM.TagNo = FTH.TagNo AND IM.IsActive = 1)
        )
        SELECT RowSign, TagNo, NetWt, SubProName, ProName, MetalName, Cat
        FROM Mixed
        WHERE (Cat='NECKLACE' AND rn <= 10)
           OR (Cat='BANGLE' AND rn <= 10)
           OR (Cat='RING' AND rn <= 9)
           OR (Cat='EARRING' AND rn <= 9)
           OR (Cat='PENDANT' AND rn <= 7)
           OR (Cat='CHAIN' AND rn <= 5)`;

      const rows = (await pool.request().query(mixSql)).recordset;

      // Phase 2: attach folder-based image URLs (no heavy base64 blob transfer)
      if (rows.length) {
        await ensureImageTable();
        await attachImageUrls(pool, rows);
      }

      res.json(
        rows.map((item) => ({
          TagNo: item.TagNo,
          SubProName: item.SubProName,
          ProName: item.ProName,
          MetalName: item.MetalName,
          NetWt: item.NetWt,
          imageUrl: item.imageUrl,
        }))
      );
      return;
    }

    // ---------- FILTERED SEARCHES (chips / keyword / weight / tag) ----------
    let request = pool.request();

    let query = `
      SELECT TOP(50)
        FTH.TagNo,
        FTH.NetWt,
        SP.SubProName,
        P.ProName,
        M.MetalName
      FROM POTJ2526.dbo.TagHistory FTH
      LEFT JOIN POTJMaster.dbo.SubProduct SP ON FTH.SubCode = SP.SubCode
      LEFT JOIN POTJMaster.dbo.Product P ON FTH.ProCode = P.ProCode
      LEFT JOIN POTJMaster.dbo.Metal M ON FTH.MetalCode = M.MetalCode
      WHERE 1 = 1
    `;

    // Default: only show items that have an active folder image (registry).
    // noImg=1 (coins/bars/thali) shows items without any image requirement.
    if (noImg !== "1") {
      query += ` AND EXISTS (SELECT 1 FROM dbo.ProductImages IM WHERE IM.TagNo = FTH.TagNo AND IM.IsActive = 1)`;
    }

    if (product) {
      query += ` AND SP.SubProName = @product`;
      request.input("product", sql.VarChar, product);
    }

    // Product name LIKE filter (earrings, rings, pendants, coins, ...)
    // `pro` accepts comma-separated values -> OR'd includes
    if (pro) {
      const incl = pro.split(",").map((s) => s.trim()).filter(Boolean);
      const parts = incl.map((_, i) => `P.ProName LIKE @pro${i}`);
      query += ` AND (${parts.join(" OR ")})`;
      incl.forEach((s, i) => request.input(`pro${i}`, sql.VarChar, `%${s}%`));
    }

    // `nopro` accepts comma-separated values -> AND NOT LIKE each
    if (nopro) {
      nopro
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((s, i) => {
          query += ` AND P.ProName NOT LIKE @nopro${i}`;
          request.input(`nopro${i}`, sql.VarChar, `%${s}%`);
        });
    }

    // Generic keyword LIKE filter
    if (name) {
      query += ` AND (SP.SubProName LIKE @name OR P.ProName LIKE @name)`;
      request.input("name", sql.VarChar, `%${name}%`);
    }

    // Metal filter (accepts MetalCode like 'G' OR MetalName like 'GOLD')
    if (metal) {
      query += ` AND (FTH.MetalCode = @metal OR M.MetalName = @metal)`;
      request.input("metal", sql.VarChar, metal);
    }

    if (tag) {
      query += ` AND FTH.TagNo LIKE @tag`;
      request.input("tag", sql.VarChar, `%${tag}%`);
    }

    if (fromWt) {
      query += ` AND FTH.NetWt >= @fromWt`;
      request.input("fromWt", sql.Decimal(18, 3), parseFloat(fromWt));
    }

    if (toWt) {
      query += ` AND FTH.NetWt <= @toWt`;
      request.input("toWt", sql.Decimal(18, 3), parseFloat(toWt));
    }

    const result = await request.query(query);

    await ensureImageTable();
    const withUrls = await attachImageUrls(pool, result.recordset);

    const formatted = withUrls.map((item) => ({
      TagNo: item.TagNo,
      SubProName: item.SubProName,
      ProName: item.ProName,
      MetalName: item.MetalName,
      NetWt: item.NetWt,
      imageUrl: item.imageUrl,
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 👉 All sub product names (dropdown)
router.get("/subProducts", async (req, res) => {
  const pool = await getConnection();
  const result = await pool.request().query(`
    SELECT DISTINCT SubProName 
    FROM POTJMaster.dbo.SubProduct
    ORDER BY SubProName
  `);
  res.json(result.recordset);
});

/* ================= ORDERS (DB tables) ================= */

// Create OrderMaster + OrderItems tables (if missing)
const ensureOrders = async () => {
  const pool = await getConnection();
  await pool.request().query(`
    IF OBJECT_ID('dbo.OrderMaster') IS NULL
    CREATE TABLE dbo.OrderMaster (
      Id INT IDENTITY(1,1) PRIMARY KEY,
      OrderNo NVARCHAR(50) NOT NULL UNIQUE,
      UserEmail NVARCHAR(100) NULL,
      CustomerName NVARCHAR(100) NULL,
      Provider NVARCHAR(20) NULL,
      Remarks NVARCHAR(1000) NULL,
      TotalItems INT NULL,
      OrderStatus NVARCHAR(30) NOT NULL DEFAULT 'Order Placed',
      CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
    )
  `);
  // Migration for existing tables (add OrderStatus if missing)
  await pool.request().query(`
    IF COL_LENGTH('dbo.OrderMaster', 'OrderStatus') IS NULL
    ALTER TABLE dbo.OrderMaster ADD OrderStatus NVARCHAR(30) NOT NULL DEFAULT 'Order Placed'
  `);
  // Preferred weight / size (optional, per order)
  await pool.request().query(`
    IF COL_LENGTH('dbo.OrderMaster', 'PreferredWt') IS NULL
    ALTER TABLE dbo.OrderMaster ADD PreferredWt NVARCHAR(50) NULL
  `);
  await pool.request().query(`
    IF COL_LENGTH('dbo.OrderMaster', 'PreferredSize') IS NULL
    ALTER TABLE dbo.OrderMaster ADD PreferredSize NVARCHAR(50) NULL
  `);
  await pool.request().query(`
    IF OBJECT_ID('dbo.OrderItems') IS NULL
    CREATE TABLE dbo.OrderItems (
      Id INT IDENTITY(1,1) PRIMARY KEY,
      OrderId INT NOT NULL,
      SubProName NVARCHAR(200) NULL,
      ProName NVARCHAR(200) NULL,
      MetalName NVARCHAR(50) NULL,
      TagNo NVARCHAR(50) NULL,
      NetWt DECIMAL(18,3) NULL,
      Qty INT NULL
    )
  `);
  // Preferred weight / size, per item (each cart product sends its own)
  await pool.request().query(`
    IF COL_LENGTH('dbo.OrderItems', 'PreferredWt') IS NULL
    ALTER TABLE dbo.OrderItems ADD PreferredWt NVARCHAR(50) NULL
  `);
  await pool.request().query(`
    IF COL_LENGTH('dbo.OrderItems', 'PreferredSize') IS NULL
    ALTER TABLE dbo.OrderItems ADD PreferredSize NVARCHAR(50) NULL
  `);
};

const groupOrders = (masters, items) =>
  masters.map((m) => ({
    id: m.OrderNo,
    orderNo: m.OrderNo,
    createdAt: m.CreatedAt,
    status: m.OrderStatus,
    customer: {
      name: m.CustomerName,
      email: m.UserEmail,
      provider: m.Provider,
    },
    remarks: m.Remarks,
    totalItems: m.TotalItems,
    items: items
      .filter((it) => it.OrderId === m.Id)
      .map((it) => ({
        SubProName: it.SubProName,
        ProName: it.ProName,
        metal: it.MetalName,
        TagNo: it.TagNo,
        NetWt: it.NetWt,
        qty: it.Qty,
        preferredWt: it.PreferredWt,
        preferredSize: it.PreferredSize,
      })),
  }));

// 👉 Place order (no payment) — stored in SQL tables
router.post("/orders", async (req, res) => {
  try {
    const { items, customer, remarks } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }
    await ensureOrders();
    const pool = await getConnection();
    const orderNo = "ORD-" + Date.now();
    const totalItems = items.reduce((s, i) => s + (i.qty || 1), 0);

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const inserted = await tx
        .request()
        .input("orderNo", orderNo)
        .input("email", customer?.email || null)
        .input("name", customer?.name || null)
        .input("provider", customer?.provider || null)
        .input("remarks", remarks || null)
        .input("total", totalItems)
        .query(`
          INSERT INTO dbo.OrderMaster
            (OrderNo, UserEmail, CustomerName, Provider, Remarks, TotalItems)
          OUTPUT INSERTED.Id
          VALUES (@orderNo, @email, @name, @provider, @remarks, @total)
        `);
      const orderId = inserted.recordset[0].Id;

      for (const it of items) {
        await tx
          .request()
          .input("orderId", orderId)
          .input("sub", it.SubProName || null)
          .input("pro", it.ProName || null)
          .input("metal", it.metal || it.MetalName || null)
          .input("tag", it.TagNo || null)
          .input("wt", it.NetWt != null ? parseFloat(it.NetWt) : null)
          .input("qty", it.qty || 1)
          .input(
            "prefWt",
            it.preferredWt != null && it.preferredWt !== ""
              ? String(it.preferredWt)
              : null
          )
          .input(
            "prefSize",
            it.preferredSize != null && it.preferredSize !== ""
              ? String(it.preferredSize)
              : null
          )
          .query(`
            INSERT INTO dbo.OrderItems
              (OrderId, SubProName, ProName, MetalName, TagNo, NetWt, Qty, PreferredWt, PreferredSize)
            VALUES (@orderId, @sub, @pro, @metal, @tag, @wt, @qty, @prefWt, @prefSize)
          `);
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    res.status(201).json({
      id: orderNo,
      orderNo,
      createdAt: new Date().toISOString(),
      totalItems,
      status: "Order Placed",
      remarks,
      customer: {
        name: customer?.name,
        email: customer?.email,
        provider: customer?.provider,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 👉 Get all orders (admin)
router.get("/orders", async (req, res) => {
  try {
    await ensureOrders();
    const pool = await getConnection();
    const masters = await pool.request().query(`
      SELECT Id, OrderNo, UserEmail, CustomerName, Provider, Remarks, TotalItems, OrderStatus, CreatedAt
      FROM dbo.OrderMaster
      ORDER BY CreatedAt DESC
    `);
    if (masters.recordset.length === 0) return res.json([]);
    const ids = masters.recordset.map((m) => m.Id).join(",");
    const items = await pool
      .request()
      .query(`SELECT OrderId, SubProName, ProName, MetalName, TagNo, NetWt, Qty, PreferredWt, PreferredSize
              FROM dbo.OrderItems WHERE OrderId IN (${ids})`);
    res.json(groupOrders(masters.recordset, items.recordset));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 👉 Get a customer's own orders (My Orders)
router.get("/myOrders", async (req, res) => {
  try {
    console.log("Im here Orders")
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email required" });
    await ensureOrders();
    const pool = await getConnection();
    const masters = await pool
      .request()
      .input("email", email)
      .query(`
        SELECT Id, OrderNo, UserEmail, CustomerName, Provider, Remarks, TotalItems, OrderStatus, CreatedAt
        FROM dbo.OrderMaster
        WHERE LOWER(UserEmail) = LOWER(@email)
        ORDER BY CreatedAt DESC
      `);
    if (masters.recordset.length === 0) return res.json([]);
    const ids = masters.recordset.map((m) => m.Id).join(",");
    const items = await pool
      .request()
      .query(`SELECT OrderId, SubProName, ProName, MetalName, TagNo, NetWt, Qty, PreferredWt, PreferredSize
              FROM dbo.OrderItems WHERE OrderId IN (${ids})`);
    res.json(groupOrders(masters.recordset, items.recordset));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 👉 Update order status (admin): Order Placed -> Work in Progress -> Shipped -> Delivered
const VALID_STATUSES = [
  "Order Placed",
  "Work in Progress",
  "Shipped",
  "Delivered",
];

router.patch("/orders/:orderNo/status", async (req, res) => {
  try {

    console.log('The function is runing')
    const { orderNo } = req.params;
    const { status } = req.body || {};
    if (!VALID_STATUSES.includes(status)) {
      return res
        .status(400)
        .json({ error: "Invalid status. Use one of: " + VALID_STATUSES.join(", ") });
    }
    await ensureOrders();
    const pool = await getConnection();
    const result = await pool
      .request()
      .input("orderNo", orderNo)
      .input("status", status)
      .query(`
        UPDATE dbo.OrderMaster SET OrderStatus = @status
        WHERE OrderNo = @orderNo
      `);
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json({ orderNo, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= ADMIN IMAGE MANAGEMENT (ProductImages) ================= */

const multer = require("multer");
const fs = require("fs");
const path = require("path");
const PRODUCT_IMG_DIR = path.join(__dirname, "..", "public", "images", "products");

const safeFileName = (tag) => String(tag || "").replace(/[^A-Za-z0-9._-]/g, "_");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(PRODUCT_IMG_DIR, { recursive: true });
    cb(null, PRODUCT_IMG_DIR);
  },
  filename: (req, file, cb) => {
    const tag = String(req.body && req.body.TagNo || "").replace(/[^A-Za-z0-9._-]/g, "_");
    cb(null, tag ? tag + ".jpg" : Date.now() + ".jpg");
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, true),
});

// 👉 List images (admin) with optional keyword filter
router.get("/admin/images", async (req, res) => {
  try {
    await ensureImageTable();
    const pool = await getConnection();
    const { q } = req.query;
    let rows;
    if (q) {
      const like = `%${String(q).replace(/%/g, "")}%`;
      rows = (
        await pool
          .request()
          .input("q", like)
          .query(`
            SELECT Id, TagNo, SubProName, ProName, MetalName, NetWt, FileName, IsActive, CreatedAt, UpdatedAt
            FROM dbo.ProductImages
            WHERE TagNo LIKE @q OR SubProName LIKE @q OR ProName LIKE @q OR MetalName LIKE @q
            ORDER BY UpdatedAt DESC
          `)
      ).recordset;
    } else {
      rows = (
        await pool.request().query(`
          SELECT Id, TagNo, SubProName, ProName, MetalName, NetWt, FileName, IsActive, CreatedAt, UpdatedAt
          FROM dbo.ProductImages
          ORDER BY UpdatedAt DESC
        `)
      ).recordset;
    }
    res.json(
      rows.map((r) => ({
        id: r.Id,
        TagNo: r.TagNo,
        SubProName: r.SubProName,
        ProName: r.ProName,
        MetalName: r.MetalName,
        NetWt: r.NetWt,
        IsActive: !!r.IsActive,
        imageUrl: r.FileName ? "/images/products/" + r.FileName : null,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 👉 Upload / associate image with TagNo (creates or updates the registry row)
router.post("/admin/images", upload.single("file"), async (req, res) => {
  try {
    await ensureImageTable();
    const { TagNo, SubProName, ProName, MetalName, NetWt } = req.body || {};
    if (!TagNo) return res.status(400).json({ error: "TagNo is required" });
    const pool = await getConnection();
    const fileName = req.file ? safeFileName(TagNo) + ".jpg" : null;

    const existing = await pool
      .request()
      .input("tag", TagNo)
      .query("SELECT Id, FileName FROM dbo.ProductImages WHERE TagNo = @tag");

    const imgUrl = fileName ? "/images/products/" + fileName : null;

    if (existing.recordset.length > 0) {
      const row = existing.recordset[0];
      // Replacing file -> remove previous file if different
      if (fileName && row.FileName && row.FileName !== fileName) {
        try { fs.unlinkSync(path.join(PRODUCT_IMG_DIR, row.FileName)); } catch (e) {}
      }
      await pool
        .request()
        .input("id", row.Id)
        .input("tag", TagNo)
        .input("sub", SubProName || null)
        .input("pro", ProName || null)
        .input("metal", MetalName || null)
        .input("wt", NetWt != null && NetWt !== "" ? parseFloat(NetWt) : null)
        .input("file", fileName || row.FileName)
        .query(`
          UPDATE dbo.ProductImages SET
            TagNo = @tag,
            SubProName = @sub,
            ProName = @pro,
            MetalName = @metal,
            NetWt = @wt,
            FileName = @file,
            UpdatedAt = GETDATE()
          WHERE Id = @id
        `);
      res.json({ id: row.Id, TagNo, imageUrl: "/images/products/" + (fileName || row.FileName) });
    } else {
      const inserted = await pool
        .request()
        .input("tag", TagNo)
        .input("sub", SubProName || null)
        .input("pro", ProName || null)
        .input("metal", MetalName || null)
        .input("wt", NetWt != null && NetWt !== "" ? parseFloat(NetWt) : null)
        .input("file", fileName)
        .query(`
          INSERT INTO dbo.ProductImages (TagNo, SubProName, ProName, MetalName, NetWt, FileName)
          OUTPUT INSERTED.Id
          VALUES (@tag, @sub, @pro, @metal, @wt, @file)
        `);
      res
        .status(201)
        .json({ id: inserted.recordset[0].Id, TagNo, imageUrl: imgUrl });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 👉 Update only metadata (no file) of an image registry row
router.put("/admin/images/:id", async (req, res) => {
  try {
    await ensureImageTable();
    const { id } = req.params;
    const { TagNo, SubProName, ProName, MetalName, NetWt } = req.body || {};
    if (!TagNo) return res.status(400).json({ error: "TagNo is required" });
    const pool = await getConnection();
    await pool
      .request()
      .input("id", id)
      .input("tag", TagNo)
      .input("sub", SubProName || null)
      .input("pro", ProName || null)
      .input("metal", MetalName || null)
      .input("wt", NetWt != null && NetWt !== "" ? parseFloat(NetWt) : null)
      .query(`
        UPDATE dbo.ProductImages SET
          TagNo = @tag,
          SubProName = @sub,
          ProName = @pro,
          MetalName = @metal,
          NetWt = @wt,
          UpdatedAt = GETDATE()
        WHERE Id = @id
      `);
    res.json({ id: Number(id), TagNo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 👉 Activate / deactivate an image (controls catalogue visibility)
router.patch("/admin/images/:id/active", async (req, res) => {
  try {
    await ensureImageTable();
    const { id } = req.params;
    const { active } = req.body || {};
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "active (boolean) is required" });
    }
    const pool = await getConnection();
    await pool
      .request()
      .input("id", id)
      .input("active", active ? 1 : 0)
      .query(
        "UPDATE dbo.ProductImages SET IsActive = @active, UpdatedAt = GETDATE() WHERE Id = @id"
      );
    res.json({ id: Number(id), active });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 👉 Delete an image (removes registry row + file)
router.delete("/admin/images/:id", async (req, res) => {
  try {
    await ensureImageTable();
    const pool = await getConnection();
    const existing = await pool
      .request()
      .input("id", req.params.id)
      .query("SELECT FileName FROM dbo.ProductImages WHERE Id = @id");
    if (existing.recordset.length === 0) {
      return res.status(404).json({ error: "Image not found" });
    }
    const file = existing.recordset[0].FileName;
    await pool
      .request()
      .input("id", req.params.id)
      .query("DELETE FROM dbo.ProductImages WHERE Id = @id");
    if (file) {
      try { fs.unlinkSync(path.join(PRODUCT_IMG_DIR, file)); } catch (e) {}
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
