
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const router = express.Router();
const { sql, getConnection } = require("../db");

const ordersFile = path.join(__dirname, "..", "data", "orders.json");

const readOrders = () => {
  try {
    return JSON.parse(fs.readFileSync(ordersFile, "utf8"));
  } catch (e) {
    return [];
  }
};

const writeOrders = (orders) => {
  fs.mkdirSync(path.dirname(ordersFile), { recursive: true });
  fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));
};

/* ================= AUTH (Users table) ================= */

const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return `${salt}:${hash}`;
};

const verifyPassword = (pw, stored) => {
  try {
    const [salt, hash] = String(stored).split(":");
    const test = crypto.scryptSync(String(pw), salt, 64).toString("hex");
    return test === hash;
  } catch (e) {
    return false;
  }
};

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
      .input("pw", hashPassword("admin123"))
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
      .input("pw", hashPassword(password))
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
    if (!verifyPassword(password, u.Password)) {
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
    if (u.Role !== "admin" || !verifyPassword(password, u.Password)) {
      return res.status(401).json({ error: "Invalid admin credentials" });
    }
    res.json({ id: u.Id, name: u.Name, email: u.Email, role: u.Role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= CATALOGUE ================= */

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
    let request = pool.request();

    let query = `
      SELECT TOP(50)
        FTH.TagNo,
        FTH.NetWt,
        SP.SubProName,
        P.ProName,
        M.MetalName,
        TI.Value as ImageValue
      FROM POTJ2526.dbo.TagHistory FTH
      LEFT JOIN POTJMaster.dbo.SubProduct SP ON FTH.SubCode = SP.SubCode
      LEFT JOIN POTJMaster.dbo.Product P ON FTH.ProCode = P.ProCode
      LEFT JOIN POTJMaster.dbo.Metal M ON FTH.MetalCode = M.MetalCode
      LEFT JOIN POTI2526.dbo.TagImages TI ON TI.OrgRowsign = FTH.RowSign
      WHERE 1 = 1
    `;

    // Show items even without images (coins/bars/thali have no TagImages)
    if (noImg !== "1") {
      query += ` AND LEN(TI.Value) > 1`;
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

    const formatted = result.recordset.map((item) => ({
      TagNo: item.TagNo,
      SubProName: item.SubProName,
      ProName: item.ProName,
      MetalName: item.MetalName,
      NetWt: item.NetWt,
      ImageBase64: item.ImageValue
        ? item.ImageValue.toString("base64")
        : null,
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

/* ================= ORDERS ================= */

// 👉 Place order (no payment)
router.post("/orders", async (req, res) => {
  try {
    const { items, customer } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }
    const orders = readOrders();
    const order = {
      id: "ORD-" + Date.now(),
      createdAt: new Date().toISOString(),
      customer: customer || {},
      items: items.map((i) => ({
        id: i.id,
        SubProName: i.SubProName,
        TagNo: i.TagNo,
        NetWt: i.NetWt,
        metal: i.metal,
        qty: i.qty,
      })),
      totalItems: items.reduce((s, i) => s + (i.qty || 1), 0),
    };
    orders.unshift(order);
    writeOrders(orders);
    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 👉 Get all orders (admin)
router.get("/orders", async (req, res) => {
  res.json(readOrders());
});
<<<<<<< HEAD
=======

=======
const express = require("express");
const router = express.Router();
const { sql, getConnection } = require("../db");
const axios = require("axios");


// gold product ==============================================================================================

// 👉 GET ALL CATEGORY
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

// 👉 GET ALL PRODUCTS
router.get("/productGroup", async (req, res) => {
    try {
        const pool = await getConnection();

        const result = await pool.request().query(`            
              select distinct Proname from CatMaster
        `);

        res.json(result.recordset);

    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

// 👉 GET ALL PRODUCTS
router.get("/catMaster", async (req, res) => {
    try {
        const pool = await getConnection();

        const result = await pool.request().query(`         
            select * from CatMaster 
        `);

        res.json(result.recordset);

    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

// GET ALL SUB PRODUCTS

router.get("/subProducts", async (req, res) => {
  const pool = await getConnection();
  const result = await pool.request().query(`
    SELECT DISTINCT SubProName 
    FROM POTJMaster.dbo.SubProduct
    ORDER BY SubProName
  `);

  res.json(result.recordset); // IMPORTANT
});



// ==============================================================================================



// 👉 INSERT PRODUCT
router.post("/products", async (req, res) => {
    try {
        const { name, price } = req.body;

        const pool = await getConnection();
        await pool.request()
            .input("name", sql.VarChar, name)
            .input("price", sql.Decimal(10,2), price)
            .query("INSERT INTO Products(Name,Price) VALUES(@name,@price)");

        res.send("Product Added ✅");
    } catch (err) {
        res.status(500).send(err.message);
    }
});

router.get("/goldProducts/search", async (req, res) => {
  try {
    const { product, fromWt, toWt } = req.query;

    const pool = await getConnection();
    let request = pool.request();

    let query = `
      SELECT 
        FTH.TagNo,
        SP.SubProName,
        FTH.NetWt,
        TI.Value
      FROM POTJ2526.dbo.TagHistory FTH
      LEFT JOIN POTJMaster.dbo.SubProduct SP 
        ON FTH.SubCode = SP.SubCode
      LEFT JOIN POTI2526.dbo.TagImages TI 
        ON TI.OrgRowsign = FTH.RowSign
      WHERE 1=1
    `;

    if (product) {
      query += ` AND SP.SubProName = @product`;
      request.input("product", sql.VarChar, product);
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

    const formatted = result.recordset.map((item) => ({
      TagNo: item.TagNo,
      SubProName: item.SubProName,
      NetWt: item.NetWt,
      ImageBase64: item.Value
        ? item.Value.toString("base64")
        : null
    }));

    console.log("result images", formatted);

    res.json(formatted); // ✅ CORRECT

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});



module.exports = router;
>>>>>>> 59a4b859c670c2aeae60e6af5a53fdb800e398d0
